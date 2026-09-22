/**
 * diff-review v2 host half.
 *
 * 相对 v1（cirelir/dsh-change-review）的工程化改良：
 * 1. diff 算法：jsdiff `diffArrays`（Myers O(ND)），行级比较与 merge3 共享同一 hunk 推导，
 *    与 DSH 产品内 diff（同样基于 jsdiff）行为一致；
 * 2. 持久化：原子写（临时文件 + rename）+ `dshHomePath` 定位数据目录（尊重 $DSH_HOME），
 *    兼容读取 v1 旧位置状态文件（自动迁移到新位置）；
 * 3. 子代理聚合：优先用 agents 公开 API（list + isOwnedBy 逆查 owner 链），
 *    内部 store 结构仅作兜底；
 * 4. 安全：open/reveal 校验目标路径必须落在已记录文件的 cwd 树内，编辑器 id 白名单，
 *    命令全部走 execFileSync 参数数组（无 shell 拼接）；
 * 5. 生命周期：插件卸载时关闭所有 SSE 客户端（修复 v1 泄漏）；
 * 6. turn 扫描 scanSeq 位置缓存加容错（会话日志压缩/恢复后自动重置）。
 */
import { readFile, unlink, writeFile, rename } from 'node:fs/promises'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, appendFileSync, realpathSync, statSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { diffArrays } from 'diff'

const MAX_CHARS = 120000
const MAX_OPS = 100
const MAX_LINES = 1500
const MAX_MERGE_LINES = 2000

const name = 'diff-review'
// v2: webServer is OPTIONAL so the plugin still boots (and keeps recording)
// under DSH Desktop, whose composition may not mount the web router.
// 'tools' is the base-layer tool registry used for the diff_review_revert
// undo tool (Desktop-agnostic revert via the agent channel).
const inject = ['agents', 'tools']

function cap(s) {
  if (typeof s !== 'string') s = s == null ? '' : String(s)
  return s.slice(0, MAX_CHARS)
}

function splitLines(s) {
  if (s === '') return []
  return s.split('\n')
}

// ── line diff via jsdiff diffArrays ──────────────────────────────────────
// diffArrays compares whole lines (same semantics as v1's LCS), but runs in
// O(ND) time and produces per-change blocks we can walk once into both the
// render shape ({type,a,b,text}) and the hunk shape ({a0,a1,b0,b1}).

/** Walk diffArrays changes, yielding {type, value[]} blocks in order. */
function changeBlocks(a, b) {
  return diffArrays(a, b)
}

/**
 * Render-shape line diff: [{ type: 'ctx'|'del'|'add', a, b, text }] with both-side
 * line numbers. `aStart`/`bStart` seed the first line number so a diff of a FILE
 * FRAGMENT can report the real file lines instead of numbering the fragment from 1.
 */
function diffLines(a, b, aStart = 1, bStart = 1) {
  const out = []
  const blocks = changeBlocks(a, b)
  let aNo = aStart
  let bNo = bStart
  let pending = []
  const flush = () => {
    for (const h of pending) out.push(h)
    pending = []
  }
  for (const ch of blocks) {
    if (ch.removed) {
      flush()
      for (const line of ch.value) {
        out.push({ type: 'del', a: aNo, b: null, text: line })
        aNo++
      }
    } else if (ch.added) {
      flush()
      for (const line of ch.value) {
        out.push({ type: 'add', a: null, b: bNo, text: line })
        bNo++
      }
    } else {
      for (const line of ch.value) {
        pending.push({ type: 'ctx', a: aNo, b: bNo, text: line })
        aNo++
        bNo++
      }
    }
  }
  flush()
  return out
}

/**
 * Locate a literal fragment inside a file snapshot and report its 1-based line.
 *
 * DSH's `edit` returns the WHOLE file as `before`/`after` and has no line numbers
 * of its own, so the fragment's real offset has to be recovered here. That lookup
 * is exact rather than a guess: `applyLiteralEdit` (dsh-fs-local) throws
 * FS_AMBIGUOUS_EDIT when `old_string` matches more than once and `replace_all` is
 * not set, so a successful non-replace_all edit has exactly ONE match. `count > 1`
 * therefore only happens for `replace_all: true` edits, where the reported line is
 * the FIRST occurrence.
 *
 * The match is at TEXT level, not line level. An `old_string` is frequently only
 * PART of a line (`foo` inside `  foo = 1;`), and whole-line comparison missed
 * every such edit — 21 of 723 edits in a real state file fell back to
 * fragment-relative numbering although their offset WAS recoverable. Joining the
 * fragment's lines with `\r?\n` additionally tolerates a CRLF file whose
 * `old_string` arrives with bare `\n`.
 *
 * @returns `{ line, count }` with 1-based `line`, or `null` when there is nothing
 *   to anchor on (no snapshot, empty fragment, or the fragment is not present —
 *   e.g. a `before` truncated at MAX_CHARS).
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function locateFragment(beforeText, fragmentText) {
  if (typeof beforeText !== 'string' || typeof fragmentText !== 'string' || fragmentText === '') return null
  const needle = fragmentText.replace(/\r\n?/g, '\n')
  const pattern = new RegExp(needle.split('\n').map(escapeRegExp).join('\\r?\\n'), 'g')
  let first = -1
  let count = 0
  let m
  while ((m = pattern.exec(beforeText)) !== null) {
    count++
    if (first < 0) first = m.index
  }
  if (count === 0) return null
  // The line of the first match is the number of newlines before its offset.
  let line = 1
  for (let i = 0; i < first; i++) if (beforeText.charCodeAt(i) === 10) line++
  return { line, count }
}

/**
 * Whether a stored op snapshot is only the HEAD of a bigger file, i.e. `cap` cut
 * it at MAX_CHARS. Writing such a snapshot back (revert) would silently TRUNCATE
 * the file, so those ops are refused instead of restored — and they are also the
 * ops whose real line cannot be recovered from the snapshot (hence `lineHint`,
 * recorded from the untruncated text at edit time). A legacy op stores no
 * original length, so a snapshot of exactly MAX_CHARS is treated as cut: refusing
 * a revert is the safe side of that guess.
 */
function truncatedSnapshot(op) {
  if (!op) return false
  const cut = (text, originalLen) => {
    if (typeof text !== 'string') return false
    return typeof originalLen === 'number' ? originalLen > text.length : text.length >= MAX_CHARS
  }
  return cut(op.before, op.beforeLen) || cut(op.after, op.afterLen)
}

// ── last-resort line lookup from the file on disk ────────────────────────────
// A legacy op (recorded before `lineHint` existed) whose snapshot was cut by
// MAX_CHARS has no recoverable offset left inside the record. The CURRENT file is
// then the only source — and the right one for what the gutter is for, since the
// row opens that file at that line. Read once per path (mtime/size checked,
// size-capped) and only after the snapshot lookup already failed.
const DISK_HINT_MAX_BYTES = 4000000
const DISK_HINT_CACHE_MAX = 8
const diskHintCache = new Map()

function diskText(absPath) {
  if (!absPath) return null
  let st
  try {
    st = statSync(absPath)
  } catch (e) {
    return null
  }
  if (!st.isFile() || st.size > DISK_HINT_MAX_BYTES) return null
  const hit = diskHintCache.get(absPath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
  let text
  try {
    text = readFileSync(absPath, 'utf8')
  } catch (e) {
    return null
  }
  if (diskHintCache.size >= DISK_HINT_CACHE_MAX) diskHintCache.delete(diskHintCache.keys().next().value)
  diskHintCache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, text })
  return text
}

/**
 * Hunk shape [{a0,a1,b0,b1}]: lines a[a0..a1) are replaced by b[b0..b1).
 * Consecutive del/add runs are grouped into a single hunk (same contract as v1).
 */
function diffHunks(a, b) {
  const hunks = []
  let a0 = -1
  let a1 = -1
  let b0 = -1
  let b1 = -1
  let i = 0
  let j = 0
  const close = () => {
    if (a0 >= 0) hunks.push({ a0, a1, b0, b1 })
    a0 = -1
  }
  for (const ch of changeBlocks(a, b)) {
    const n = ch.value.length
    if (ch.removed) {
      if (a0 < 0) { a0 = i; b0 = j }
      a1 = i + n
      b1 = j
      i += n
    } else if (ch.added) {
      if (a0 < 0) { a0 = i; b0 = j }
      a1 = i
      b1 = j + n
      j += n
    } else {
      close()
      i += n
      j += n
    }
  }
  close()
  return hunks
}

/**
 * 3-way line merge: start from `base`, keep `ours`' changes, apply
 * `theirs`' changes. Throws when both touch the same base lines.
 */
function merge3(base, ours, theirs) {
  const ho = diffHunks(base, ours)
  const ht = diffHunks(base, theirs)
  for (const o of ho) {
    for (const t of ht) {
      if (o.a0 < t.a1 && t.a0 < o.a1) {
        throw new Error('该项修改与之后的修改有重叠，无法单独撤回；可尝试撤回整个文件，或从最后一项开始逐项撤回')
      }
    }
  }
  const items = []
  for (const h of ho) items.push({ h, src: ours })
  for (const h of ht) items.push({ h, src: theirs })
  items.sort((x, y) => x.h.a0 - y.h.a0)
  const out = []
  let pos = 0
  for (const it of items) {
    const h = it.h
    for (let k = pos; k < h.a0; k++) out.push(base[k])
    for (let k = h.b0; k < h.b1; k++) out.push(it.src[k])
    pos = h.a1
  }
  for (let k = pos; k < base.length; k++) out.push(base[k])
  return out
}

/** Restore a file: null content deletes it (was created in-session), string rewrites it. */
async function applyRestore(absPath, content) {
  if (content === null) {
    try {
      await unlink(absPath)
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) throw e
    }
  } else {
    await writeFile(absPath, content, 'utf8')
  }
}

// ── persistence: atomic JSON state next to the profile config ─────────────
// The state file lives in the profile directory (ctx.baseUrl — the Loader's
// anchor for ~/.dsh/profiles/<profile>/), so web and desktop profiles stay
// isolated and v1 records are read seamlessly (same location, same format).
// Fallbacks only apply when no ctx is available (e.g. unit tests) — they
// never touch real user data unless the caller is a real harness process.
const STATE_FILE_NAME = 'diff-review-state.json'

function stateFilePath(ctx) {
  try {
    if (ctx && ctx.baseUrl) return fileURLToPath(new URL(STATE_FILE_NAME, ctx.baseUrl))
  } catch (e) {}
  try {
    return dshHomePath('profiles', 'web', STATE_FILE_NAME)
  } catch (e2) {}
  return join(process.cwd(), STATE_FILE_NAME)
}

function legacyStateFilePath(ctx) {
  try {
    if (ctx && ctx.baseUrl) return fileURLToPath(new URL(STATE_FILE_NAME, ctx.baseUrl))
  } catch (e) {}
  return null
}

async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  try {
    await rename(tmp, file)
  } catch (e) {
    try { await unlink(tmp) } catch (e2) {}
    throw e
  }
}

function writeJsonAtomicSync(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  try {
    renameSync(tmp, file)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch (e2) {}
    throw e
  }
}

function serializeSessions(sessions) {
  const out = { version: 1, savedAt: Date.now(), sessions: {} }
  for (const [sid, files] of sessions) {
    if (!files || files.size === 0) continue
    const fileOut = {}
    for (const [path, rec] of files) {
      if (!rec || !Array.isArray(rec.ops) || rec.ops.length === 0) continue
      fileOut[path] = { path: rec.path, cwd: rec.cwd, ops: rec.ops }
    }
    if (Object.keys(fileOut).length > 0) out.sessions[sid] = { files: fileOut }
  }
  return out
}

function loadSessions(sessions, file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    return
  }
  try {
    const data = JSON.parse(raw)
    if (!data || data.version !== 1 || !data.sessions || typeof data.sessions !== 'object') return
    for (const [sid, s] of Object.entries(data.sessions)) {
      if (!s || !s.files || typeof s.files !== 'object') continue
      const files = new Map()
      for (const [path, rec] of Object.entries(s.files)) {
        if (!rec || !Array.isArray(rec.ops)) continue
        const ops = rec.ops.filter((op) => op && (op.kind === 'edit' || op.kind === 'write'))
        if (ops.length === 0) continue
        files.set(path, { path: rec.path || path, cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined, ops })
      }
      if (files.size > 0) sessions.set(sid, files)
    }
  } catch (e) {
    // corrupt state file: ignore and start fresh
  }
}

function loadStateInto(sessions, ctx) {
  const file = stateFilePath(ctx)
  loadSessions(sessions, file)
  // Migration: v1 kept the file next to the profile config (ctx.baseUrl).
  if (sessions.size === 0) {
    const legacy = legacyStateFilePath(ctx)
    if (legacy && legacy !== file) {
      const before = sessions.size
      loadSessions(sessions, legacy)
      if (sessions.size > before) {
        // Persist to the new location so the migration is one-shot.
        mkdirSync(dirname(file), { recursive: true })
        writeJsonAtomicSync(file, serializeSessions(sessions))
      }
    }
  }
}

function persistState(sessions, file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeJsonAtomic(file, serializeSessions(sessions)).catch(() => {})
  } catch (e) {}
}

function flushStateSync(sessions, file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeJsonAtomicSync(file, serializeSessions(sessions))
  } catch (e) {}
}

// ── editor detection: cross-platform ─────────────────────────────────────
// v2 修复 v1 的 macOS 中心化问题：which/where 双兼容、Windows 常见程序路径、
// sips 图标转换仅在 darwin 使用（其他平台由客户端回退为字母图标）。

function commandExists(cmd) {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(which, [cmd], { stdio: 'ignore', timeout: 3000 })
    return true
  } catch (e) {
    return false
  }
}

function existsAny(paths) {
  return paths.some((p) => p && existsSync(p))
}

/** Windows-typical install locations for common editors. */
function winPaths() {
  const local = process.env.LOCALAPPDATA || ''
  const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files'
  const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
  return {
    // The CLI shim first: it is the editor's documented entry point and forwards
    // arguments reliably (the bare .exe is the fallback when the shim is absent).
    vscode: [local + '\\Programs\\Microsoft VS Code\\bin\\code.cmd', local + '\\Programs\\Microsoft VS Code\\Code.exe', pf + '\\Microsoft VS Code\\bin\\code.cmd'],
    vscodeinsiders: [local + '\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd', local + '\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe'],
    cursor: [local + '\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd', local + '\\Programs\\cursor\\Cursor.exe'],
    windsurf: [local + '\\Programs\\Windsurf\\bin\\windsurf.cmd', local + '\\Programs\\Windsurf\\Windsurf.exe'],
    vscodium: [local + '\\Programs\\VSCodium\\bin\\codium.cmd', local + '\\Programs\\VSCodium\\VSCodium.exe'],
    sublime: [pf + '\\Sublime Text\\subl.exe', pf + '\\Sublime Text\\sublime_text.exe'],
    notepadpp: [pfx86 + '\\Notepad++\\notepad++.exe', pf + '\\Notepad++\\notepad++.exe']
  }
}

function detectEditors() {
  const p = process.platform
  const out = []
  const win = p === 'win32' ? winPaths() : null
  const mac = p === 'darwin'
  const add = (ed) => out.push(ed)

  if (mac) {
    add({ id: 'vscode', name: 'Visual Studio Code', command: 'code', execPaths: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'], detected: commandExists('code'), openArgs: (file, line, col) => ['--goto', `${file}:${line}:${col}`] })
    add({ id: 'cursor', name: 'Cursor', command: 'cursor', execPaths: ['/Applications/Cursor.app/Contents/MacOS/Cursor'], detected: commandExists('cursor'), openArgs: (file, line, col) => ['--goto', `${file}:${line}:${col}`] })
    add({ id: 'windsurf', name: 'Windsurf', command: 'windsurf', execPaths: ['/Applications/Windsurf.app/Contents/MacOS/windsurf'], detected: commandExists('windsurf'), openArgs: (file, line, col) => [file] })
    add({ id: 'zed', name: 'Zed', command: 'zed', execPaths: ['/Applications/Zed.app/Contents/MacOS/zed'], detected: commandExists('zed'), openArgs: (file, line, col) => [`${file}:${line}:${col}`] })
    add({ id: 'sublime', name: 'Sublime Text', command: 'subl', execPaths: ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'], detected: commandExists('subl'), openArgs: (file, line, col) => [`${file}:${line}:${col}`] })
    add({ id: 'xcode', name: 'Xcode', command: 'xed', execPaths: ['/Applications/Xcode.app/Contents/Developer/usr/bin/xed'], detected: commandExists('xed'), openArgs: (file, line, col) => ['--line', String(line), file] })
    add({ id: 'textedit', name: 'TextEdit', command: 'open', detected: true, appPaths: ['/System/Applications/TextEdit.app'], openArgs: (file, line, col) => ['-a', 'TextEdit', file] })
    for (const [id, edName, dir, bin] of [
      ['idea', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA.app', 'idea'],
      ['pycharm', 'PyCharm Professional', 'PyCharm.app', 'pycharm'],
      ['webstorm', 'WebStorm', 'WebStorm.app', 'webstorm']
    ]) {
      add({ id, name: edName, command: bin, execPaths: [`/Applications/${dir}/Contents/MacOS/${bin}`], detected: commandExists(bin) || existsAny([`/Applications/${dir}/Contents/MacOS/${bin}`]), openArgs: (file, line, col) => ['--line', String(line), file] })
    }
    add({ id: 'vim', name: 'Vim', command: 'vim', detected: commandExists('vim'), openArgs: (file, line, col) => [file] })
    add({ id: 'nvim', name: 'Neovim', command: 'nvim', detected: commandExists('nvim'), openArgs: (file, line, col) => [file] })
  } else if (win) {
    add({ id: 'vscode', name: 'Visual Studio Code', command: 'code', execPaths: win.vscode, detected: commandExists('code') || existsAny(win.vscode), openArgs: (file, line, col) => ['--goto', `${file}:${line}:${col}`] })
    add({ id: 'vscodeinsiders', name: 'Visual Studio Code Insiders', command: 'code-insiders', execPaths: win.vscodeinsiders, detected: commandExists('code-insiders') || existsAny(win.vscodeinsiders), openArgs: (file, line, col) => ['--goto', `${file}:${line}:${col}`] })
    add({ id: 'cursor', name: 'Cursor', command: 'cursor', execPaths: win.cursor, detected: commandExists('cursor') || existsAny(win.cursor), openArgs: (file, line, col) => ['--goto', `${file}:${line}:${col}`] })
    add({ id: 'windsurf', name: 'Windsurf', command: 'windsurf', execPaths: win.windsurf, detected: commandExists('windsurf') || existsAny(win.windsurf), openArgs: (file, line, col) => ['--goto', `${file}:${line}:${col}`] })
    add({ id: 'vscodium', name: 'VSCodium', command: 'codium', execPaths: win.vscodium, detected: commandExists('codium') || existsAny(win.vscodium), openArgs: (file, line, col) => ['--goto', `${file}:${line}:${col}`] })
    add({ id: 'sublime', name: 'Sublime Text', command: 'subl', execPaths: win.sublime, detected: commandExists('subl') || existsAny(win.sublime), openArgs: (file, line, col) => [`${file}:${line}:${col}`] })
    add({ id: 'notepadpp', name: 'Notepad++', command: 'notepad++', execPaths: win.notepadpp, detected: existsAny(win.notepadpp), openArgs: (file, line, col) => [file] })
    // JetBrains IDEs are usually installed through Toolbox, which puts a `.cmd`
    // shim on PATH (idea.cmd / pycharm64.exe …) rather than a fixed directory, so
    // these are probed by command name only — same rule the other editors use.
    for (const [id, edName, cmds] of [
      ['idea', 'IntelliJ IDEA', ['idea64', 'idea']],
      ['pycharm', 'PyCharm', ['pycharm64', 'pycharm']],
      ['webstorm', 'WebStorm', ['webstorm64', 'webstorm']]
    ]) {
      const hit = cmds.find((c) => commandExists(c))
      add({ id, name: edName, command: hit || cmds[0], detected: hit !== undefined, openArgs: (file, line, col) => ['--line', String(line), file] })
    }
  } else {
    for (const [id, edName, cmd, argsOf] of [
      ['vscode', 'Visual Studio Code', 'code', (f, l, c) => ['--goto', `${f}:${l}:${c}`]],
      ['cursor', 'Cursor', 'cursor', (f, l, c) => ['--goto', `${f}:${l}:${c}`]],
      ['zed', 'Zed', 'zed', (f, l, c) => [f]],
      ['sublime', 'Sublime Text', 'subl', (f, l, c) => [f]],
      ['vim', 'Vim', 'vim', (f, l, c) => [f]],
      ['nvim', 'Neovim', 'nvim', (f, l, c) => [f]]
    ]) {
      add({ id, name: edName, command: cmd, detected: commandExists(cmd), openArgs: argsOf })
    }
  }
  return out
}

// v2: a path is safe to open/reveal only when it resolves inside the cwd of
// a recorded file. This keeps the exec-facing routes from accepting arbitrary
// browser-supplied paths.
function isSafeRecordedPath(sessions, inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) return false
  const abs = resolvePath(inputPath)
  for (const files of sessions.values()) {
    for (const rec of files.values()) {
      const anchors = []
      if (rec.cwd) {
        try { anchors.push(resolvePath(rec.cwd)) } catch (e) {}
      }
      try { anchors.push(dirname(resolvePath(rec.path))) } catch (e) {}
      for (const anchor of anchors) {
        const relToAnchor = relative(anchor, abs)
        const within = relToAnchor !== '' && !relToAnchor.startsWith('..') && !relToAnchor.startsWith('.' + sep)
        if (within) return true
      }
    }
  }
  return false
}

// Latest-activity window: newest labeled turn plus the unlabeled ops
// (turn 0/undefined — an in-flight turn whose turn/start has not landed,
// or ops written after a turn/end) newer than that turn's last op. Older
// unlabeled ops are a cut window of an earlier turn — dropped. Pure and
// exported so the client's pill/review window semantics are smoke-tested.
function latestWindowOf(files) {
  let latestTurn = 0
  for (const rec of files.values()) for (const op of rec.ops) {
    if (typeof op.turn === 'number' && op.turn > latestTurn) latestTurn = op.turn
  }
  let latestTaggedAt = 0
  for (const rec of files.values()) for (const op of rec.ops) {
    if (op.turn === latestTurn && (op.at || 0) > latestTaggedAt) latestTaggedAt = op.at || 0
  }
  return { latestTurn, latestTaggedAt }
}
function opInLatestWindow(op, latestTurn, latestTaggedAt) {
  if (op.turn === latestTurn) return true
  if (op.turn === 0 || op.turn === undefined) return (op.at || 0) > latestTaggedAt
  return false
}

// Resolve the thing to launch: an explicit existing path wins (usually the real
// .exe), otherwise fall back to PATH. On Windows `where` is what finds the `.cmd`
// shim editors install — a bare `code`/`subl` cannot be exec'd directly.
function resolveEditorBin(ed) {
  if (Array.isArray(ed.execPaths)) {
    const p = ed.execPaths.find((x) => x && existsSync(x))
    if (p) return p
  }
  if (process.platform === 'win32' && typeof ed.command === 'string' && ed.command && !/[\\/]/.test(ed.command)) {
    try {
      const out = execFileSync('where', [ed.command], { encoding: 'utf8', timeout: 5000 })
      const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
      if (first) return first
    } catch (e) {}
  }
  return ed.command
}

// Windows ships most editors as a `.cmd`/`.bat` shim, and execFileSync refuses to
// execute those (ENOENT) — a shim has to go through cmd.exe. The payload is wrapped
// in an extra pair of quotes for the documented `/s /c` form and passed verbatim,
// so cmd.exe — not Node — owns the argument quoting (paths with spaces survive).
//
// Never WAIT for the editor: an editor like VS Code does not exit after handing the
// file to its window, so execFileSync blocked the host for the whole timeout and then
// reported ETIMEDOUT for an editor that had actually opened — the log was full of
// `spawnSync … ETIMEDOUT` while the click looked dead. The launch resolves on the
// `spawn` event (plus a brief exit-code watch), and the editor lives on its own.
// (Deliberately NOT `detached` — see the note inside.)
function launchEditor(bin, args, note) {
  const say = typeof note === 'function' ? note : () => {}
  return new Promise((resolve, reject) => {
    let child
    try {
      // NOT detached, on purpose. On Windows `detached` gives the child its own
      // console, and a console program (cmd.exe, which every .cmd shim needs) then
      // pops a black window on every open — the stray console that kept appearing.
      // Without it the child inherits the host's console (or gets none at all thanks
      // to windowsHide), while "don't wait for the editor" is still guaranteed by the
      // spawn/exit watch below rather than by detaching.
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(bin))) {
        const q = (s) => '"' + String(s).replace(/"/g, '""') + '"'
        const inner = [q(bin), ...args.map(q)].join(' ')
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + inner + '"'], {
          stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true
        })
      } else {
        child = spawn(bin, args, { stdio: 'ignore', windowsHide: true })
      }
    } catch (e) {
      reject(e)
      return
    }
    let settled = false
    const settle = (err) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    child.once('error', settle)
    child.once('spawn', () => {
      say('editor spawned pid=' + child.pid + ' bin=' + bin)
      // "The process spawned" is NOT "the editor took the file": an editor that
      // rejects its arguments dies at once. Watch briefly so a non-zero exit is
      // reported instead of looking like a successful open. (A live editor keeps
      // running; an already-open instance may exit 0 after handing the file over.)
      const started = Date.now()
      const timer = setTimeout(() => settle(null), 900)
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        say('editor exited code=' + code + ' signal=' + signal + ' after ' + (Date.now() - started) + 'ms')
        if (code === 0) settle(null)
        else settle(new Error('编辑器进程退出，code=' + code + (signal ? ' signal=' + signal : '')))
      })
    })
    child.unref()
  })
}

function apply(ctx) {
  // v3: data plane runs over the official `connection` RPC channel (Web + Desktop
  // both go through the same transport — no self-built HTTP routes / SSE anymore).
  const connection = ctx.get('connection')
  const logger = ctx.get && typeof ctx.get === 'function' ? ctx.get('logger') : undefined
  const diagFile = (() => {
    try {
      const dir = dirname(stateFilePath(ctx))
      mkdirSync(dir, { recursive: true })
      return join(dir, 'diff-review-debug.log')
    } catch (e) { return null }
  })()
  const diag = (msg) => {
    try {
      if (diagFile) appendFileSync(diagFile, new Date().toISOString() + ' ' + msg + '\n')
    } catch (e) {}
    try {
      const l = logger && logger.info
      if (typeof l === 'function') l.call(logger, '[diff-review] ' + msg)
      else console.log('[diff-review] ' + msg)
    } catch (e) {}
  }
  try {
    diag('apply start; connection=' + (connection ? 'yes' : 'no') + '; agents=' + (ctx.agents ? 'yes' : 'no'))
    const probes = ['webServer', 'connection', 'apiProxy', 'webRuntime', 'loader', 'agents', 'sessions', 'storage', 'directoryPicker', 'pluginInventory']
    diag('probe: ' + probes.map((n) => n + '=' + (ctx.get && ctx.get(n) ? 'y' : 'n')).join(' '))
    diag('NEWPROBE tools=' + (ctx.get && ctx.get('tools') ? 'y' : 'n') + ' fsTool=' + (ctx.get && (ctx.get('dsh-tool-fs') || ctx.get('agent-tools')) ? 'y' : 'n') + ' allKeys=' + ((typeof ctx.getAll === 'function' ? ctx.getAll() : []) || []).length)
  } catch (e) {}
  // agent/session id -> path -> { path, cwd, ops }
  const sessions = new Map()
  const stateFile = stateFilePath(ctx)
  loadStateInto(sessions, ctx)
  let saveTimer = null
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      persistState(sessions, stateFile)
    }, 800)
  }
  ctx.effect(() => () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    flushStateSync(sessions, stateFile)
  }, 'diff-review: persist flush')

  // session id -> { turn, scanSeq }; ops are tagged with the ROOT session's
  // current turn so the client can show per-turn reviews. The turn is derived
  // by scanning the session log tail (position-cached), which is self-consistent
  // and covers resumed sessions whose restored turn/start events never dispatch.
  const turnCursor = new Map()
  // DSH renamed the in-memory event surface: the live `session.events` array
  // became `session.snapshotEvents()`. `currentTurnOf` read only the old
  // shape, its try/catch swallowed the miss, and every op since then was
  // tagged turn 0. Support both surfaces — snapshot first, array fallback.
  function eventsOf(session) {
    if (!session) return null
    try {
      if (typeof session.snapshotEvents === 'function') {
        const snap = session.snapshotEvents()
        if (snap && Array.isArray(snap)) return snap
      }
    } catch (e) {}
    return Array.isArray(session.events) ? session.events : null
  }
  function currentTurnOf(rootId) {
    let cur = turnCursor.get(rootId)
    if (!cur) {
      cur = { turn: null, scanSeq: 0 }
      turnCursor.set(rootId, cur)
    }
    try {
      const entry = ctx.agents && ctx.agents.store && ctx.agents.store.get(rootId)
      const session = entry && entry.agent && entry.agent.session
      const events = eventsOf(session)
      if (events && Array.isArray(events)) {
        // v2: the log can shrink (compaction/recovery); reset the cursor instead
        // of scanning a stale window.
        if (cur.scanSeq > events.length) cur.scanSeq = 0
        if (events.length > cur.scanSeq) {
          const from = cur.scanSeq
          cur.scanSeq = events.length
          for (let i = events.length - 1; i >= from; i--) {
            const e = events[i]
            if (e.type === 'turn/start') { cur.turn = e.data && e.data.turn; break }
            if (e.type === 'turn/end') { cur.turn = null; break }
          }
        }
      }
    } catch (e) {}
    return cur.turn === null ? 0 : cur.turn
  }

  function filesOf(agentId) {
    let files = sessions.get(agentId)
    if (!files) { files = new Map(); sessions.set(agentId, files) }
    return files
  }

  // The bucket a query is served from. The resolved ROOT bucket wins whenever it
  // exists — subagent ops are folded there — and the exact key is only the
  // fallback. Legacy state files still carry pre-v5 buckets under a bare child
  // uuid, and serving those from the child's own review view would show stale
  // partial data while the parent view shows the aggregate.
  function bucketOf(session, liveAgent) {
    if (!session) return undefined
    const direct = sessions.get(session)
    const rootId = resolveRootId(session, liveAgent)
    if (rootId === session) return direct
    return sessions.get(rootId) || direct
  }

  // child session id -> resolved root session id, learned from the chains the
  // walk below proves (bounded; ids are unique and a chain never changes).
  const rootCache = new Map()
  const ROOT_CACHE_MAX = 4096

  // Walk the live owner chain up to the root session so subagent changes
  // aggregate into the top-level parent session the user views. v2 prefers the
  // public API (list + isOwnedBy), falling back to the store internals only
  // when no live owner is found (e.g. the entry is absent from list()).
  //
  // v5: both of those describe RUNTIME ownership, which only exists while the
  // factory-created child AND its parent Agent are still live in the registry
  // (dsh-agent isOwnedBy compares the child entry's owner to a live Agent
  // object). A subagent's write/edit is reported through tools/result after
  // that chain can already be gone — one-shot children finish, the parent is
  // not always the live owner — and the op then lands under the bare child
  // session id, where the review view (which queries the parent session id)
  // never looks. The durable subagent lineage is the last resort: a subagent
  // child's session header persists its direct parent id (`parentSession`) plus
  // `origin: 'subagent'` (dsh-subagent childSessionMeta), and the Agent in hand
  // always carries its own session header. Only `origin: 'subagent'` children
  // are folded: a user fork records `parentSession` too but owns its own bucket.
  function resolveRootId(agentId, liveAgent) {
    const svc = ctx.agents && ctx.agents.get ? ctx.agents : null
    if (!svc) return agentId
    const cached = rootCache.get(agentId)
    if (cached !== undefined) return cached
    let current = agentId
    let agentInHand = liveAgent && liveAgent.id === agentId ? liveAgent : null
    const seen = new Set()
    for (let i = 0; i < 32; i++) {
      if (seen.has(current)) break
      seen.add(current)
      let ownerId = null
      try {
        for (const agent of svc.list()) {
          const aid = agent && (agent.id || (agent.session && agent.session.id))
          if (aid && aid !== current && svc.isOwnedBy(current, agent)) {
            ownerId = aid
            break
          }
        }
      } catch (e) {}
      if (!ownerId) {
        try {
          const entry = svc.store && svc.store.get(current)
          ownerId = entry && entry.owner && entry.owner.id ? entry.owner.id : null
        } catch (e) {}
      }
      if (!ownerId) {
        try {
          const live = agentInHand || (typeof svc.get === 'function' ? svc.get(current) : null)
          const header = live && live.session && live.session.header
          const parentSession = header && header.parentSession
          if (header && header.origin === 'subagent' && typeof parentSession === 'string' && parentSession && parentSession !== current) {
            ownerId = parentSession
          }
        } catch (e) {}
      }
      if (!ownerId) break
      current = ownerId
      agentInHand = null
    }
    // Remember every id on the walked chain. A finished subagent is gone from
    // the registry, and its own review tab still queries with its own session
    // id — the learned chain is what keeps that view on the same root bucket
    // instead of collapsing to an empty one.
    if (seen.size > 1) {
      for (const id of seen) {
        if (id === current) continue
        if (rootCache.size >= ROOT_CACHE_MAX) {
          const oldest = rootCache.keys().next().value
          rootCache.delete(oldest)
        }
        rootCache.set(id, current)
      }
    }
    return current
  }

  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec) return
      const toolName = exec.tool || exec.name
      if (toolName !== 'write' && toolName !== 'edit') return
      const input = exec.input || exec.arguments || exec.args
      if (!input || typeof input !== 'object') return
      const file = input.file_path || input.file || input.path
      if (!file) return
      const agentId = exec.agent && exec.agent.id
      if (!agentId) return
      const failed = result && (result.isError || result.error || result.ok === false || result.failed)
      if (failed) return
      const rootId = resolveRootId(agentId, exec.agent)
      const at = Date.now()
      const turn = currentTurnOf(rootId)
      const files = filesOf(rootId)
      let rec = files.get(file)
      if (!rec) {
        const cwd = exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
        rec = { path: file, cwd, ops: [] }
        files.set(file, rec)
      }
      if (rec.ops.length >= MAX_OPS) rec.ops.shift()
      const value = result && !result.isError && result.value && typeof result.value === 'object' ? result.value : null
      const hasBefore = value !== null && 'before' in value
      const hasAfter = value !== null && 'after' in value
      const rawBefore = hasBefore && typeof value.before === 'string' ? value.before : null
      const rawAfter = hasAfter && typeof value.after === 'string' ? value.after : null
      const before = hasBefore ? (value.before === null ? null : cap(value.before)) : undefined
      const after = hasAfter ? cap(value.after) : undefined
      // Only a snapshot that WAS cut by the cap is worth recording a length for:
      // it is both the "the real line cannot be recovered later" case and the
      // "reverting from it would truncate the file" case.
      const beforeLen = rawBefore !== null && typeof before === 'string' && rawBefore.length > before.length ? rawBefore.length : undefined
      const afterLen = rawAfter !== null && typeof after === 'string' && rawAfter.length > after.length ? rawAfter.length : undefined
      if (toolName === 'edit') {
        // replaceAll is what makes an edit's old_string non-unique, so it decides
        // whether a recovered line offset is the only site or just the first one.
        //
        // The offset is recovered HERE, from the UNTRUNCATED snapshot: storage caps
        // a huge file at MAX_CHARS, so a fragment past that cap can never be
        // located afterwards and the section would fall back to fragment-relative
        // numbering (3 of 727 edits in one real state file — a 200 KB Unity prefab).
        const lineHint = locateFragment(rawBefore, typeof input.old_string === 'string' ? input.old_string : '')
        const op = {
          kind: 'edit', at, turn, before, after,
          oldString: cap(input.old_string), newString: cap(input.new_string),
          replaceAll: input.replace_all === true
        }
        if (lineHint) op.lineHint = lineHint
        if (beforeLen !== undefined) op.beforeLen = beforeLen
        if (afterLen !== undefined) op.afterLen = afterLen
        rec.ops.push(op)
      } else {
        const op = { kind: 'write', at, turn, before, after, content: cap(input.content) }
        if (beforeLen !== undefined) op.beforeLen = beforeLen
        if (afterLen !== undefined) op.afterLen = afterLen
        rec.ops.push(op)
      }
      scheduleSave()
    } catch (e) {
      console.error('diff-review track failed', e)
    }
  })

  function buildSummary(files) {
    const items = []
    for (const rec of files.values()) {
      let added = 0
      let removed = 0
      let writes = 0
      let edits = 0
      for (const op of rec.ops) {
        if (op.kind === 'edit') {
          edits++
          added += splitLines(op.newString).length
          removed += splitLines(op.oldString).length
        } else {
          writes++
          added += splitLines(op.content).length
        }
      }
      const last = rec.ops[rec.ops.length - 1]
      items.push({
        path: rec.path,
        name: String(rec.path).split('/').pop(),
        cwd: rec.cwd,
        ops: rec.ops.length,
        writes,
        edits,
        added,
        removed,
        lastTime: last ? last.at : 0
      })
    }
    items.sort((x, y) => y.lastTime - x.lastTime)
    let latestTurn = 0
    for (const rec of files.values()) {
      for (const op of rec.ops) {
        if (typeof op.turn === 'number' && op.turn > latestTurn) latestTurn = op.turn
      }
    }
    return { files: items, latestTurn }
  }

  // Build one section per op; 'indices' selects which ops (opIndex is the index
  // into the FULL ops array so /diff-review/revert stays valid).
  //
  // Line numbers: `edit` carries only fragments (old_string/new_string), so the
  // fragment's offset is recovered from the recorded `before` snapshot
  // (locateFragment) — or from the `lineHint` recorded when the edit happened,
  // which survives the storage cap that can cut a huge snapshot. When it can be
  // recovered the gutter shows REAL file lines; otherwise the numbering is the
  // fragment-relative 1..N and the section is flagged `lineExact: false` so the
  // UI can mark it instead of passing it off as absolute. `write` needs no
  // recovery: its content IS the whole file, so 1..N already are the real lines.
  function buildSections(ops, indices, absPath) {
    const sections = []
    for (const i of indices) {
      const op = ops[i]
      let section
      if (op.kind === 'edit') {
        let oldL = splitLines(op.oldString)
        let newL = splitLines(op.newString)
        let truncated = false
        if (oldL.length > MAX_LINES || newL.length > MAX_LINES) {
          truncated = true
          oldL = oldL.slice(0, MAX_LINES)
          newL = newL.slice(0, MAX_LINES)
        }
        // Three sources, best first: the offset recovered when the edit happened
        // (`lineHint`, survives the storage cap), the stored snapshot, and — for a
        // legacy op whose snapshot was cut — the file as it is on disk right now.
        let located = null
        let lineSource = null
        if (op.lineHint && op.lineHint.line > 0) {
          located = op.lineHint
          lineSource = 'hint'
        } else {
          located = locateFragment(op.before, typeof op.oldString === 'string' ? op.oldString : '')
          if (located) lineSource = 'snapshot'
        }
        if (!located && absPath) {
          const text = diskText(absPath)
          if (text !== null) {
            located = locateFragment(text, typeof op.oldString === 'string' ? op.oldString : '')
              || locateFragment(text, typeof op.newString === 'string' ? op.newString : '')
            if (located) lineSource = 'disk'
          }
        }
        const base = located ? located.line : 1
        let hunks
        if (op.oldString === '') hunks = newL.map((t, k) => ({ type: 'add', a: null, b: k + 1, text: t }))
        else if (op.newString === '') hunks = oldL.map((t, k) => ({ type: 'del', a: base + k, b: null, text: t }))
        else hunks = diffLines(oldL, newL, base, base)
        section = {
          kind: 'edit', at: op.at, hunks, truncated,
          lineExact: !!located, lineBase: located ? located.line : null,
          lineSource: located ? lineSource : null
        }
        // replace_all edits replaced every occurrence: the numbers above are the
        // FIRST one, so say how many sites the change landed on.
        if (located && located.count > 1) section.multiMatch = located.count
      } else {
        const all = splitLines(op.content)
        let lines = all
        let truncated = false
        if (all.length > MAX_LINES) { truncated = true; lines = all.slice(0, MAX_LINES) }
        section = {
          kind: 'write', at: op.at, wholeFile: true, truncated, lineExact: true, lineBase: 1,
          hunks: lines.map((t, k) => ({ type: 'add', a: null, b: k + 1, text: t }))
        }
      }
      const revertible = op.before !== undefined && op.after !== undefined
      section.opIndex = i
      section.revertible = revertible
      section.canUndo = revertible && (op.before !== null || i === ops.length - 1)
      sections.push(section)
    }
    return sections
  }

  function statsOf(ops) {
    let added = 0
    let removed = 0
    let writes = 0
    let edits = 0
    for (const op of ops) {
      if (op.kind === 'edit') {
        edits++
        added += splitLines(op.newString).length
        removed += splitLines(op.oldString).length
      } else {
        writes++
        added += splitLines(op.content).length
      }
    }
    return { added, removed, writes, edits }
  }

  function buildDetail(files, file) {
    const rec = files.get(file)
    if (!rec) return { path: file, sections: [] }
    const ops = rec.ops
    const first = ops[0]
    return {
      path: file,
      sections: buildSections(ops, ops.map((_, i) => i), resolvePath(rec.cwd || process.cwd(), file)),
      revertible: !!(first && first.before !== undefined)
    }
  }

  // Per-turn payload: files with at least one op tagged to 'turn', with only
  // that turn's ops in the sections (opIndex still indexes the full ops array).
  // `turn === -1` is the "latest activity" request: the newest labeled turn
  // plus any in-flight (unlabeled) ops newer than it — so the pill and the
  // review tab agree while an agent is running. latestWindowOf /
  // opInLatestWindow live at module top level (exported for tests).
  function buildTurn(files, turn) {
    const window = turn === -1 ? latestWindowOf(files) : null
    const effectiveTurn = window ? window.latestTurn : turn
    const items = []
    for (const rec of files.values()) {
      const indices = []
      for (let i = 0; i < rec.ops.length; i++) {
        const op = rec.ops[i]
        if (window
          ? opInLatestWindow(op, window.latestTurn, window.latestTaggedAt)
          : op.turn === turn) indices.push(i)
      }
      if (indices.length === 0) continue
      const ops = indices.map((i) => rec.ops[i])
      const stats = statsOf(ops)
      const last = ops[ops.length - 1]
      items.push({
        path: rec.path,
        name: String(rec.path).split('/').pop(),
        cwd: rec.cwd,
        ops: ops.length,
        writes: stats.writes,
        edits: stats.edits,
        added: stats.added,
        removed: stats.removed,
        lastTime: last ? last.at : 0,
        revertible: !!(rec.ops[0] && rec.ops[0].before !== undefined),
        sections: buildSections(rec.ops, indices, resolvePath(rec.cwd || process.cwd(), rec.path))
      })
    }
    items.sort((x, y) => y.lastTime - x.lastTime)
    return { turn: effectiveTurn, files: items }
  }

  async function doRevert(agentId, body, liveAgent) {    try {
      // The revert tool runs inside whichever agent called it, so a subagent
      // passes its own session id while the records live under the resolved
      // root bucket — resolve the bucket the same way the review endpoints do
      // instead of reporting "no record". `liveAgent` supplies the durable
      // lineage hint (exec.agent) for the first hop.
      const files = bucketOf(agentId, liveAgent)
      const path = body && typeof body.path === 'string' ? body.path : ''
      const opArg = body && body.op !== undefined && body.op !== null ? body.op : null
      if (!files || !files.has(path)) {
        return { ok: false, error: '未找到该文件的修改记录' }
      }
      const rec = files.get(path)
      const absPath = resolvePath(rec.cwd || process.cwd(), path)
      if (opArg === null) {
        // Whole-file revert: restore the state before the first recorded op.
        const first = rec.ops[0]
        if (!first) return { ok: false, error: '该文件没有可撤回的修改' }
        if (first.before === undefined) {
          return { ok: false, error: '该文件的首次修改未记录修改前内容（升级前产生的记录），无法撤回' }
        }
        if (truncatedSnapshot(first)) {
          return { ok: false, error: '该文件的编辑前快照超过 ' + MAX_CHARS + ' 字符已被截断，撤回会把文件截断，已拒绝' }
        }
        await applyRestore(absPath, first.before)
        files.delete(path)
        scheduleSave()
        return {
          ok: true, mode: 'file',
          message: first.before === null ? '已删除本次会话中新建的文件' : '已撤回该文件的全部修改'
        }
      }
      const op = Number(opArg)
      if (!Number.isInteger(op) || op < 0 || op >= rec.ops.length) {
        return { ok: false, error: '修改项索引无效' }
      }
      const target = rec.ops[op]
      if (target.before === undefined || target.after === undefined) {
        return { ok: false, error: '该项修改未记录内容快照（升级前产生的记录），无法撤回' }
      }
      if (truncatedSnapshot(target)) {
        return { ok: false, error: '该项修改的快照超过 ' + MAX_CHARS + ' 字符已被截断，撤回会损坏文件，已拒绝' }
      }
      if (op === rec.ops.length - 1) {
        await applyRestore(absPath, target.before)
      } else {
        if (target.before === null) {
          return { ok: false, error: '该项修改新建了文件且之后还有修改，无法单独撤回' }
        }
        const base = splitLines(target.after)
        const ours = splitLines(await readFile(absPath, 'utf8'))
        const theirs = splitLines(target.before)
        if (base.length > MAX_MERGE_LINES || ours.length > MAX_MERGE_LINES || theirs.length > MAX_MERGE_LINES) {
          return { ok: false, error: '文件过大，无法单独撤回该项' }
        }
        await writeFile(absPath, merge3(base, ours, theirs).join('\n'), 'utf8')
      }
      rec.ops = rec.ops.slice(0, op)
      if (rec.ops.length === 0) files.delete(path)
      scheduleSave()
      return { ok: true, mode: 'op', message: '已撤回该项修改（其后无冲突的修改已保留）' }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  // ── host package resolution for the revert tool ────────────────────────────
  // @deepseek-ai/dsh-tools is HOST-provided: it is declared here only as an
  // optional peerDependency (package.json), never installed a second time, so a
  // `link:`-installed plugin whose real path sits outside the profile cannot
  // reach it through the ordinary node_modules walk from this file. (The
  // published 0.1.5-rc.x line IS installable — checked with npm — but pulling a
  // private copy of the host's tool runtime into the plugin is worse than
  // reusing the host's.) So prefer the plain specifier, then anchor a fallback
  // on the RUNNING host executable: realpath(process.argv[1]) is the dsh entry
  // (bin: lib/bin.js) whose dependency tree carries dsh-tools. Note the anchor
  // depends on the host's install layout (npm/pnpm hoisting), so it stays a
  // fallback; when nothing resolves the original error is rethrown (Desktop,
  // tests) and the caller logs it.
  function hostToolsUrl() {
    try {
      if (!process.argv[1]) return null
      const fromHost = createRequire(realpathSync(process.argv[1]))
      return pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-tools')).href
    } catch (e) {
      return null
    }
  }
  function importHostTools() {
    return import('@deepseek-ai/dsh-tools').catch((err) => {
      const url = hostToolsUrl()
      if (!url) throw err
      return import(url).catch(() => { throw err })
    })
  }

  // ── diff_review_revert tool: the same undo reachable on EVERY composition
  // (including DSH Desktop) through the official agent tool channel — base-layer
  // tools registry, no private-layer RPC/HTTP needed. ────────────────────────
  try {
    if (ctx.tools && typeof ctx.tools.register === 'function') {
      importHostTools().then((m) => {
        try {
          ctx.tools.register(m.defineTool({
            name: 'diff_review_revert',
            description: 'Revert a file changed in this session back to its pre-change content using the diff-review snapshot (a file created in the session is deleted). Optionally revert a single recorded operation instead of the whole file.',
            parameters: {
              session: { type: 'string', description: 'Session id recorded by diff-review; omit to use the current session.' },
              path: { type: 'string', required: true, description: 'The file path as shown in the diff-review change list.' },
              op: { type: 'number', description: 'Optional 0-based index of one recorded operation; omit to revert all changes of this file.' }
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean' },
                  // doRevert also answers with the scope it actually applied.
                  // The host validates the body against THIS schema with
                  // additionalProperties:false, so an undeclared field turns
                  // every successful revert into
                  // `tool "diff_review_revert" returned invalid output:
                  // "value.mode" is not a declared property` — a failure the user
                  // sees even though the file was restored.
                  mode: { type: 'string', description: "Scope that was reverted: 'file' (whole file) or 'op' (one recorded operation)." },
                  message: { type: 'string' },
                  error: { type: 'string' }
                }
              },
              render: (_args, value) => [{ type: 'text', text: value.error ? 'Revert failed: ' + value.error : (value.message || 'Reverted.') }]
            },
            async execute(args, exec) {
              const sid = (typeof args.session === 'string' && args.session) ? args.session
                : (exec && exec.agent && exec.agent.session && exec.agent.session.id) || ''
              return doRevert(sid, { path: args.path, op: args.op !== undefined && args.op !== null ? args.op : null }, exec && exec.agent)
            }
          }))
          diag('revert tool registered: diff_review_revert')
        } catch (e) {
          diag('revert tool register failed: ' + String((e && e.message) || e))
        }
      }).catch((e) => {
        diag('revert tool import failed: ' + String((e && e.message) || e))
      })
    } else {
      diag('revert tool skipped: ctx.tools unavailable')
    }
  } catch (e) {
    diag('revert tool register failed: ' + String((e && e.message) || e))
  }

  // ── RPC endpoints over the official connection channel ─────────────────
  // v3: no self-built HTTP routes; everything is a JSON-RPC endpoint on the
  // `connection` channel. Web and Desktop (IPC bridge) both work through the
  // official transport, including the trust fence.
  async function handleRpc(endpoint, payload) {
    const body = payload || {}
    switch (endpoint) {
      case 'summary': {
        const session = typeof body.session === 'string' ? body.session : ''
        const files = bucketOf(session)
        return buildSummary(files || new Map())
      }
      case 'file': {
        const session = typeof body.session === 'string' ? body.session : ''
        return buildDetail(bucketOf(session) || new Map(), typeof body.path === 'string' ? body.path : '')
      }
      case 'turn': {
        const session = typeof body.session === 'string' ? body.session : ''
        const files = bucketOf(session)
        const turn = Number(body.turn)
        return buildTurn(files || new Map(), Number.isFinite(turn) ? turn : -1)
      }
      case 'clear': {
        const session = typeof body.session === 'string' ? body.session : ''
        // Clear what the view is actually showing: the exact key plus the
        // resolved root bucket (and with it any legacy child bucket of this
        // session, which is what a subagent's own view would read).
        sessions.delete(session)
        const rootId = session ? resolveRootId(session) : session
        if (rootId && rootId !== session) sessions.delete(rootId)
        scheduleSave()
        return { ok: true }
      }
      case 'revert':
        return doRevert(typeof body.session === 'string' ? body.session : '', body)
      case 'editors':
        return { editors: detectEditors() }
      case 'open-with-editor':
        return openWithEditor(body)
      case 'reveal':
        return revealPath(body)
      default:
        return { ok: false, error: '未知端点: ' + endpoint }
    }
  }

  async function openWithEditor(body) {
    const { editor, path: filePath, line, col } = body
    if (!editor || !filePath) {
      diag('open-with-editor rejected: missing editor/path ' + JSON.stringify({ editor, path: filePath }))
      return { ok: false, error: '缺少 editor 或 path 参数' }
    }
    if (!isSafeRecordedPath(sessions, filePath)) {
      diag('open-with-editor rejected by path fence: ' + filePath + ' (not inside any recorded file tree)')
      return { ok: false, error: '目标路径不在本次会话记录的文件范围内' }
    }
    const eds = detectEditors()
    const ed = eds.find((e) => e.id === editor)
    if (!ed || !ed.detected) {
      diag('open-with-editor rejected: editor ' + editor + ' not detected')
      return { ok: false, error: '编辑器 ' + editor + ' 未安装或未检测到' }
    }
    const abs = resolvePath(filePath)
    const bin = resolveEditorBin(ed)
    // `--goto file:line:col` parses badly with Windows backslashes (the drive colon
    // and the line colon look alike), so editors get the forward-slash form —
    // Windows APIs accept it and VS Code/Cursor both expect it.
    const fileArg = abs.replace(/\\/g, '/')
    const args = typeof ed.openArgs === 'function'
      ? ed.openArgs(fileArg, line != null ? String(line) : '1', col != null ? String(col) : '1')
      : [abs]
    try {
      await launchEditor(bin, args, (m) => diag('open-with-editor ' + m))
      diag('open-with-editor ok: ' + editor + ' ' + JSON.stringify([abs, line != null ? line : null]) + ' via ' + bin)
      return { ok: true }
    } catch (e) {
      const msg = String((e && e.message) || e)
      diag('open-with-editor failed: ' + editor + ' bin=' + bin + ' args=' + JSON.stringify(args) + ' error=' + msg)
      return { ok: false, error: '打开编辑器失败: ' + msg }
    }
  }

  async function revealPath(body) {
    const filePath = body && body.path
    if (!filePath) return { ok: false, error: '缺少 path 参数' }
    if (!isSafeRecordedPath(sessions, filePath)) {
      return { ok: false, error: '目标路径不在本次会话记录的文件范围内' }
    }
    const abs = resolvePath(filePath)
    const platform = process.platform
    try {
      if (platform === 'darwin') execFileSync('open', ['-R', abs], { timeout: 10000, stdio: 'ignore' })
      else if (platform === 'win32') execFileSync('explorer.exe', ['/select,' + abs], { timeout: 10000, stdio: 'ignore' })
      else execFileSync('xdg-open', [dirname(abs)], { timeout: 10000, stdio: 'ignore' })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  // ── channel face ───────────────────────────────────────────────────────
  // The client calls ctx.connection.rpc.call('/diff-review', endpoint, payload):
  // the official transport (web fetch / desktop IPC bridge) POSTs the official
  // envelope to /diff-review/<endpoint>. We serve that path directly on
  // webServer — the channel name is a single path segment (the official
  // assertTarget rejects slashes), and prefix matching is path-segment based.
  //
  // NOTE: `connection.rpc.handle`/`intercept` are NOT usable from another
  // plugin — they register through the provider fiber's ctx.effect and throw
  // INACTIVE_EFFECT cross-fiber. Serving the path directly on webServer is the
  // reliable third-party route.
  // v4: the web-app composition defers the webserver row behind webStartup
  // (and webRuntime exists only after the socket binds) while loader entries
  // start CONCURRENTLY, so on a cold boot webServer activates after this
  // plugin applies — a one-shot ctx.get('webServer') here races and loses.
  // ctx.inject below registers a dependent fiber: the route attaches whenever
  // the webServer service becomes available, detaches if it goes away, and
  // simply never runs in compositions that provide no webServer (optional).
  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      diag('webServer service present but has no register() - /diff-review channel NOT reachable')
      return
    }
    wctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/diff-review',
      handler: async (req, res) => {
        try {
          // Minimal same-trust fence: loopback Host + same-origin (or no
          // browser origin). Mirrors the official /api fence.
          if (!isLoopbackRequest(req)) {
            res.writeHead(403)
            res.end('forbidden')
            return
          }
          if (req.method !== 'POST') { res.writeHead(404); res.end('not found'); return }
          const pathname = new URL(req.url, 'http://x').pathname
          const endpoint = pathname.slice('/diff-review/'.length)
          if (!endpoint || endpoint.includes('/') || !/^[A-Za-z0-9_$.-]+$/.test(endpoint)) {
            res.writeHead(404); res.end('not found'); return
          }
          const ct = String(req.headers['content-type'] || '')
          if (!ct.toLowerCase().startsWith('application/json')) {
            res.writeHead(415); res.end('content type must be application/json'); return
          }
          const chunks = []
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > 1e6) { res.writeHead(413); res.end(); return }
            chunks.push(chunk)
          }
          let message
          try {
            message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            res.writeHead(400); res.end('body is not JSON'); return
          }
          const rpcId = message && typeof message.rpcId === 'string' ? message.rpcId : 'x'
          if (!message || message.type !== 'client-request' || message.method !== endpoint) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'invalid-envelope', message: 'invalid envelope', details: {} } } }))
            return
          }
          let result
          let transportError = null
          try {
            result = await handleRpc(endpoint, message.payload || {})
          } catch (e) {
            transportError = String((e && e.message) || e)
          }
          // The official Web transport validates every reply before the plugin
          // ever sees it: parseConnectionResponse requires
          //   { ok: true, value } | { ok: false, error: { code, message, details } }
          // and throws "invalid server-response result" on a bare payload. The
          // host used to return the raw payload, so EVERY client call failed
          // inside the transport and silently fell back to local history — the
          // review view then only ever showed the parent session's own edits.
          // Payload-level `ok` flags (open-with-editor, revert) stay inside
          // `value` untouched: they are business results, not RPC failures.
          const envelope = transportError === null
            ? { ok: true, value: result === undefined ? null : result }
            : { ok: false, error: { code: 'diff-review-handler', message: transportError, details: {} } }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId, result: envelope }))
        } catch (e) {
          diag('channel handler failed: ' + String((e && e.message) || e))
          try { res.writeHead(500); res.end('handler failure') } catch (e2) {}
        }
      }
    }), 'diff-review: /diff-review channel')
    diag('serving /diff-review.* on webServer')
  })
  diag('channel watcher armed - /diff-review route attaches when webServer activates')
}

/** Minimal same-trust request fence (mirrors client-connection's isTrustedApiRequest). */
function isLoopbackRequest(req) {
  try {
    const host = req.headers && req.headers['host']
    if (typeof host !== 'string' || host.length === 0) return false
    const hostUrl = new URL('http://' + host)
    const hostname = hostUrl.hostname
    const parts = hostname.split('.')
    const loopback = hostname === 'localhost' || hostname === '[::1]' ||
      (parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255))
    if (!loopback) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers['origin']
    if (origin === undefined) return true
    return new URL(origin).host === hostUrl.host
  } catch (e) {
    return false
  }
}

export {
  apply, cap, detectEditors, diffHunks, diffLines, inject, isLoopbackRequest,
  isSafeRecordedPath, latestWindowOf, launchEditor, loadSessions, loadStateInto, locateFragment,
  merge3, name, opInLatestWindow, serializeSessions, splitLines, stateFilePath,
  writeJsonAtomicSync
}
