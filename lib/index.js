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
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, appendFileSync, realpathSync, statSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
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

// Total on purpose: the state file is also read from disk, so an op written by an
// older version (or hand-edited) can arrive without one of its text fields. One
// such op used to make splitLines() throw, which took down the whole
// summary/file response — an empty review view instead of one odd section.
function splitLines(s) {
  if (s === '' || s == null) return []
  return typeof s === 'string' ? s.split('\n') : String(s).split('\n')
}

// ── card totals: net line counts, computed the way the shell's own card does ──
// `statsOf` is pure and lives here (not inside apply) so the counting rules are
// unit-testable: the official changed-files card diffs the file between turn
// boundaries, and this is the same thing over the recorded snapshots.
/** Snapshots above this size are not diffed for the card: a full-file diff per poll
 *  on a large file is not worth it, and the fallback below is exact per op anyway. */
const STATS_NET_MAX_CHARS = 400000

/** Texts bigger than this are not packed either: the point of the cap is to bound
 *  MEMORY, and a multi-megabyte blob per op would defeat it. */
const PACK_MAX_CHARS = 8 * 1024 * 1024

/**
 * Store a snapshot that MAX_CHARS had to cut, in the shard, as gzip+base64.
 *
 * The cap bounds MEMORY — every op lives in the host's RAM — while the untruncated
 * text is exactly what revert and the exact card totals need. So the full text rides
 * along with the record (one extra field on the shard line) and is decompressed only
 * when something actually asks for it. Records written before this have no packed
 * text and keep the old, honest refusal / estimate.
 */
function packText(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > PACK_MAX_CHARS) return undefined
  try {
    return gzipSync(Buffer.from(text, 'utf8'), { level: 6 }).toString('base64')
  } catch (e) {
    return undefined
  }
}

// Decoded full texts are cached: the review tab, the pill and the card ask for the
// same snapshots repeatedly (every poll), and gunzip is the expensive part.
const PACK_CACHE_MAX = 8
const packCache = new Map()

function unpackText(packed) {
  if (typeof packed !== 'string' || packed === '') return null
  const hit = packCache.get(packed)
  if (hit !== undefined) return hit
  let text = null
  try {
    text = gunzipSync(Buffer.from(packed, 'base64')).toString('utf8')
  } catch (e) {
    return null
  }
  if (packCache.size >= PACK_CACHE_MAX) packCache.delete(packCache.keys().next().value)
  packCache.set(packed, text)
  return text
}

/** The untruncated side of an op: the stored copy when it was never cut, else the
 *  packed full text (a blob, or the inline form older records used). `null` when
 *  neither is available (a pre-pack record). */
function fullSideOf(op, side) {
  if (!op) return null
  const lenField = side === 'before' ? op.beforeLen : op.afterLen
  const stored = op[side]
  if (lenField !== undefined) {
    const full = packedSideOf(op, side)
    if (full !== null) return full
    return typeof stored === 'string' ? stored : null
  }
  if (typeof stored === 'string') return stored
  return stored === null ? '' : null
}

/** The side only when it is COMPLETE — the stored copy if it was never cut, else the
 *  packed text. Diffing two cut heads produced meaningless card totals (`+0 −0` for a
 *  file that had changed), so the exact path asks for this and falls back to the
 *  per-op estimate when it gets `null`. */
function exactSideOf(op, side) {
  if (!op) return null
  const lenField = side === 'before' ? op.beforeLen : op.afterLen
  const stored = op[side]
  const cut = lenField !== undefined || (typeof stored === 'string' && stored.length >= MAX_CHARS)
  if (!cut) return typeof stored === 'string' ? stored : (stored === null ? '' : null)
  return packedSideOf(op, side)
}

// ── full snapshots of big sides: content-addressed gzip blobs ───────────────
// The first shape kept that text INLINE in the shard line (base64+gzip). That wasted
// space the edit chain hands us for free: one op's `after` IS the next op's `before`,
// so the same 200 KB text was stored twice per edit. A blob is named after the hash of
// its content, so identical texts collapse into one file, and load-time GC deletes what
// no live op references any more (ops shifted out by MAX_OPS, cleared sessions, reverts,
// the pre-blob inline shape after compaction).
const BLOB_DIR_NAME = 'blobs'
/** A side at least this big is kept as a blob reference instead of inside the shard
 *  line. Measured on a real profile: the biggest part of a 42 MB shard was the whole
 *  copies of large files (a 105 KB file costs ~210 KB per edit — twice, for before and
 *  after), and only the >120k truncated sides were being offloaded before. Small sides
 *  stay inline: a blob file per edit would cost more than the few hundred bytes saved. */
const BLOB_STORE_MIN_CHARS = 32 * 1024
/** Only blobs untouched for this long may be collected: another process on the same
 *  profile may have written one we have not read yet. */
const BLOB_GC_GRACE_MS = 10 * 60 * 1000

/** The state dir the resolvers read blobs from. `apply` sets it; the helpers that need
 *  it (`fullSideOf`, `exactSideOf`, `statsOf`, `revertTextOf`) are called from many
 *  places, so the directory is ambient rather than threaded through every signature. */
let activeStateDir = null

function setActiveStateDir(dir) {
  activeStateDir = typeof dir === 'string' && dir !== '' ? dir : null
}

function blobDirOf(stateDir) {
  return join(stateDir, BLOB_DIR_NAME)
}

function blobIdOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
}

/** Store one full snapshot text, reusing the file when that content is already there.
 *  @returns the blob id, or null when it could not be written (the caller then falls
 *  back to the inline form, so a blob failure never loses the snapshot). */
function storeBlob(stateDir, text) {
  if (typeof text !== 'string' || text === '' || text.length > PACK_MAX_CHARS) return null
  if (typeof stateDir !== 'string' || stateDir === '') return null
  const dir = blobDirOf(stateDir)
  const id = blobIdOf(text)
  const file = join(dir, id + '.gz')
  try {
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true })
      const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
      writeFileSync(tmp, gzipSync(Buffer.from(text, 'utf8'), { level: 6 }))
      try {
        renameSync(tmp, file)
      } catch (e) {
        rmSync(tmp, { force: true })
        throw e
      }
    }
    return id
  } catch (e) {
    return null
  }
}

/** Read one blob back (cached: the card, the pill and the preview ask for the same
 *  texts on every poll, and gunzip is the expensive part). */
function readBlob(stateDir, id) {
  const dir = typeof stateDir === 'string' && stateDir !== '' ? stateDir : activeStateDir
  if (!dir || typeof id !== 'string' || !/^[0-9a-f]{8,64}$/.test(id)) return null
  const key = 'blob:' + dir + ':' + id
  const hit = packCache.get(key)
  if (hit !== undefined) return hit
  let text = null
  try {
    text = gunzipSync(readFileSync(join(blobDirOf(dir), id + '.gz'))).toString('utf8')
  } catch (e) {
    return null
  }
  if (packCache.size >= PACK_CACHE_MAX) packCache.delete(packCache.keys().next().value)
  packCache.set(key, text)
  return text
}

/** The FULL text kept for one side of an op, wherever it lives: a blob first (the
 *  current shape), then the inline base64 form (the pre-blob shape). */
function packedSideOf(op, side) {
  if (!op) return null
  const inline = side === 'before' ? op.fb : op.fa
  if (typeof inline === 'string' && inline !== '') {
    const text = unpackText(inline)
    if (text !== null) return text
  }
  const ref = side === 'before' ? op.fbRef : op.faRef
  if (typeof ref === 'string' && ref !== '') return readBlob(null, ref)
  return null
}

/** Every blob id the live records still point at. */
function collectBlobRefs(sessions) {
  const refs = new Set()
  for (const files of sessions.values()) {
    for (const rec of files.values()) {
      for (const op of rec.ops) {
        if (typeof op.fbRef === 'string') refs.add(op.fbRef)
        if (typeof op.faRef === 'string') refs.add(op.faRef)
      }
    }
  }
  return refs
}

/** Disk taken by one session's records: its shard file plus the blobs it references.
 *  Blobs are shared by content, so the blob part is "what this session points at" —
 *  clearing the session only frees the blobs no other session points at. */
function sessionUsage(stateDir, sessionIds, sessions) {
  const out = { shard: 0, blobs: 0, blobCount: 0, total: 0, files: 0, ops: 0 }
  if (typeof stateDir !== 'string' || stateDir === '') return out
  const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds]
  const seenShards = new Set()
  const refs = new Set()
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue
    const name = shardNameOf(id)
    if (seenShards.has(name)) continue
    seenShards.add(name)
    try {
      out.shard += statSync(join(stateDir, name)).size
    } catch (e) {}
    const files = sessions && typeof sessions.get === 'function' ? sessions.get(id) : null
    if (!files) continue
    for (const rec of files.values()) {
      out.files++
      for (const op of rec.ops) {
        out.ops++
        if (typeof op.fbRef === 'string') refs.add(op.fbRef)
        if (typeof op.faRef === 'string') refs.add(op.faRef)
      }
    }
  }
  for (const id of refs) {
    try {
      out.blobs += statSync(join(blobDirOf(stateDir), id + '.gz')).size
      out.blobCount++
    } catch (e) {}
  }
  out.total = out.shard + out.blobs
  return out
}

/** Delete the blobs no live op references. Runs at load, after the shards have been
 *  replayed and compacted, so it also reclaims what MAX_OPS trimming, `clear` and
 *  reverts orphaned. Skipped when a shard had unreadable lines: those lines may have
 *  held references we could not see. */
function gcBlobs(stateDir, sessions, opts = {}) {
  const out = { kept: 0, removed: 0, skipped: opts.skip === true }
  if (out.skipped || typeof stateDir !== 'string' || stateDir === '') return out
  const dir = blobDirOf(stateDir)
  let names = []
  try {
    names = readdirSync(dir)
  } catch (e) {
    return out
  }
  const refs = collectBlobRefs(sessions)
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.gz')) continue
    const id = name.slice(0, -3)
    if (refs.has(id)) { out.kept++; continue }
    const file = join(dir, name)
    try {
      if (now - statSync(file).mtimeMs < BLOB_GC_GRACE_MS) { out.kept++; continue }
      rmSync(file, { force: true })
      out.removed++
    } catch (e) {}
  }
  return out
}

/** Keep the full text of whichever side is BIG (or was cut by MAX_CHARS) in a
 *  content-addressed blob. The op still keeps its copies in memory — that is what bounds
 *  RAM and what the views read — the shard line just stops repeating them, and load
 *  (`rebuildCutSides`) puts them back. A blob that cannot be written falls back to the
 *  inline form, so a failure only costs disk, never the snapshot. */
function packBigSides(op, rawBefore, rawAfter, stateDir) {
  if (!op) return op
  const attach = (side, raw) => {
    if (typeof raw !== 'string') return
    const lenField = side === 'before' ? 'beforeLen' : 'afterLen'
    const cut = op[lenField] !== undefined
    if (!cut && raw.length < BLOB_STORE_MIN_CHARS) return
    const id = storeBlob(stateDir, raw)
    if (id !== null) {
      op[side === 'before' ? 'fbRef' : 'faRef'] = id
      return
    }
    const packed = packText(raw)
    if (packed !== undefined) op[side === 'before' ? 'fb' : 'fa'] = packed
  }
  attach('before', rawBefore)
  attach('after', rawAfter)
  return op
}

/** Move an op's inline full texts into blobs, IN PLACE, so the in-memory record and
 *  the shard that gets written agree on where the text lives (GC counts references on
 *  the in-memory records). Called while a shard is being rewritten — the rewrite is
 *  happening anyway, so the conversion is free, and identical texts across ops (one
 *  op's `after` is the next op's `before`) collapse into a single file.
 *  @returns whether anything changed. */
function offloadInlineSnapshots(stateDir, op) {
  if (!op) return false
  let changed = false
  const move = (side) => {
    const inlineField = side === 'before' ? 'fb' : 'fa'
    const refField = side === 'before' ? 'fbRef' : 'faRef'
    const inline = op[inlineField]
    if (typeof inline !== 'string' || inline === '') return
    if (typeof op[refField] === 'string') return
    const text = unpackText(inline)
    if (text === null) return
    const id = storeBlob(stateDir, text)
    if (id === null) return
    delete op[inlineField]
    op[refField] = id
    changed = true
  }
  move('before')
  move('after')
  return changed
}

/** Convert every inline full text left in memory (the pre-blob shape, or a blob write
 *  that failed at record time) into a blob. Load-time, so the blob set and the live
 *  references agree before GC runs. @returns the sessions whose shard needs a rewrite. */
function offloadAllInline(stateDir, sessions) {
  const touched = new Map()
  for (const [sid, files] of sessions) {
    let changed = false
    for (const rec of files.values()) {
      for (const op of rec.ops) {
        if (offloadInlineSnapshots(stateDir, op)) changed = true
      }
    }
    if (changed) touched.set(sid, files)
  }
  return touched
}

/** Give a BIG, COMPLETE side of an existing record a blob reference, so a rewrite can
 *  drop it from the shard line. Records written before `BLOB_STORE_MIN_CHARS` existed
 *  kept whole copies of every large file (a 105 KB file cost ~210 KB per edit) with no
 *  reference to replace them — but those copies are the full text, so they can be hashed
 *  into a blob and dropped.
 *
 *  A side that was CUT is never adopted: `cap` truncated it, so it is not the full text
 *  and must not become a blob (a restore from it would truncate the file). */
function adoptSide(stateDir, op, side) {
  if (!op) return false
  if (typeof op[side === 'before' ? 'fbRef' : 'faRef'] === 'string') return false
  const text = op[side]
  if (typeof text !== 'string' || text.length < BLOB_STORE_MIN_CHARS) return false
  // `beforeLen`/`afterLen` mark a cut; without one, a side of exactly MAX_CHARS is
  // treated as cut too (see isCutSide).
  const lenField = side === 'before' ? 'beforeLen' : 'afterLen'
  if (typeof op[lenField] === 'number' || text.length >= MAX_CHARS) return false
  const id = storeBlob(stateDir, text)
  if (id === null) return false
  op[side === 'before' ? 'fbRef' : 'faRef'] = id
  return true
}

/** Adopt big complete sides across every loaded session (load time, before GC so the
 *  new references are counted). @returns the sessions whose shard needs a rewrite. */
function adoptBigSides(stateDir, sessions) {
  const touched = new Map()
  for (const [sid, files] of sessions) {
    let changed = false
    for (const rec of files.values()) {
      for (const op of rec.ops) {
        if (adoptSide(stateDir, op, 'before')) changed = true
        if (adoptSide(stateDir, op, 'after')) changed = true
      }
    }
    if (changed) touched.set(sid, files)
  }
  return touched
}

/** The shard form of an op: a cut side whose FULL text lives in a blob is left out of
 *  the line and rebuilt on load (see `rebuildCutSides`). Those capped copies are the
 *  bulk of a shard — measured on one real profile, 32 MB of a 35 MB shard was the
 *  120k-character copies of 77 cut ops, while the packed full texts were 0.2 MB — and
 *  a blob already holds the text they were cut from. */
function shrinkForShard(op) {
  if (!op || (typeof op.fbRef !== 'string' && typeof op.faRef !== 'string')) return op
  let out = op
  const drop = (side, refField) => {
    if (typeof op[refField] !== 'string') return
    if (typeof op[side] !== 'string') return
    if (out === op) out = Object.assign({}, op)
    delete out[side]
  }
  drop('before', 'fbRef')
  drop('after', 'faRef')
  return out
}

/** Rebuild what `shrinkForShard` left out, while a shard is being replayed, so the
 *  in-memory record is exactly what the rest of the plugin expects. A side stored as a
 *  blob is restored with `cap()`: for a truncated side that is the capped copy, and for
 *  a merely big one it is the text itself (it was never cut).
 *  @returns 'rebuilt' | 'failed' | 'none'. */
function rebuildCutSides(op, dir) {
  if (!op || typeof op !== 'object') return 'none'
  let outcome = 'none'
  for (const side of ['before', 'after']) {
    if (op[side] !== undefined) continue
    const lenField = side === 'before' ? 'beforeLen' : 'afterLen'
    const refField = side === 'before' ? 'fbRef' : 'faRef'
    if (typeof op[refField] !== 'string') continue
    const full = readBlob(dir, op[refField])
    if (full === null) {
      // The blob is gone (a hand-cleaned state dir): mark the side as lost, so revert
      // says "the snapshot was truncated / unrecoverable" instead of "no snapshot was
      // recorded", and the op is counted in the load log.
      op[side === 'before' ? 'beforeLost' : 'afterLost'] = true
      outcome = 'failed'
      continue
    }
    op[side] = cap(full)
    outcome = 'rebuilt'
  }
  return outcome
}

/** Whitespace-insensitive line key (git `-w` / `--ignore-all-space`): two lines
 *  match when they are equal after dropping every whitespace character. */
function wsKey(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '')
}

function lineEq(a, b, opts) {
  return opts && opts.ignoreWhitespace === true ? wsKey(a) === wsKey(b) : a === b
}

/** Exact line counts between two texts. */
function lineCounts(a, b, opts) {
  let added = 0
  let removed = 0
  for (const h of diffLines(splitLines(a), splitLines(b), 1, 1, opts)) {
    if (h.type === 'add') added++
    else if (h.type === 'del') removed++
  }
  return { added, removed }
}

/** One op's own change, for records that carry no whole-file snapshot (and for
 *  ranges whose endpoint snapshots were cut by MAX_CHARS). */
function opCounts(op, opts) {
  if (!op) return { added: 0, removed: 0 }
  if (op.kind === 'edit') {
    return lineCounts(typeof op.oldString === 'string' ? op.oldString : '', typeof op.newString === 'string' ? op.newString : '', opts)
  }
  const content = typeof op.content === 'string' ? op.content : ''
  // An overwrite knows what it replaced; a create does not. A huge pair is not
  // worth a full diff on the recording path — the content lines are the safe answer.
  if (typeof op.before === 'string' && op.before.length + content.length <= STATS_NET_MAX_CHARS) {
    return lineCounts(op.before, content, opts)
  }
  return { added: splitLines(content).length, removed: 0 }
}

/**
 * Card totals for a range of ops: the content BEFORE its first op versus AFTER its
 * last one — the shell's own semantics (it diffs the worktree between turn
 * boundaries).
 *
 * Two earlier shapes were wrong and were measured wrong: summing each op's FRAGMENT
 * length counted every context line as a change (a one-line edit read +4/−4), and
 * summing each op counted every intermediate state (+401 −93 where the shell's card
 * read +181 −7). A third trap remains for BIG files: MAX_CHARS cuts the stored
 * snapshots at 120k characters, and a diff of two cut heads is meaningless (it read
 * `+0 −0` for a file that definitely changed). The untruncated endpoints are packed
 * with a cut op, so the exact diff usually still runs; when it cannot, the ops' own
 * counts — recorded from the untruncated text at write time — are summed instead and
 * the result is flagged `estimated`.
 */
function statsOf(ops, key, opts) {
  let writes = 0
  let edits = 0
  for (const op of ops) {
    if (op.kind === 'edit') edits++
    else writes++
  }
  const range = rangeRowsOf(ops, key, opts)
  if (range) return { added: range.added, removed: range.removed, writes, edits, estimated: false }
  let added = 0
  let removed = 0
  const ignoreWs = opts && opts.ignoreWhitespace === true
  for (const op of ops) {
    // Stored per-op counts were recorded without the whitespace preference, so
    // they are the wrong answer the moment ignoreWhitespace is on — recompute
    // from the fragments instead.
    if (!ignoreWs && typeof op.added === 'number' && typeof op.removed === 'number') {
      added += op.added
      removed += op.removed
      continue
    }
    const own = opCounts(op, opts)
    added += own.added
    removed += own.removed
  }
  // `estimated` marks every fallback: missing snapshots, an unrecoverable cut, or a
  // pair too large to diff. Callers (and tests) can tell it from an exact net.
  return { added, removed, writes, edits, estimated: true }
}

/** How many lines of context the hover preview keeps on each side of a change. */
const PREVIEW_CONTEXT = 3

/** Trim a full-file diff to the preview shape: a few context lines around every
 *  change, with `⋯` marking the lines left out between distant ones. */
function previewRowsOf(rows, context = PREVIEW_CONTEXT) {
  const keep = new Array(rows.length).fill(false)
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === 'ctx') continue
    const from = Math.max(0, i - context)
    const to = Math.min(rows.length - 1, i + context)
    for (let k = from; k <= to; k++) keep[k] = true
  }
  const out = []
  let skipped = false
  for (let i = 0; i < rows.length; i++) {
    if (!keep[i]) { skipped = true; continue }
    if (skipped && out.length > 0) out.push({ type: 'gap', a: null, b: null, text: '⋯' })
    skipped = false
    out.push(rows[i])
  }
  return out
}

// Endpoint diffs are memoized: the turn payload is fetched on every poll (the card,
// the pill and now the preview all read the same ranges) and a big file's diff is
// not free.
const RANGE_CACHE_MAX = 32
const rangeCache = new Map()

/** The exact endpoint diff of a range, or null when it cannot be produced. `key`
 *  keeps two files with identical timings apart in the memo. */
function rangeRowsOf(ops, key, opts) {
  if (!Array.isArray(ops) || ops.length === 0) return null
  const first = ops[0]
  const last = ops[ops.length - 1]
  const before = exactSideOf(first, 'before')
  const after = exactSideOf(last, 'after')
  if (before === null || after === null) return null
  if (before.length + after.length > STATS_NET_MAX_CHARS) return null
  const ignoreWs = opts && opts.ignoreWhitespace === true ? 'w' : ''
  const sig = (key || '') + '|' + ops.length + '|' + (first.at || 0) + '|' + (last.at || 0) + '|' + before.length + '|' + after.length + '|' + ignoreWs
  const hit = rangeCache.get(sig)
  if (hit) return hit
  const rows = diffLines(splitLines(before), splitLines(after), 1, 1, opts)
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.type === 'add') added++
    else if (row.type === 'del') removed++
  }
  const value = { rows, added, removed }
  if (rangeCache.size >= RANGE_CACHE_MAX) rangeCache.delete(rangeCache.keys().next().value)
  rangeCache.set(sig, value)
  return value
}

/** The hover preview payload for a range: the same exact diff, trimmed to context.
 *  The per-op sections only carry what the model wrote in `old_string`/`new_string`,
 *  so a one-line edit there is a bare +/− pair with nothing around it — while the
 *  shell's own preview shows three lines on each side. `null` means "no exact diff
 *  available", and the client falls back to the sections. */
function previewOf(ops, key, opts) {
  const range = rangeRowsOf(ops, key, opts)
  if (!range) return null
  return { rows: previewRowsOf(range.rows), lineExact: true }
}

// ── line diff via jsdiff diffArrays ──────────────────────────────────────
// diffArrays compares whole lines (same semantics as v1's LCS), but runs in
// O(ND) time and produces per-change blocks we can walk once into both the
// render shape ({type,a,b,text}) and the hunk shape ({a0,a1,b0,b1}).

/** Walk diffArrays changes, yielding {type, value[]} blocks in order. `opts.ignoreWhitespace`
 *  makes two lines equal when they match after dropping all whitespace (git `-w`); the
 *  returned common blocks then carry the NEW side's text, which is what the UI shows. */
function changeBlocks(a, b, opts) {
  if (opts && opts.ignoreWhitespace === true) {
    return diffArrays(a, b, { comparator: (left, right) => wsKey(left) === wsKey(right) })
  }
  return diffArrays(a, b)
}

/**
 * Render-shape line diff: [{ type: 'ctx'|'del'|'add', a, b, text }] with both-side
 * line numbers. `aStart`/`bStart` seed the first line number so a diff of a FILE
 * FRAGMENT can report the real file lines instead of numbering the fragment from 1.
 */
function diffLines(a, b, aStart = 1, bStart = 1, opts) {
  const out = []
  const blocks = changeBlocks(a, b, opts)
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
 * Whether a stored op snapshot is only the HEAD of a bigger file, i.e. `cap` cut it
 * at MAX_CHARS. `beforeLen`/`afterLen` record the original length; a record that
 * predates them carries none, so a snapshot of exactly MAX_CHARS is treated as cut
 * — refusing is the safe side of that guess. Used by `revertTextOf` (a cut side
 * needs its packed full text) and `unrecoverableCut` (a cut side with nothing
 * packed behind it cannot be restored).
 */
function isCutSide(op, side) {
  const stored = op[side]
  const len = side === 'before' ? op.beforeLen : op.afterLen
  return typeof len === 'number' ? len > stored.length : stored.length >= MAX_CHARS
}

/** The text to restore for one side of an op: the untruncated text when the record
 *  carries it (packed), else the stored copy — and `null` when the stored copy is a
 *  cut head with nothing packed behind it, which is the only case worth refusing.
 *  `undefined` means "this side was never recorded". (`beforeLost`/`afterLost` mark a
 *  shard line whose side could not be rebuilt because its blob is gone: that is a cut
 *  side with nothing behind it, so it refuses rather than claiming no snapshot.) */
function revertTextOf(op, side) {
  if (!op) return undefined
  const stored = op[side]
  if (stored === undefined) return (side === 'before' ? op.beforeLost : op.afterLost) === true ? null : undefined
  if (stored === null) return null
  if (!isCutSide(op, side)) return stored
  const full = packedSideOf(op, side)
  return full === null ? null : full
}

/** Whether a cut side's full text is unrecoverable (a pre-pack record, or a shard line
 *  whose blob is gone — `beforeLost`/`afterLost` from `rebuildCutSides`). */
function unrecoverableCut(op, side) {
  if (!op) return false
  if ((side === 'before' ? op.beforeLost : op.afterLost) === true) return true
  const stored = op[side]
  if (typeof stored !== 'string') return false
  if (!isCutSide(op, side)) return false
  return packedSideOf(op, side) === null
}

// ── system-prompt injection: "think in Chinese" ─────────────────────────────
// One switch in Settings → 修改审查 (ON by default): register a short "think in
// Simplified Chinese" rule as a real system-prompt section.
//
// v1 wrote the rule into the user's global AGENTS.md. Measurement showed why that
// under-delivers: that file reaches the model as a *user* message wrapped in a
// deliberately self-subordinating <system-reminder> ("may be relevant to your work",
// "use them as guidance when applicable", "they do not override system, developer, or
// direct user instructions"), and dsh-agent-instructions reads it ONLY at a session's
// first agent/pre-step with no watcher — so an edit never reached a running session,
// and the rule was silently dropped first whenever the 64 KiB workspace budget
// overflowed (broader files are omitted before the most specific one is truncated).
// A system-prompt section is reassembled on every step (dsh-agent-loop), so the switch
// takes effect on the next request — in the current session — and the rule arrives at
// developer authority instead of below it. Nothing is written to the user's files.
const ZH_THINKING_SECTION = 'dsh-review-checkout:zh-thinking'
/** Placement: DEPLOYMENT_PERSONA_SUFFIX (10200) is the highest order the harness
 *  allocates, so one past it makes this rule the last section of the system prompt.
 *  External contributions may use any finite order. */
const ZH_THINKING_ORDER = 10201
/** The rule. "reasoning" is named first and told not to follow the task language,
 *  because the failure this replaces was Chinese answers with English reasoning. */
const ZH_THINKING_RULE = [
  '# 语言规则',
  '',
  '- 推理过程（reasoning / thinking）必须使用简体中文：即使任务、代码、工具输出、日志或上下文是英文，也不要用英文推理。',
  '- 所有面向用户的回答、计划、总结、代码注释同样使用简体中文。',
  '- 仅代码、命令、文件路径、变量名、API 名称等必须原样保留的内容使用英文。',
  '- 若某个工作区/项目的 AGENTS.md 明确指定了其他语言，则以该项目级规则为准。'
].join('\n')

/** What the Settings page shows: the switch, the section identity, and whether the
 *  host actually registered the section (a missing `systemPrompt` service is
 *  reported, never silent). */
function zhThinkingStatus(enabled, registered, error) {
  return {
    ok: error === undefined,
    enabled: enabled === true,
    registered: registered === true,
    section: ZH_THINKING_SECTION,
    order: ZH_THINKING_ORDER,
    error
  }
}

// ── plugin settings (one small json next to the shards) ─────────────────────
const SETTINGS_FILE_NAME = 'settings.json'

function settingsFilePath(dir) {
  return join(dir, SETTINGS_FILE_NAME)
}

function readPluginSettings(dir) {
  try {
    const raw = JSON.parse(readFileSync(settingsFilePath(dir), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch (e) {
    return {}
  }
}

function writePluginSettings(dir, settings) {
  try {
    mkdirSync(dir, { recursive: true })
    writeJsonAtomicSync(settingsFilePath(dir), settings)
    return true
  } catch (e) {
    return false
  }
}

// ── review preferences (host-side so stats, cards and the client agree) ─────
// ignoreWhitespace: display/stats treat whitespace-only line changes as equal
// hideGitIgnored: drop files git itself would ignore (.gitignore / exclude / global)
function readReviewPrefs(dir) {
  const raw = readPluginSettings(dir)
  return {
    ignoreWhitespace: raw.ignoreWhitespace === true,
    // On by default: the point of the filter is to skip lockfile/generated noise.
    hideGitIgnored: raw.hideGitIgnored !== false
  }
}

function writeReviewPrefs(dir, prefs) {
  const settings = readPluginSettings(dir)
  if (prefs && typeof prefs.ignoreWhitespace === 'boolean') settings.ignoreWhitespace = prefs.ignoreWhitespace
  if (prefs && typeof prefs.hideGitIgnored === 'boolean') settings.hideGitIgnored = prefs.hideGitIgnored
  return writePluginSettings(dir, settings)
}

// ── git's own ignore rules ──────────────────────────────────────────────────
// File filtering is delegated to `git check-ignore`, so nested .gitignore,
// .git/info/exclude and the user's global ignore all apply without re-implementing
// the pattern language. Paths outside a repo (or without git) are never filtered.
const GIT_IGNORE_CACHE_MAX = 4096
const gitIgnoreCache = new Map()

function gitBin() {
  return process.platform === 'win32' ? 'git.exe' : 'git'
}

/** Batch-check absolute paths from `cwd`. Returns a Set of the ignored ones. */
function gitIgnoredSet(absPaths, cwd) {
  const result = new Set()
  const pending = []
  for (const abs of absPaths) {
    if (!abs) continue
    const hit = gitIgnoreCache.get(abs)
    if (hit === true) result.add(abs)
    if (hit !== undefined) continue
    pending.push(abs)
  }
  if (pending.length === 0) return result
  const dir = cwd && existsSync(cwd) ? cwd : (pending[0] ? dirname(pending[0]) : process.cwd())
  let out = ''
  try {
    out = execFileSync(gitBin(), ['check-ignore', '--stdin'], {
      cwd: dir,
      input: pending.join('\n') + '\n',
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
  } catch (e) {
    // exit 1 = none of the paths are ignored (normal); 128 = not a repo / no git.
    out = typeof e === 'object' && e && typeof e.stdout === 'string' ? e.stdout : ''
    if (!out) {
      for (const abs of pending) {
        if (gitIgnoreCache.size >= GIT_IGNORE_CACHE_MAX) gitIgnoreCache.delete(gitIgnoreCache.keys().next().value)
        gitIgnoreCache.set(abs, false)
      }
      return result
    }
  }
  const ignored = new Set()
  for (const line of String(out).split(/\r?\n/)) {
    const p = line.trim()
    if (!p) continue
    ignored.add(p)
    // git may echo a different separator style than we sent (Windows).
    ignored.add(p.replace(/\\/g, '/'))
    ignored.add(p.replace(/\//g, '\\'))
  }
  for (const abs of pending) {
    // git echoes the path as given; match either the absolute form or its
    // tail after the cwd we ran from (git may print repo-relative paths).
    const rel = slashRel(dir, abs)
    const isIgn = ignored.has(abs)
      || ignored.has(rel)
      || ignored.has(abs.replace(/\\/g, '/'))
      || ignored.has(rel.replace(/\//g, '\\'))
    if (isIgn) result.add(abs)
    if (gitIgnoreCache.size >= GIT_IGNORE_CACHE_MAX) gitIgnoreCache.delete(gitIgnoreCache.keys().next().value)
    gitIgnoreCache.set(abs, isIgn)
  }
  return result
}

function slashRel(from, abs) {
  try {
    const rel = relative(from, abs)
    return rel.split(sep).join('/')
  } catch (e) {
    return abs
  }
}

/** One path against git's ignore rules (cached). Used by single-file endpoints. */
function isGitIgnored(absPath, cwd) {
  if (!absPath) return false
  return gitIgnoredSet([absPath], cwd).has(absPath)
}

function resetGitIgnoreCache() {
  gitIgnoreCache.clear()
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

// ── persistence: one append-only shard per session ─────────────────────────
// The first layout was a SINGLE json holding every session's every op, rewritten
// in full on each recorded change. Two things broke it: one real dev profile
// reached 167 MB (so every edit re-serialized 167 MB), and any damage to that one
// file took every session's history with it.
//
// v7 keeps one `<session>.jsonl` per session in `diff-review-state/` next to the
// old file, and every mutation is an APPEND of one line:
//
//   {"v":1,"sid":"session-abc"}                        shard header (first line)
//   {"p":"D:\\ws\\a.js","c":"D:\\ws","o":{…op…}}        one recorded op
//   {"p":"D:\\ws\\a.js","n":2}                         keep only the first 2 ops
//                                                      (n:0 = drop the file record)
//   {"t":"clear"}                                      drop everything before it
//
// A recorded edit therefore costs one small append instead of a full rewrite, a
// torn trailing line survives a crash (it is skipped), and losing or corrupting
// one shard costs exactly one session. Replay rebuilds the in-memory map and
// re-applies the MAX_OPS trim; a shard whose dead lines outgrow its live records
// is compacted once on load (atomic temp + rename).
//
// `diff-review-state.json` is still READ — once — to migrate into shards, and is
// then renamed to `<name>.migrated` so it is never consulted again.
const SHARD_DIR_NAME = 'diff-review-state'
const STATE_FILE_NAME = 'diff-review-state.json'
const SHARD_VERSION = 1
const SHARD_EXT = '.jsonl'
/** Rewrite a shard only once dead lines outgrow the live records this much. */
const SHARD_COMPACT_RATIO = 2
const SHARD_COMPACT_MIN_LINES = 64

function stateFilePath(ctx) {
  try {
    if (ctx && ctx.baseUrl) return fileURLToPath(new URL(STATE_FILE_NAME, ctx.baseUrl))
  } catch (e) {}
  try {
    return dshHomePath('profiles', 'web', STATE_FILE_NAME)
  } catch (e2) {}
  return join(process.cwd(), STATE_FILE_NAME)
}

/** Directory holding the per-session shards, next to the profile's config. */
function stateDirPath(ctx) {
  return join(dirname(stateFilePath(ctx)), SHARD_DIR_NAME)
}

/** FNV-1a as 8 hex digits — only used to keep two session ids that sanitize to the
 *  same file name apart. */
function shortHash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Shard file name for one session id. Ids are UUID-ish, but the name is
 *  sanitized anyway; when sanitizing changes the id, a hash suffix keeps two
 *  different ids off the same file. The real id also lives in the header line, so
 *  the file name never has to be reversible. */
function shardNameOf(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId : ''
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const base = safe === '' ? 'session' : safe
  return (base === raw ? base : base + '-' + shortHash(raw)) + SHARD_EXT
}

/** Append one line to a session's shard, writing the header first when the shard
 *  does not exist yet. Returns false when the write failed (read-only profile):
 *  the caller keeps serving from memory and the diag log records the loss. */
function appendShardLine(dir, sessionId, line) {
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, shardNameOf(sessionId))
    if (!existsSync(file)) appendFileSync(file, JSON.stringify({ v: SHARD_VERSION, sid: String(sessionId) }) + '\n')
    appendFileSync(file, JSON.stringify(line) + '\n')
    return true
  } catch (e) {
    return false
  }
}

function clearShard(dir, sessionId) {
  try { rmSync(join(dir, shardNameOf(sessionId)), { force: true }) } catch (e) {}
}

/** Rewrite one shard from live records (atomic: temp file + rename). Used by the
 *  migration and by the load-time compaction. */
function writeShardAtomic(dir, sessionId, files) {
  const target = join(dir, shardNameOf(sessionId))
  const tmp = target + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  const lines = [JSON.stringify({ v: SHARD_VERSION, sid: String(sessionId) })]
  for (const rec of files.values()) {
    for (const op of rec.ops) {
      // Inline full texts become blobs here (in place, so memory and disk agree), and a
      // cut side whose full text is in a blob is left out of the line entirely.
      offloadInlineSnapshots(dir, op)
      const diskOp = shrinkForShard(op)
      lines.push(JSON.stringify(rec.cwd === undefined ? { p: rec.path, o: diskOp } : { p: rec.path, c: rec.cwd, o: diskOp }))
    }
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, lines.join('\n') + '\n', 'utf8')
    renameSync(tmp, target)
    return true
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch (e2) {}
    return false
  }
}

/** Replay every shard in `dir` into `sessions`. Tolerant on purpose: an
 *  unparsable line (a torn tail after a crash, a hand-edited file) is counted and
 *  skipped instead of dropping the whole session.
 *  @returns `{ shards, records, bad, compacted }` for the diag log. */
function loadShards(sessions, dir) {
  const out = { shards: 0, records: 0, bad: 0, compacted: 0, rebuilt: 0, rebuildFailed: 0 }
  let names = []
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(SHARD_EXT)).sort()
  } catch (e) {
    return out
  }
  for (const name of names) {
    let text
    try { text = readFileSync(join(dir, name), 'utf8') } catch (e) { continue }
    let sid = null
    let lines = 0
    let ops = 0
    const files = new Map()
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (line === '') continue
      lines++
      let rec
      try { rec = JSON.parse(line) } catch (e) { out.bad++; continue }
      if (!rec || typeof rec !== 'object') { out.bad++; continue }
      if (rec.v !== undefined && rec.sid !== undefined) { sid = String(rec.sid); continue }
      if (rec.t === 'clear') { files.clear(); continue }
      const path = typeof rec.p === 'string' ? rec.p : null
      if (!path) { out.bad++; continue }
      if (typeof rec.n === 'number') {
        const entry = files.get(path)
        if (entry) {
          if (rec.n <= 0) files.delete(path)
          else {
            entry.ops = entry.ops.slice(0, rec.n)
            if (entry.ops.length === 0) files.delete(path)
          }
        }
        continue
      }
      const op = rec.o
      if (!op || typeof op !== 'object' || (op.kind !== 'edit' && op.kind !== 'write')) { out.bad++; continue }
      // A cut side whose full text is in a blob was left out of the line: rebuild it.
      const rebuilt = rebuildCutSides(op, dir)
      if (rebuilt === 'rebuilt') out.rebuilt++
      else if (rebuilt === 'failed') out.rebuildFailed++
      let entry = files.get(path)
      if (!entry) {
        entry = { path, cwd: typeof rec.c === 'string' ? rec.c : undefined, ops: [] }
        files.set(path, entry)
      }
      if (entry.ops.length >= MAX_OPS) entry.ops.shift()
      entry.ops.push(op)
      ops++
    }
    if (sid === null) { out.bad++; continue }
    out.shards++
    // Dead lines (superseded ops, drops, repeats) are what compaction removes, and
    // the in-memory map is already the compact truth, so the rewrite is exact.
    if (lines > SHARD_COMPACT_MIN_LINES && lines > ops * SHARD_COMPACT_RATIO) {
      if (writeShardAtomic(dir, sid, files)) out.compacted++
      else out.bad++
    }
    if (files.size === 0) continue
    const existing = sessions.get(sid)
    if (existing) {
      for (const [path, rec] of files) existing.set(path, rec)
    } else {
      sessions.set(sid, files)
    }
    for (const rec of files.values()) out.records += rec.ops.length
  }
  return out
}

// v6: the REAL legacy location — and the reason a fresh profile silently had no
// review history at all. Every record written before the state file became
// profile-scoped landed in `profiles/web`, the same directory `stateFilePath()`
// still names as its no-ctx fallback, while a profile that never recorded
// anything (the desktop profile) has no file of its own.
//
// This function used to return `stateFilePath(ctx)` verbatim, so the migration
// in loadStateInto could never fire (`legacy === file` always) and the desktop
// host started with an EMPTY record map. The review tab still listed the files —
// those cards are rebuilt from the session transcript — but every
// "open in VS Code at line" was refused by the path fence with
// 目标路径不在本次会话记录的文件范围内.
function legacyStateFilePath(ctx) {
  let current = null
  try {
    if (ctx && ctx.baseUrl) current = fileURLToPath(new URL(STATE_FILE_NAME, ctx.baseUrl))
  } catch (e) {}
  try {
    const legacy = dshHomePath('profiles', 'web', STATE_FILE_NAME)
    return legacy === current ? null : legacy
  } catch (e) {}
  return null
}

// Only a FOREIGN profile's single-file state is size-capped: importing it means
// parsing that blob at every start-up until a shard exists, and it would duplicate
// its disk size inside this profile. Above the bound the history stays where it is
// — the review view keeps working off the session transcript, and the path fence
// still opens those files through the workspace arms — and loadStateInto reports
// the skip so `diff-review-debug.log` explains the missing history.
//
// This profile's OWN single file is migrated (once, then renamed aside) because its
// records are what this profile's review tab shows — but not unconditionally: one real
// profile reached 159 MiB before shards existed, and reading + parsing that on the
// startup path blocks every session. Past this ceiling the file is left exactly where
// it is and reported, so it can be archived or shrunk by hand.
const LEGACY_IMPORT_MAX_BYTES = 16 * 1024 * 1024
const OWN_STATE_MIGRATE_MAX_BYTES = 64 * 1024 * 1024

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

/** Load this profile's records — shards first, then the pre-v7 single file once —
 *  and, when nothing local exists, the pre-profile-split legacy file.
 *  Returns what happened so the caller can put it in the diag log; the
 *  empty-history case used to be invisible.
 *  @returns `{ dir, file, shards, records, bad, compacted, migrated, legacy, imported, skipped }` */
function loadStateInto(sessions, ctx) {
  const file = stateFilePath(ctx)
  const dir = stateDirPath(ctx)
  const shards = loadShards(sessions, dir)
  const status = {
    dir, file, shards: shards.shards, records: 0, bad: shards.bad, compacted: shards.compacted,
    rebuilt: shards.rebuilt, rebuildFailed: shards.rebuildFailed,
    migrated: 0, legacy: null, imported: 0, skipped: null, ownTooLarge: null, offloaded: 0, adopted: 0,
    blobs: { kept: 0, removed: 0, skipped: false }
  }
  // This profile's own pre-v7 file: migrate it into shards, once, then move it out
  // of the way so a later start does not read the same records twice.
  if (sessions.size === 0 && existsSync(file)) {
    let ownSize = null
    try { ownSize = statSync(file).size } catch (e) { ownSize = null }
    if (ownSize !== null && ownSize > OWN_STATE_MIGRATE_MAX_BYTES) {
      // Left in place on purpose: deleting a user's only copy of their review history to
      // protect a startup path would be the wrong trade. The diag line names the size.
      status.ownTooLarge = ownSize
    } else {
      const single = new Map()
      loadSessions(single, file)
      let written = 0
      for (const [sid, files] of single) {
        sessions.set(sid, files)
        if (writeShardAtomic(dir, sid, files)) written++
      }
      status.migrated = written
      if (written === single.size && single.size > 0) {
        try { renameSync(file, file + '.migrated') } catch (e) {}
      }
    }
  }
  // Records from before the state file moved into each profile.
  if (sessions.size === 0) {
    const legacy = legacyStateFilePath(ctx)
    status.legacy = legacy
    // `legacy === file` only when there is no ctx at all (stateFilePath falls back
    // to the same file) — nothing to migrate then.
    if (legacy && legacy !== file) {
      let size = null
      try { size = statSync(legacy).size } catch (e) { size = null }
      if (size === null) {
        status.skipped = 'absent'
      } else if (size > LEGACY_IMPORT_MAX_BYTES) {
        status.skipped = 'too-large (' + size + ' bytes)'
      } else {
        const before = sessions.size
        const imported = new Map()
        loadSessions(imported, legacy)
        for (const [sid, files] of imported) {
          sessions.set(sid, files)
          if (writeShardAtomic(dir, sid, files)) status.imported++
        }
        if (sessions.size === before) status.imported = 0
      }
    }
  }
  // Big complete sides written before blobs existed get a reference now, so the rewrite
  // below can drop their whole copies from the shard line (that is real disk: a 105 KB
  // file cost ~210 KB per edit).
  const adopted = adoptBigSides(dir, sessions)
  // Inline full texts (the pre-blob shape) become content-addressed blobs, in place, so
  // memory and disk agree; only after that does GC know every live reference.
  const offloaded = offloadAllInline(dir, sessions)
  const touched = new Map([...adopted, ...offloaded])
  for (const [sid, files] of touched) writeShardAtomic(dir, sid, files)
  status.adopted = adopted.size
  status.offloaded = offloaded.size
  status.records = sessions.size
  // Reclaim the blobs nothing references any more. Skipped when a shard had unreadable
  // lines: those may have held references we could not see.
  status.blobs = gcBlobs(dir, sessions, { skip: shards.bad > 0 })
  return status
}

// `persistState` / `flushStateSync` — the pre-v7 whole-map save path — are gone
// with the single-file layout: every mutation appends to a shard, so there is
// nothing left to flush at exit. `serializeSessions` stays as the canonical
// snapshot shape the tests and any external tooling read.

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

// ── system fonts (for the review tab's font picker) ─────────────────────────
// A browser cannot enumerate local fonts, so the HOST does it: the review tab is
// this plugin's own surface, so "use a font I have installed" has to come from
// here. Windows is read through an exported registry key (a `.reg` file is
// UTF-16LE, which sidesteps the console code page entirely — the same export
// parsed as text would come back mojibake on a CJK Windows); Linux/macOS go
// through fontconfig, with a directory listing as the macOS fallback. A failed
// read degrades to an empty list — the picker still accepts a typed family name.
const FONT_CACHE_MS = 5 * 60 * 1000
let fontCache = null

/** Style words the Windows font registry spells out inside a family name. */
const FONT_STYLE_WORDS = ['bold italic', 'italic bold', 'bold oblique', 'oblique bold', 'extra light', 'ultra light', 'semi light', 'semi bold', 'demi bold', 'extra bold', 'ultra bold', 'bold', 'italic', 'oblique', 'regular', 'light', 'semibold', 'demibold', 'medium', 'black', 'heavy', 'thin']

/**
 * Turn one Windows font-registry value name into the family names it stands for.
 * `"Microsoft YaHei & Microsoft YaHei UI (TrueType)"` -> `['Microsoft YaHei',
 * 'Microsoft YaHei UI']`; `"Arial Bold Italic (TrueType)"` -> `['Arial']`.
 */
export function fontFamiliesFromRegistryName(name) {
  const stripped = String(name == null ? '' : name)
    .trim()
    .replace(/\s*\((?:TrueType|OpenType|All res|VGA res|PostScript[^)]*)\)\s*$/i, '')
    .trim()
  const out = []
  for (const part of stripped.split('&')) {
    let family = part.trim()
    for (;;) {
      const lower = family.toLowerCase()
      const hit = FONT_STYLE_WORDS.find((word) => lower.endsWith(' ' + word))
      if (hit === undefined) break
      family = family.slice(0, family.length - hit.length - 1).trim()
    }
    if (family) out.push(family)
  }
  return out
}

/** Parse an exported Windows font key (`reg export …`) into family names. */
export function fontFamiliesFromRegistry(text) {
  const names = []
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const match = /^"((?:[^"\\]|\\.)*)"=/.exec(line.trim())
    if (!match) continue
    for (const family of fontFamiliesFromRegistryName(match[1].replace(/\\(.)/g, '$1'))) names.push(family)
  }
  return names
}

/** Parse `fc-list : family` output (comma-separated family names per line). */
export function fontFamiliesFromFcList(text) {
  const names = []
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    for (const part of line.split(',')) {
      const name = part.trim()
      if (name) names.push(name)
    }
  }
  return names
}

/** Case-insensitive de-duplication, alphabetically ordered. */
function uniqueFonts(names) {
  const seen = new Set()
  const out = []
  for (const raw of names) {
    const name = String(raw == null ? '' : raw).trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/** Windows: the Fonts key of the machine registry, exported and read back as UTF-16LE. */
function windowsFontNames() {
  const tmp = join(tmpdir(), 'dsh-diff-review-fonts-' + process.pid + '.reg')
  try {
    execFileSync('reg', ['export', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', tmp, '/y'], { stdio: 'ignore', windowsHide: true })
    return fontFamiliesFromRegistry(readFileSync(tmp, 'utf16le'))
  } catch (e) {
    return []
  } finally {
    try { rmSync(tmp, { force: true }) } catch (e) {}
  }
}

/** Linux/macOS: fontconfig knows every installed family, localized names included. */
function fcListFontNames() {
  try {
    return fontFamiliesFromFcList(execFileSync('fc-list', [':', 'family'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch (e) {
    return []
  }
}

/** macOS without fontconfig: the system font directories, file names as families. */
function macFontNames() {
  const names = []
  for (const dir of ['/System/Library/Fonts', '/Library/Fonts', join(homedir(), 'Library/Fonts')]) {
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch (e) {
      continue
    }
    for (const entry of entries) {
      if (!/\.(ttf|otf|ttc|dfont)$/i.test(entry)) continue
      names.push(entry.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim())
    }
  }
  return names
}

/** Cached system font families plus where they came from (surfaced for diagnostics). */
function systemFonts(refresh) {
  const now = Date.now()
  if (!refresh && fontCache && now - fontCache.at < FONT_CACHE_MS) return fontCache
  let names = []
  let source = 'none'
  if (process.platform === 'win32') {
    names = windowsFontNames()
    source = 'registry'
  } else if (process.platform === 'darwin') {
    const viaFontconfig = fcListFontNames()
    if (viaFontconfig.length > 0) {
      names = viaFontconfig
      source = 'fontconfig'
    } else {
      names = macFontNames()
      source = 'files'
    }
  } else {
    names = fcListFontNames()
    source = 'fontconfig'
  }
  fontCache = { at: now, fonts: uniqueFonts(names), source }
  return fontCache
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

// v2: a path is safe to open/reveal only when it resolves inside a tree the host
// already knows. This keeps the exec-facing routes from accepting arbitrary
// browser-supplied paths. Two arms feed it — the record trees below, and the
// workspaces the user has open right now (isInsideOpenWorkspace) — and the
// verdict names the arm that let the path through so the diag log can answer
// "why was this refused/allowed" without a repro.
function withinTree(anchor, abs) {
  let rel
  try { rel = relative(resolvePath(anchor), abs) } catch (e) { return false }
  // node:path returns the TARGET untouched when the two paths share no root (a
  // different Windows drive), and that absolute string starts with neither `..`
  // nor a separator — so the old inline check read `D:\evil` as "inside
  // C:\work". Nothing can be inside a tree it has no path to.
  if (rel === '' || isAbsolute(rel)) return false
  return !rel.startsWith('..') && !rel.startsWith('.' + sep)
}

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
        if (withinTree(anchor, abs)) return true
      }
    }
  }
  return false
}

// ── the open-workspace arm of the fence ──────────────────────────────────────
// The record arm can only know the files THIS profile has recorded. That leaves
// every other card the review UI legitimately offers unopenable: a file the agent
// only read, a record pruned by MAX_OPS, a card the view rebuilt from the
// transcript of a resumed session, or a profile whose state file is empty
// (exactly what a stale/never-migrated state file produces). Clicking
// "open in VS Code at line" on such a card answered
// 目标路径不在本次会话记录的文件范围内 although the file sat inside the user's own
// project — measured on a profile whose records lived in another profile's file.
//
// The roots come from the HOST's own agent registry, never from the request, so
// the fence still means something: a caller can only name a path inside a
// directory the user actually opened in this app instance.
function openWorkspaceRoots(agentsSvc) {
  const roots = []
  try {
    const list = agentsSvc && typeof agentsSvc.list === 'function' ? agentsSvc.list() : null
    for (const agent of Array.isArray(list) ? list : []) {
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
      if (typeof cwd === 'string' && cwd !== '') roots.push(cwd)
    }
  } catch (e) {}
  return roots
}

function isInsideOpenWorkspace(agentsSvc, abs) {
  for (const root of openWorkspaceRoots(agentsSvc)) {
    if (withinTree(root, abs)) return true
  }
  return false
}

/** Workspace root of ONE session, most-live face first: the agent registry, the
 *  session store, then the persisted header.
 *
 *  A card can outlive its session state: a resumed session is not always loaded
 *  as a live Agent, and a review tab can be opened for a session this process
 *  never entered. The fence still has to place the clicked file in THAT session's
 *  workspace, so the request's session id (never a path from the request) is
 *  resolved here through the host's own faces.
 *
 *  @param ctx - plugin context.
 *  @param sessionId - session id reported by the client, or ''.
 *  @returns the session's cwd, or null when no face knows it. */
async function sessionWorkspaceRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const cwdOf = (value) => {
    if (!value) return null
    // Three shapes reach here: a live Agent ({session:{header}}), a live Session
    // ({header}), and the header itself (what readSessionHeader returns).
    const header = (value.session && value.session.header) || value.header || value
    const cwd = header && header.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : null
  }
  const service = (name) => {
    try { return ctx && typeof ctx.get === 'function' ? ctx.get(name) : null } catch (e) { return null }
  }
  try {
    const agents = service('agents')
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
    const fromAgent = cwdOf(agent)
    if (fromAgent) return fromAgent
  } catch (e) {}
  try {
    const store = service('sessions')
    const session = store && typeof store.get === 'function' ? store.get(sessionId) : null
    const fromSession = cwdOf(session)
    if (fromSession) return fromSession
  } catch (e) {}
  try {
    const registry = service('workspaceRegistry')
    if (registry && typeof registry.readSessionHeader === 'function') {
      return cwdOf(await registry.readSessionHeader(sessionId))
    }
  } catch (e) {}
  return null
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
  const stateDir = stateDirPath(ctx)
  // The resolvers (`fullSideOf`, `exactSideOf`, `revertTextOf`) read cut snapshots out
  // of the content-addressed blob dir, and they are called from view code that has no
  // ctx at hand.
  setActiveStateDir(stateDir)
  /** Unreadable shard lines seen at load: they may have held references we cannot see,
   *  so every later GC (the clear endpoint included) stands down while this is non-zero. */
  let stateLoadBad = 0
  // Logged, not silent: an empty record map is what turns "open in VS Code at
  // line" into a path-fence refusal, so the state/migration outcome has to be
  // readable from diff-review-debug.log.
  try {
    const loaded = loadStateInto(sessions, ctx)
    stateLoadBad = loaded.bad
    diag('state: dir=' + loaded.dir + ' shards=' + loaded.shards + ' records=' + loaded.records +
      (loaded.compacted ? ' compacted=' + loaded.compacted : '') +
      (loaded.bad ? ' bad-lines=' + loaded.bad : '') +
      (loaded.migrated ? ' migrated=' + loaded.migrated : '') +
      (loaded.ownTooLarge ? ' own-state-skipped=too-large (' + loaded.ownTooLarge + ' bytes)' : '') +
      ' legacy=' + (loaded.legacy || '(none)') +
      (loaded.skipped ? ' legacy-skipped=' + loaded.skipped : ' legacy-imported=' + loaded.imported) +
      (loaded.offloaded ? ' offloaded=' + loaded.offloaded : '') +
      (loaded.adopted ? ' adopted=' + loaded.adopted : '') +
      (loaded.rebuilt ? ' rebuilt=' + loaded.rebuilt : '') +
      (loaded.rebuildFailed ? ' rebuild-failed=' + loaded.rebuildFailed : '') +
      ' blobs=' + loaded.blobs.kept +
      (loaded.blobs.skipped ? ' blobs-gc=skipped' : loaded.blobs.removed ? ' blobs-gc=' + loaded.blobs.removed : ''))
  } catch (e) {
    diag('state load failed: ' + String((e && e.message) || e))
  }
  // 「中文思考」注入：默认开启，设置里可关。规则注册成 systemPrompt 的一个 section，
  // 不再写用户的 ~/.dsh/AGENTS.md —— 原因写在 ZH_THINKING_SECTION 上方的注释里。
  let zhThinkingEnabled = readPluginSettings(stateDir).zhThinking !== false
  let zhThinkingRegistered = false
  let zhThinkingError = undefined
  let zhThinkingDispose = null
  let zhThinkingScope = null
  // Host-resident review prefs: stats/diff and the file filter both need them, and
  // the client's local fallback has to agree with whatever the host just served.
  let reviewPrefs = readReviewPrefs(stateDir)
  /** Paths of one rec list that hideGitIgnored would drop; grouped so one git call
   *  covers a whole summary. Returns { keep, hidden }. */
  function filterIgnored(files) {
    const keep = []
    let hidden = 0
    if (!reviewPrefs.hideGitIgnored || !files || files.size === 0) {
      if (files) for (const rec of files.values()) keep.push(rec)
      return { keep, hidden: 0 }
    }
    // Batch per cwd: multi-root sessions each have their own repo.
    const byCwd = new Map()
    for (const rec of files.values()) {
      const cwd = rec.cwd || process.cwd()
      const abs = resolvePath(cwd, rec.path)
      if (!byCwd.has(cwd)) byCwd.set(cwd, [])
      byCwd.get(cwd).push({ rec, abs })
    }
    for (const [cwd, entries] of byCwd) {
      const ignored = gitIgnoredSet(entries.map((e) => e.abs), cwd)
      for (const e of entries) {
        if (ignored.has(e.abs)) hidden++
        else keep.push(e.rec)
      }
    }
    return { keep, hidden }
  }
  /** 重新注册/注销那个 section。prompt registry 还没就绪时调用也安全：只记录未注册。 */
  function syncZhThinking() {
    if (zhThinkingDispose) {
      try { zhThinkingDispose() } catch (e) {}
      zhThinkingDispose = null
    }
    zhThinkingRegistered = false
    zhThinkingError = undefined
    if (!zhThinkingEnabled) { diag('zh-thinking: off'); return }
    const sp = zhThinkingScope || (ctx.get && ctx.get('systemPrompt'))
    if (!sp || typeof sp.section !== 'function') {
      zhThinkingError = 'systemPrompt 服务不可用'
      diag('zh-thinking: ' + zhThinkingError + '；规则未注入')
      return
    }
    try {
      zhThinkingDispose = sp.section({
        name: ZH_THINKING_SECTION,
        order: ZH_THINKING_ORDER,
        text: ZH_THINKING_RULE,
        // 纯文本，不做变量插值：规则里万一出现 {{...}} 也不能让整次组装抛错。
        interpolate: false
      })
      zhThinkingRegistered = true
      diag('zh-thinking: section registered (' + ZH_THINKING_SECTION + ' @ ' + ZH_THINKING_ORDER + ')')
    } catch (e) {
      zhThinkingError = String((e && e.message) || e)
      diag('zh-thinking: register failed: ' + zhThinkingError)
    }
  }
  // 与下面 webServer 路由同一个道理：loader 条目并发启动，prompt registry 可能在本插件
  // apply 之后才就绪，一次性 ctx.get() 会竞态失败，所以用依赖 fiber 注册。
  ctx.inject(['systemPrompt'], (sctx) => {
    zhThinkingScope = sctx.get('systemPrompt')
    syncZhThinking()
    sctx.effect(() => () => {
      if (zhThinkingDispose) { try { zhThinkingDispose() } catch (e) {} zhThinkingDispose = null }
      zhThinkingRegistered = false
    })
  })
  // Every mutation is an APPEND of one line to the session's shard, so a recorded
  // op is durable immediately and nothing ever re-serializes the whole state (the
  // pre-v7 layout rewrote a 167 MB file per edit). A failed append is reported
  // once per apply: the session keeps working from memory, but that history will
  // not survive a restart.
  let appendFailureLogged = false
  function appendLine(sessionId, line) {
    const ok = appendShardLine(stateDir, sessionId, line)
    if (!ok && !appendFailureLogged) {
      appendFailureLogged = true
      diag('state append failed: ' + stateDir + ' (records stay in memory only)')
    }
    return ok
  }

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
      if (events) {
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

  /** Which bucket a map came from — i.e. the shard a mutation must be appended to.
   *  `bucketOf` can hand back a legacy child bucket when the root one is absent, so
   *  the map identity is the only reliable answer. */
  function bucketIdOf(files) {
    for (const [sid, map] of sessions) {
      if (map === files) return sid
    }
    return null
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

  // `str_replace_editor` is the harness's Claude-Code-style editor, and its mutations
  // belong in the same picture as write/edit: the shell's own changed-files card counts
  // `write`, `edit` and mutating `str_replace_editor` commands together. Its result is
  // only a success sentence (no {before, after}), so the pre-image has to be captured
  // BEFORE the tool runs. tools/pre-execute and tools/result receive the SAME exec object
  // — that is how dsh-tool-jobs carries an output limit across the two steps — so a
  // WeakMap keyed by it crosses the round trip with no correlation id and no leak: a call
  // whose result never arrives is collected together with the exec object.
  const sreBaseline = new WeakMap()
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (exec && (exec.tool || exec.name) === 'str_replace_editor') {
        const input = exec.input || exec.arguments || exec.args
        const command = input && input.command
        const file = input && (input.path || input.file_path)
        // `create` has no pre-image and `view` mutates nothing.
        if (file && (command === 'str_replace' || command === 'insert')) {
          try { sreBaseline.set(exec, readFileSync(file, 'utf8')) } catch (e) {}
        }
      }
    } catch (e) {}
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec) return
      const toolName = exec.tool || exec.name
      if (toolName !== 'write' && toolName !== 'edit' && toolName !== 'str_replace_editor') return
      const input = exec.input || exec.arguments || exec.args
      if (!input || typeof input !== 'object') return
      const isSre = toolName === 'str_replace_editor'
      const sreCommand = isSre ? (typeof input.command === 'string' ? input.command : '') : ''
      // `view` mutates nothing; the other three commands each rewrite the file.
      if (isSre && sreCommand !== 'create' && sreCommand !== 'str_replace' && sreCommand !== 'insert') return
      const file = isSre ? (input.path || input.file_path) : (input.file_path || input.file || input.path)
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
      // write/edit hand us {before, after} in the result; str_replace_editor returns only
      // a success sentence, so its two sides come from the pre-execute capture plus a
      // re-read now. Everything below works on these normalised fields.
      let kind = toolName
      let oldString = ''
      let newString = ''
      let content = ''
      let replaceAll = false
      let forcedLineHint = null
      let rawBefore = null
      let rawAfter = null
      let before
      let after
      let countBefore
      if (isSre) {
        const reread = () => { try { return readFileSync(file, 'utf8') } catch (e) { return null } }
        if (sreCommand === 'create') {
          kind = 'write'
          content = typeof input.file_text === 'string' ? input.file_text : ''
          rawBefore = null
          rawAfter = reread()
          before = null
          after = rawAfter === null ? undefined : cap(rawAfter)
          countBefore = ''
        } else {
          kind = 'edit'
          if (sreCommand === 'str_replace') {
            oldString = typeof input.old_str === 'string' ? input.old_str : ''
            newString = typeof input.new_str === 'string' ? input.new_str : ''
          } else {
            // `insert` carries no old_str; the new text lands after `insert_line`.
            newString = typeof input.new_str === 'string' ? input.new_str : ''
            if (Number.isInteger(input.insert_line)) forcedLineHint = Math.max(1, input.insert_line + 1)
          }
          rawBefore = sreBaseline.has(exec) ? sreBaseline.get(exec) : null
          sreBaseline.delete(exec)
          rawAfter = reread()
          // No captured pre-image means no baseline: leave `before` undefined so a revert is
          // refused rather than writing a truncated file (same rule as a cut snapshot).
          before = rawBefore === null ? undefined : cap(rawBefore)
          after = rawAfter === null ? undefined : cap(rawAfter)
          countBefore = rawBefore === null ? undefined : rawBefore
        }
      } else {
        const value = result && !result.isError && result.value && typeof result.value === 'object' ? result.value : null
        const hasBefore = value !== null && 'before' in value
        const hasAfter = value !== null && 'after' in value
        oldString = typeof input.old_string === 'string' ? input.old_string : ''
        newString = typeof input.new_string === 'string' ? input.new_string : ''
        content = typeof input.content === 'string' ? input.content : ''
        replaceAll = input.replace_all === true
        rawBefore = hasBefore && typeof value.before === 'string' ? value.before : null
        rawAfter = hasAfter && typeof value.after === 'string' ? value.after : null
        before = hasBefore ? (value.before === null ? null : cap(value.before)) : undefined
        after = hasAfter ? cap(value.after) : undefined
        countBefore = hasBefore ? (value.before === null ? '' : rawBefore) : undefined
      }
      // Only a snapshot that WAS cut by the cap is worth recording a length for:
      // it is both the "the real line cannot be recovered later" case and the
      // "reverting from it would truncate the file" case.
      const beforeLen = rawBefore !== null && typeof before === 'string' && rawBefore.length > before.length ? rawBefore.length : undefined
      const afterLen = rawAfter !== null && typeof after === 'string' && rawAfter.length > after.length ? rawAfter.length : undefined
      // The op's own line change, counted HERE from the UNTRUNCATED text. The card's
      // net diff needs both endpoint snapshots intact, and MAX_CHARS cuts those on a
      // big file — for such a range the stored per-op numbers are the only honest
      // fallback (a diff of two cut heads read `+0 −0` for a file that had changed).
      const ownCounts = opCounts({
        kind,
        oldString,
        newString,
        content,
        before: countBefore
      })
      let added = null
      if (kind === 'edit') {
        // replaceAll is what makes an edit's old_string non-unique, so it decides
        // whether a recovered line offset is the only site or just the first one.
        //
        // The offset is recovered HERE, from the UNTRUNCATED snapshot: storage caps
        // a huge file at MAX_CHARS, so a fragment past that cap can never be
        // located afterwards and the section would fall back to fragment-relative
        // numbering (3 of 727 edits in one real state file — a 200 KB Unity prefab).
        // `str_replace_editor insert` knows its own line, so it skips the search.
        const lineHint = forcedLineHint !== null ? forcedLineHint : locateFragment(rawBefore, oldString)
        const op = {
          kind: 'edit', at, turn, before, after,
          oldString: cap(oldString), newString: cap(newString),
          replaceAll
        }
        if (lineHint) op.lineHint = lineHint
        added = op
      } else {
        added = { kind: 'write', at, turn, before, after, content: cap(content) }
      }
      if (beforeLen !== undefined) added.beforeLen = beforeLen
      if (afterLen !== undefined) added.afterLen = afterLen
      added.added = ownCounts.added
      added.removed = ownCounts.removed
      packBigSides(added, rawBefore, rawAfter, stateDir)
      rec.ops.push(added)
      // One appended line, not a whole-state rewrite: this is the mutation that used
      // to re-serialize every session on every edit. `shrinkForShard` leaves a cut side
      // out of the line when its full text is in a blob (that is where the megabytes
      // were), and load rebuilds it.
      const diskOp = shrinkForShard(added)
      appendLine(rootId, rec.cwd === undefined ? { p: file, o: diskOp } : { p: file, c: rec.cwd, o: diskOp })
    } catch (e) {
      console.error('diff-review track failed', e)
    }
  })

  function buildSummary(files) {
    const { keep, hidden } = filterIgnored(files)
    const opts = { ignoreWhitespace: reviewPrefs.ignoreWhitespace }
    const items = []
    for (const rec of keep) {
      // Same net semantics as buildTurn (see statsOf) — the session ("全部修改") scope
      // diffs the file's first snapshot against its last, exactly like the shell's
      // own card does for a turn.
      const stats = statsOf(rec.ops, rec.path, opts)
      const last = rec.ops[rec.ops.length - 1]
      items.push({
        path: rec.path,
        name: String(rec.path).split('/').pop(),
        cwd: rec.cwd,
        ops: rec.ops.length,
        writes: stats.writes,
        edits: stats.edits,
        added: stats.added,
        removed: stats.removed,
        // True when the number is a sum of per-op changes rather than one exact net
        // diff (a snapshot was cut by MAX_CHARS, or the record predates snapshots).
        // The card marks those with ≈ instead of passing them off as exact.
        estimated: stats.estimated === true,
        lastTime: last ? last.at : 0
      })
    }
    items.sort((x, y) => y.lastTime - x.lastTime)
    return {
      files: items,
      latestTurn: latestWindowOf(files).latestTurn,
      hiddenIgnored: hidden,
      ignoreWhitespace: reviewPrefs.ignoreWhitespace,
      hideGitIgnored: reviewPrefs.hideGitIgnored
    }
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
        // (`lineHint`, survives the storage cap), the before snapshot — in its FULL
        // form when the stored copy was cut and the record carries the packed text —
        // and, as a last resort, the file as it is on disk right now.
        let located = null
        let lineSource = null
        if (op.lineHint && op.lineHint.line > 0) {
          located = op.lineHint
          lineSource = 'hint'
        } else {
          const fullBefore = fullSideOf(op, 'before')
          located = locateFragment(fullBefore, typeof op.oldString === 'string' ? op.oldString : '')
          if (located) lineSource = fullBefore !== op.before ? 'packed' : 'snapshot'
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
        else hunks = diffLines(oldL, newL, base, base, { ignoreWhitespace: reviewPrefs.ignoreWhitespace })
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

  // `lineCounts` / `opCounts` / `statsOf` now live at module scope (pure, and unit
  // tested there) — the card totals are the shell's semantics, not a view concern.

  function buildDetail(files, file) {
    const rec = files.get(file)
    if (!rec) return { path: file, sections: [] }
    const ops = rec.ops
    const first = ops[0]
    const opts = { ignoreWhitespace: reviewPrefs.ignoreWhitespace }
    return {
      path: file,
      sections: buildSections(ops, ops.map((_, i) => i), resolvePath(rec.cwd || process.cwd(), file)),
      // Whole-file context diff, for the hover preview's lazy path (a card whose
      // payload came from the local transcript has no host sections at all).
      preview: previewOf(ops, file, opts),
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
    const opts = { ignoreWhitespace: reviewPrefs.ignoreWhitespace }
    // Reuse the same gitignore filter the summary uses, then pick turn ops.
    const { keep } = filterIgnored(files)
    const items = []
    for (const rec of keep) {
      const indices = []
      for (let i = 0; i < rec.ops.length; i++) {
        const op = rec.ops[i]
        if (window
          ? opInLatestWindow(op, window.latestTurn, window.latestTaggedAt)
          : op.turn === turn) indices.push(i)
      }
      if (indices.length === 0) continue
      const ops = indices.map((i) => rec.ops[i])
      const stats = statsOf(ops, rec.path, opts)
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
        estimated: stats.estimated === true,
        lastTime: last ? last.at : 0,
        revertible: !!(rec.ops[0] && rec.ops[0].before !== undefined),
        sections: buildSections(rec.ops, indices, resolvePath(rec.cwd || process.cwd(), rec.path)),
        // Full-file diff with context for the hover preview: the sections above only
        // describe the fragments the model wrote.
        preview: previewOf(ops, rec.path, opts)
      })
    }
    items.sort((x, y) => y.lastTime - x.lastTime)
    return { turn: effectiveTurn, files: items, ignoreWhitespace: reviewPrefs.ignoreWhitespace }
  }

  async function doRevert(agentId, body, liveAgent) {
    try {
      // The revert tool runs inside whichever agent called it, so a subagent
      // passes its own session id while the records live under the resolved
      // root bucket — resolve the bucket the same way the review endpoints do
      // instead of reporting "no record". `liveAgent` supplies the durable
      // lineage hint (exec.agent) for the first hop.
      const files = bucketOf(agentId, liveAgent)
      // The shard a revert must be logged to is the bucket the record actually came
      // from (the root bucket for anything recorded in this layout).
      const shardId = bucketIdOf(files) || resolveRootId(agentId, liveAgent)
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
        if (unrecoverableCut(first, 'before')) {
          return { ok: false, error: '该文件的编辑前快照超过 ' + MAX_CHARS + ' 字符且未留存完整原文（旧记录），撤回会把文件截断，已拒绝' }
        }
        await applyRestore(absPath, revertTextOf(first, 'before'))
        files.delete(path)
        appendLine(shardId, { p: path, n: 0 })
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
      if (unrecoverableCut(target, 'before') || unrecoverableCut(target, 'after')) {
        return { ok: false, error: '该项修改的快照超过 ' + MAX_CHARS + ' 字符且未留存完整原文（旧记录），撤回会损坏文件，已拒绝' }
      }
      if (op === rec.ops.length - 1) {
        await applyRestore(absPath, revertTextOf(target, 'before'))
      } else {
        if (target.before === null) {
          return { ok: false, error: '该项修改新建了文件且之后还有修改，无法单独撤回' }
        }
        const base = splitLines(revertTextOf(target, 'after'))
        const ours = splitLines(await readFile(absPath, 'utf8'))
        const theirs = splitLines(revertTextOf(target, 'before'))
        if (base.length > MAX_MERGE_LINES || ours.length > MAX_MERGE_LINES || theirs.length > MAX_MERGE_LINES) {
          return { ok: false, error: '文件过大，无法单独撤回该项' }
        }
        await writeFile(absPath, merge3(base, ours, theirs).join('\n'), 'utf8')
      }
      rec.ops = rec.ops.slice(0, op)
      if (rec.ops.length === 0) files.delete(path)
      appendLine(shardId, { p: path, n: op })
      return { ok: true, mode: 'op', message: '已撤回该项修改（其后无冲突的修改已保留）' }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  /** Undo every recorded change of ONE turn. Order matters: doRevert drops the target
   *  op and everything after it (`slice(0, op)`), so walking the turn backwards keeps
   *  every index valid — the same sequence the card's 撤销 button has always built for
   *  the model to replay, now run here without spending a model turn.
   *  @param turn - a turn number, or -1 for "the latest window" (what the pill and the
   *  newest card show, including an in-flight turn's ops that carry no turn yet). */
  async function revertTurn(agentId, turn, liveAgent) {
    const files = bucketOf(agentId, liveAgent)
    if (!files || files.size === 0) return { ok: false, error: '本会话没有文件修改记录' }
    const window = turn === -1 ? latestWindowOf(files) : null
    const targets = []
    for (const rec of files.values()) {
      for (let i = 0; i < rec.ops.length; i++) {
        const op = rec.ops[i]
        const inTurn = window ? opInLatestWindow(op, window.latestTurn, window.latestTaggedAt) : op.turn === turn
        if (inTurn) targets.push({ path: rec.path, op: i, at: op.at || 0 })
      }
    }
    if (targets.length === 0) return { ok: false, error: '该轮没有文件修改' }
    targets.sort((a, b) => b.at - a.at)
    const reverted = new Set()
    const failed = []
    for (const t of targets) {
      const res = await doRevert(agentId, { path: t.path, op: t.op }, liveAgent)
      if (res.ok) reverted.add(t.path)
      else if (!failed.some((f) => f.startsWith(t.path + '：'))) failed.push(t.path + '：' + res.error)
    }
    if (reverted.size === 0) return { ok: false, error: failed[0] || '撤回失败' }
    return {
      ok: true,
      reverted: reverted.size,
      message: '已撤回第 ' + (window ? window.latestTurn : turn) + ' 轮的修改（' + reverted.size + ' 个文件）' +
        (failed.length ? '；另有 ' + failed.length + ' 项未撤回：' + failed[0] : '')
    }
  }

  // ── /review-undo: the undo path that does not need a model turn ─────────────
  // The card's 撤销 button only fills the composer with a diff_review_revert call
  // sequence; the user still has to send it and the model still has to replay it. Real
  // usage data (3 sessions, 400 ops) showed that path with zero uses, so the same undo is
  // also exposed as a first-class command. A command result is not submitted as a user
  // message, so this costs no tokens and never enters model history.
  ctx.inject(['commands'], (cctx) => {
    try {
      cctx.effect(() => cctx.commands.register({
        name: 'review-undo',
        description: '撤回本会话最近一轮的文件修改；带一个文件路径时只撤回该文件的全部修改',
        input: { hint: '[path]' },
        handler: async ({ agent, rawInput }) => {
          try {
            const sessionId = agent && agent.session && agent.session.id
            if (!sessionId) return { kind: 'error', text: '找不到当前会话' }
            const wanted = typeof rawInput === 'string' ? rawInput.trim() : ''
            if (wanted) {
              const res = await doRevert(sessionId, { path: wanted }, agent)
              return res.ok
                ? { kind: 'success', text: (res.message || '已撤回') + '：' + wanted }
                : { kind: 'error', text: res.error || '撤回失败' }
            }
            const res = await revertTurn(sessionId, -1, agent)
            return res.ok
              ? { kind: 'success', text: res.message }
              : { kind: 'error', text: res.error || '撤回失败' }
          } catch (e) {
            return { kind: 'error', text: String((e && e.message) || e) }
          }
        }
      }))
      diag('command registered: /review-undo')
    } catch (e) {
      diag('command register failed: ' + String((e && e.message) || e))
    }
  })

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
    const session = typeof body.session === 'string' ? body.session : ''
    switch (endpoint) {
      case 'summary': {
        const files = bucketOf(session)
        return buildSummary(files || new Map())
      }
      case 'file': {
        return buildDetail(bucketOf(session) || new Map(), typeof body.path === 'string' ? body.path : '')
      }
      case 'turn': {
        const files = bucketOf(session)
        const turn = Number(body.turn)
        return buildTurn(files || new Map(), Number.isFinite(turn) ? turn : -1)
      }
      case 'usage': {
        // What the records of this view take on disk: the shard plus the blobs they
        // reference. The review toolbar shows it next to the clear button.
        const rootId = session ? resolveRootId(session) : ''
        const ids = rootId && rootId !== session ? [session, rootId] : [session]
        return Object.assign({ ok: true }, sessionUsage(stateDir, ids, sessions))
      }
      case 'clear': {
        // Clear what the view is actually showing: the exact key plus the
        // resolved root bucket (and with it any legacy child bucket of this
        // session, which is what a subagent's own view would read). The shard
        // files go with the in-memory buckets, so a restart cannot resurrect them.
        clearShard(stateDir, session)
        sessions.delete(session)
        const rootId = session ? resolveRootId(session) : session
        if (rootId && rootId !== session) {
          clearShard(stateDir, rootId)
          sessions.delete(rootId)
        }
        // The shard is gone, so the blobs it referenced are orphans — collect them now
        // instead of waiting for the next start. GC only deletes what NO live session
        // references, and it leaves blobs written in the last few minutes alone (another
        // process on this profile may not have been read yet), so this is safe.
        const blobs = gcBlobs(stateDir, sessions, { skip: stateLoadBad > 0 })
        return { ok: true, blobsRemoved: blobs.removed, blobsKept: blobs.kept, blobsSkipped: blobs.skipped }
      }
      case 'revert':
        return doRevert(session, body)
      // The card's 撤销 button calls this: one turn's worth of edits undone host-side,
      // with no model turn and no composer round trip. `turn` omitted/-1 means the
      // latest window, which is what the newest card and the pill are showing.
      case 'undo-turn': {
        const turn = Number(body.turn)
        return revertTurn(session, Number.isFinite(turn) ? turn : -1, null)
      }
      case 'fonts': {
        const cache = systemFonts(body.refresh === true)
        return { fonts: cache.fonts, source: cache.source }
      }
      case 'editors':
        return { editors: detectEditors() }
      case 'open-with-editor':
        return openWithEditor(body)
      case 'reveal':
        return revealPath(body)
      case 'thinking':
        return zhThinkingStatus(zhThinkingEnabled, zhThinkingRegistered, zhThinkingError)
      case 'thinking-set': {
        const enabled = !(body.enabled === false || body.enabled === 0 || body.enabled === '0')
        const settings = readPluginSettings(stateDir)
        settings.zhThinking = enabled
        writePluginSettings(stateDir, settings)
        zhThinkingEnabled = enabled
        syncZhThinking()
        return zhThinkingStatus(enabled, zhThinkingRegistered, zhThinkingError)
      }
      case 'prefs':
        return reviewPrefs
      case 'prefs-set': {
        const next = {}
        if (typeof body.ignoreWhitespace === 'boolean') next.ignoreWhitespace = body.ignoreWhitespace
        if (typeof body.hideGitIgnored === 'boolean') next.hideGitIgnored = body.hideGitIgnored
        writeReviewPrefs(stateDir, next)
        reviewPrefs = readReviewPrefs(stateDir)
        // Gitignore rules can change on disk (a new .gitignore, a branch switch).
        // Drop the cache on every toggle so the next summary re-reads the truth.
        resetGitIgnoreCache()
        return reviewPrefs
      }
      default:
        return { ok: false, error: '未知端点: ' + endpoint }
    }
  }

  /** Which arm of the exec fence lets a path through: a recorded file tree, a
   *  workspace the user has open, or nothing at all. Named so the refusal (and
   *  the allowance) is explainable from the diag log alone.
   *
   *  The workspace arm is scoped to the session the click came from whenever that
   *  session's cwd can be resolved (live agent → session store → persisted
   *  header); the "any open workspace" fallback only runs when no face knows that
   *  session, so a caller cannot widen the fence by naming a session the host has
   *  never seen. */
  async function openFenceArm(filePath, sessionId) {
    if (typeof filePath !== 'string' || filePath === '') return null
    if (isSafeRecordedPath(sessions, filePath)) return 'record'
    let abs
    try { abs = resolvePath(filePath) } catch (e) { return null }
    let sessionRoot = null
    try { sessionRoot = await sessionWorkspaceRoot(ctx, sessionId) } catch (e) {}
    if (sessionRoot) {
      return withinTree(sessionRoot, abs) ? 'workspace-session' : null
    }
    try {
      if (isInsideOpenWorkspace(ctx.agents, abs)) return 'workspace'
    } catch (e) {}
    return null
  }

  async function openWithEditor(body) {
    const { editor, path: filePath, line, col } = body
    if (!editor || !filePath) {
      diag('open-with-editor rejected: missing editor/path ' + JSON.stringify({ editor, path: filePath }))
      return { ok: false, error: '缺少 editor 或 path 参数' }
    }
    const arm = await openFenceArm(filePath, body.session)
    if (arm === null) {
      diag('open-with-editor rejected by path fence: ' + filePath + ' (not inside any recorded file tree or open workspace)')
      return { ok: false, error: '目标路径不在本次会话记录的文件范围内' }
    }
    if (arm !== 'record') diag('open-with-editor allowed by the ' + arm + ' arm: ' + filePath)
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
    const arm = await openFenceArm(filePath, body && body.session)
    if (arm === null) {
      diag('reveal rejected by path fence: ' + filePath + ' (not inside any recorded file tree or open workspace)')
      return { ok: false, error: '目标路径不在本次会话记录的文件范围内' }
    }
    if (arm !== 'record') diag('reveal allowed by the ' + arm + ' arm: ' + filePath)
    const abs = resolvePath(filePath)
    // The official reveal first: `sessionController.openWorkspacePath({action:
    // 'reveal'})` is the same verb the shell's own "在文件管理器中显示" uses (and
    // the one the official /api/changes.open route calls), so it honours whatever
    // the host has configured per platform. The direct calls below remain the
    // fallback for a host that does not expose it.
    try {
      const sc = ctx.get && ctx.get('sessionController')
      if (sc && typeof sc.openWorkspacePath === 'function') {
        await sc.openWorkspacePath({ path: abs, action: 'reveal' })
        diag('reveal ok via sessionController: ' + abs)
        return { ok: true }
      }
    } catch (e) {
      diag('reveal via sessionController failed, falling back: ' + String((e && e.message) || e))
    }
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
  adoptBigSides, adoptSide, apply, blobIdOf, cap, collectBlobRefs,
  detectEditors, diffHunks, diffLines, exactSideOf, fullSideOf, gcBlobs, inject, isGitIgnored,
  isInsideOpenWorkspace, isLoopbackRequest, isSafeRecordedPath, latestWindowOf, launchEditor,
  loadSessions, loadShards, loadStateInto, locateFragment, merge3, name, offloadInlineSnapshots,
  opCounts, openWorkspaceRoots, opInLatestWindow, packText, previewOf, previewRowsOf, rangeRowsOf,
  readBlob, readPluginSettings, readReviewPrefs, rebuildCutSides, resetGitIgnoreCache, revertTextOf,
  serializeSessions, sessionUsage, sessionWorkspaceRoot, setActiveStateDir, settingsFilePath,
  shardNameOf, shrinkForShard, splitLines, stateDirPath, stateFilePath, statsOf, storeBlob,
  unrecoverableCut, unpackText, withinTree, writeJsonAtomicSync, writePluginSettings, writeReviewPrefs,
  wsKey, ZH_THINKING_ORDER, ZH_THINKING_RULE, ZH_THINKING_SECTION, zhThinkingStatus
}
