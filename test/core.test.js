import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, truncateSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  adoptBigSides, adoptSide, agentsFilePath, applyZhThinking, blobIdOf, cap, collectBlobRefs,
  detectEditors, diffHunks, diffLines, exactSideOf, fullSideOf, gcBlobs, isInsideOpenWorkspace,
  isSafeRecordedPath, latestWindowOf, loadSessions, loadShards, loadStateInto, merge3,
  offloadInlineSnapshots, opCounts, openWorkspaceRoots, opInLatestWindow, packText, previewRowsOf,
  readBlob, readPluginSettings, rebuildCutSides, revertTextOf, serializeSessions, sessionUsage,
  sessionWorkspaceRoot, setActiveStateDir, settingsFilePath, shardNameOf, shrinkForShard, splitLines,
  stateDirPath, statsOf, storeBlob, stripZhBlock, unrecoverableCut, unpackText, withinTree,
  writeJsonAtomicSync, writePluginSettings, ZH_THINKING_BLOCK, zhThinkingStatus
} from '../lib/index.js'

test('cap truncates at MAX_CHARS and stringifies non-strings', () => {
  assert.equal(cap('a'.repeat(130000)).length, 120000)
  assert.equal(cap('abc'), 'abc')
  assert.equal(cap(null), '')
  assert.equal(cap(42), '42')
})

test('splitLines handles empty string and trailing newline', () => {
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])
  assert.deepEqual(splitLines('a\n'), ['a', ''])
})

test('diffLines: identical inputs produce only context lines', () => {
  const out = diffLines(['a', 'b'], ['a', 'b'])
  assert.deepEqual(out, [
    { type: 'ctx', a: 1, b: 1, text: 'a' },
    { type: 'ctx', a: 2, b: 2, text: 'b' }
  ])
})

test('diffLines: pure insertion keeps line numbers coherent', () => {
  const out = diffLines(['a', 'b'], ['a', 'x', 'b'])
  assert.deepEqual(out.map((h) => [h.type, h.a, h.b]), [
    ['ctx', 1, 1],
    ['add', null, 2],
    ['ctx', 2, 3]
  ])
})

test('diffLines: pure deletion', () => {
  const out = diffLines(['a', 'x', 'b'], ['a', 'b'])
  assert.deepEqual(out.map((h) => [h.type, h.a, h.b]), [
    ['ctx', 1, 1],
    ['del', 2, null],
    ['ctx', 3, 2]
  ])
})

test('diffLines: mixed replacement groups del then add', () => {
  const out = diffLines(['a', 'b'], ['a', 'x', 'y'])
  assert.deepEqual(out.map((h) => [h.type, h.a, h.b]), [
    ['ctx', 1, 1],
    ['del', 2, null],
    ['add', null, 2],
    ['add', null, 3]
  ])
})

test('diffLines: empty old side is all-add with b line numbers', () => {
  const out = diffLines([], ['x', 'y'])
  assert.deepEqual(out.map((h) => [h.type, h.a, h.b]), [
    ['add', null, 1],
    ['add', null, 2]
  ])
})

test('diffHunks: coalesces adjacent del/add into one hunk', () => {
  const hunks = diffHunks(['a', 'b'], ['a', 'x'])
  assert.deepEqual(hunks, [{ a0: 1, a1: 2, b0: 1, b1: 2 }])
})

test('diffHunks: separates hunks by context', () => {
  const hunks = diffHunks(['a', 'c', 'b'], ['a', 'd', 'b'])
  assert.deepEqual(hunks, [{ a0: 1, a1: 2, b0: 1, b1: 2 }])
  const two = diffHunks(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'y'])
  assert.deepEqual(two, [
    { a0: 1, a1: 2, b0: 1, b1: 2 },
    { a0: 3, a1: 4, b0: 3, b1: 4 }
  ])
})

test('diffHunks: trailing append/drop', () => {
  assert.deepEqual(diffHunks(['a'], ['a', 'b']), [{ a0: 1, a1: 1, b0: 1, b1: 2 }])
  assert.deepEqual(diffHunks(['a', 'b'], ['a']), [{ a0: 1, a1: 2, b0: 1, b1: 1 }])
})

test('merge3: non-overlapping changes both apply', () => {
  const base = ['a', 'b', 'c', 'd']
  const ours = ['a', 'X', 'c', 'd'] // replaces line 2 (index 1)
  const theirs = ['a', 'b', 'c', 'Y'] // replaces line 4 (index 3)
  assert.deepEqual(merge3(base, ours, theirs), ['a', 'X', 'c', 'Y'])
})

test('merge3: insertion and deletion do not intersect', () => {
  const base = ['a', 'b', 'c']
  const ours = ['a', 'b', 'c', 'd'] // append at end
  const theirs = ['a', 'x', 'b', 'c'] // insert at 1
  assert.deepEqual(merge3(base, ours, theirs), ['a', 'x', 'b', 'c', 'd'])
})

test('merge3: overlapping change rejects', () => {
  const base = ['a', 'b', 'c']
  const ours = ['a', 'X', 'c']
  const theirs = ['a', 'Y', 'c']
  assert.throws(() => merge3(base, ours, theirs), /重叠/)
})

test('merge3: identical hunks from both sides reject', () => {
  const base = ['a', 'b']
  assert.throws(() => merge3(base, ['a', 'X'], ['a', 'X']), /重叠/)
})

test('serializeSessions round-trips and drops empty buckets', () => {
  const sessions = new Map([
    ['s1', new Map([
      ['src/a.js', { path: 'src/a.js', cwd: '/w', ops: [{ kind: 'edit', at: 1, turn: 2, oldString: 'x', newString: 'y' }] }]
    ])],
    ['s2', new Map()]
  ])
  const serialized = serializeSessions(sessions)
  assert.deepEqual(Object.keys(serialized.sessions), ['s1'])
  const restored = new Map()
  loadSessions(restored, writeTempState(serialized))
  assert.equal(restored.size, 1)
  const rec = restored.get('s1').get('src/a.js')
  assert.equal(rec.cwd, '/w')
  assert.equal(rec.ops[0].kind, 'edit')
})

test('loadSessions filters non-op records and corrupt JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drv-test-'))
  const file = join(dir, 'state.json')
  writeFileSync(file, '{"version":1,"sessions":{"s":{"files":{"f":{"ops":[{"kind":"bogus"}, {"kind":"edit", "oldString":"a","newString":"b"}]}}}}}', 'utf8')
  const sessions = new Map()
  loadSessions(sessions, file)
  assert.equal(sessions.size, 1)
  assert.equal(sessions.get('s').get('f').ops.length, 1)

  writeFileSync(file, 'not-json{{{', 'utf8')
  const s2 = new Map()
  loadSessions(s2, file)
  assert.equal(s2.size, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('writeJsonAtomicSync writes complete JSON with no temp leftovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drv-test-'))
  const file = join(dir, 'state.json')
  writeJsonAtomicSync(file, { hello: 'world', n: 1 })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { hello: 'world', n: 1 })
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
  rmSync(dir, { recursive: true, force: true })
})

test('isSafeRecordedPath accepts recorded-tree paths and rejects others', () => {
  const sessions = new Map([
    ['s1', new Map([
      ['src/a.js', { path: 'src/a.js', cwd: '/work', ops: [] }]
    ])]
  ])
  assert.equal(isSafeRecordedPath(sessions, '/work/src/a.js'), true)
  assert.equal(isSafeRecordedPath(sessions, '/work/src/sub/b.js'), true)
  assert.equal(isSafeRecordedPath(sessions, '/work'), false) // cwd root itself = false
  assert.equal(isSafeRecordedPath(sessions, '/etc/passwd'), false)
  assert.equal(isSafeRecordedPath(sessions, '/work/../etc/passwd'), false)
  assert.equal(isSafeRecordedPath(sessions, ''), false)
  assert.equal(isSafeRecordedPath(sessions, null), false)
  if (process.platform === 'win32') {
    // Relative paths on different drives come back as the TARGET itself, which
    // starts with neither `..` nor a separator: the fence used to read any other
    // drive as "inside the recorded tree".
    const otherDrive = 'C:\\Windows\\System32\\calc.exe'
    assert.equal(isSafeRecordedPath(new Map([['s', new Map([['a.js', { path: 'a.js', cwd: 'D:\\work', ops: [] }]])]]), otherDrive), false)
    assert.equal(withinTree('D:\\work', otherDrive), false)
  }
})

test('withinTree treats the anchor itself as outside and blocks `..` escapes', () => {
  const root = process.platform === 'win32' ? 'D:\\proj' : '/proj'
  const sibling = process.platform === 'win32' ? 'D:\\projx\\a.js' : '/projx/a.js'
  assert.equal(withinTree(root, join(root, 'src', 'a.js')), true)
  assert.equal(withinTree(root, root), false, 'the workspace root is a directory, not an openable file')
  assert.equal(withinTree(root, sibling), false, 'a shared prefix is not containment')
  assert.equal(withinTree(root, join(root, '..', 'other', 'a.js')), false)
  assert.equal(withinTree(root, join(root, 'src', '..', '..', 'other', 'a.js')), false)
})

test('the open-workspace arm reads roots from the host registry, never from a request', () => {
  const cwd = process.platform === 'win32' ? 'D:\\proj' : '/proj'
  const other = process.platform === 'win32' ? 'C:\\other' : '/other'
  const agents = {
    list: () => [
      { id: 'a', session: { header: { id: 'a', cwd } } },
      { id: 'b', session: { header: { id: 'b', cwd: other } } },
      { id: 'c', session: { header: { id: 'c' } } }, // no cwd: contributes nothing
      { id: 'd' } // malformed entry must not throw
    ]
  }
  assert.deepEqual(openWorkspaceRoots(agents).sort(), [cwd, other].sort())
  assert.equal(isInsideOpenWorkspace(agents, join(cwd, 'src', 'read-only.js')), true)
  assert.equal(isInsideOpenWorkspace(agents, cwd), false, 'the root itself stays out')
  assert.equal(isInsideOpenWorkspace(agents, process.platform === 'win32' ? 'C:\\Windows\\system32\\x.dll' : '/etc/passwd'), false)
  // A missing or hostile registry closes the arm instead of widening it.
  assert.equal(isInsideOpenWorkspace(null, join(cwd, 'src', 'a.js')), false)
  assert.equal(isInsideOpenWorkspace(undefined, join(cwd, 'src', 'a.js')), false)
  assert.equal(isInsideOpenWorkspace({ list: () => { throw new Error('registry down') } }, join(cwd, 'src', 'a.js')), false)
  assert.deepEqual(openWorkspaceRoots({ list: () => null }), [])
})

function writeTempState(serialized) {
  const dir = mkdtempSync(join(tmpdir(), 'drv-test-'))
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify(serialized), 'utf8')
  return file
}

test('detectEditors returns a well-formed list without throwing', () => {
  // Detects real platform commands; must not throw in any environment.
  const eds = detectEditors()
  assert.ok(Array.isArray(eds) && eds.length > 0)
  for (const ed of eds) {
    assert.equal(typeof ed.id, 'string')
    assert.equal(typeof ed.name, 'string')
    assert.equal(typeof ed.detected, 'boolean')
    assert.equal(typeof ed.openArgs, 'function')
  }
})

test('sessionWorkspaceRoot reads the host faces live-first and never throws', async () => {
  const live = { get: (n) => (n === 'agents' ? { get: () => ({ session: { header: { cwd: '/live' } } }) } : { get: () => ({ header: { cwd: '/store' } }) }) }
  assert.equal(await sessionWorkspaceRoot(live, 's'), '/live', 'the agent registry wins')
  const store = { get: (n) => (n === 'sessions' ? { get: () => ({ header: { cwd: '/store' } }) } : { readSessionHeader: async () => ({ cwd: '/stored' }) }) }
  assert.equal(await sessionWorkspaceRoot(store, 's'), '/store', 'then the session store')
  const onlyRegistry = { get: (n) => (n === 'workspaceRegistry' ? { readSessionHeader: async () => ({ cwd: '/stored' }) } : null) }
  assert.equal(await sessionWorkspaceRoot(onlyRegistry, 's'), '/stored', 'then the persisted header')
  assert.equal(await sessionWorkspaceRoot(onlyRegistry, ''), null)
  assert.equal(await sessionWorkspaceRoot(onlyRegistry, undefined), null)
  // A session with no cwd recorded must not fabricate one…
  assert.equal(await sessionWorkspaceRoot({ get: () => ({ get: () => ({ header: {} }) }) }, 's'), null)
  // …and a broken service degrades to "unknown" instead of failing the open.
  assert.equal(await sessionWorkspaceRoot({ get: () => { throw new Error('registry down') } }, 's'), null)
  assert.equal(await sessionWorkspaceRoot({ get: () => ({ readSessionHeader: async () => { throw new Error('io') } }) }, 's'), null)
})

test('shrinkForShard / rebuildCutSides: a cut side lives in its blob, not in the shard line', () => {
  // Measured on one real profile: 32 MB of a 35 MB shard was the 120k-character copies
  // of 77 cut ops, while the packed FULL texts were 0.2 MB. A blob already holds the
  // text those copies were cut from, so the line drops them and load rebuilds them.
  const dir = mkdtempSync(join(tmpdir(), 'blob-shrink-'))
  // The host sets this once at load; the revert path resolves blobs through it.
  setActiveStateDir(dir)
  const full = 'line\n'.repeat(30000) // 150k characters, so cap() cuts it
  const ref = storeBlob(dir, full)
  const op = {
    kind: 'edit', before: cap(full), after: cap(full),
    beforeLen: full.length, afterLen: full.length, fbRef: ref, faRef: ref
  }
  const thin = shrinkForShard(op)
  assert.notEqual(thin, op, 'the shard form is a copy — the live record keeps its capped text')
  assert.equal(thin.before, undefined)
  assert.equal(thin.after, undefined)
  assert.equal(thin.beforeLen, full.length, 'the length still says the side was cut')
  assert.ok(JSON.stringify(thin).length < 1000, 'the line is tiny now (it was ~240k characters)')
  assert.equal(shrinkForShard({ kind: 'edit', before: 'small', after: 'small' }).before, 'small', 'nothing to shrink → untouched')

  const replayed = { kind: 'edit', beforeLen: full.length, afterLen: full.length, fbRef: ref, faRef: ref }
  assert.equal(rebuildCutSides(replayed, dir), 'rebuilt')
  assert.equal(replayed.before.length, 120000, 'the capped copy is rebuilt, not the whole file')
  assert.equal(replayed.after.length, 120000)
  assert.equal(revertTextOf(replayed, 'before'), full, 'and the whole file is still reachable for revert')
  assert.equal(unrecoverableCut(replayed, 'before'), false)

  // A CREATE keeps `before: null` — that is semantics ("made in this session"), not a
  // snapshot, and rebuilding must never turn it into a string.
  const created = shrinkForShard({ kind: 'write', before: null, after: 'x\n', beforeLen: 0, fbRef: ref })
  assert.equal(created.before, null)
  assert.equal(rebuildCutSides({ kind: 'write', before: null, beforeLen: 0, fbRef: ref }, dir), 'none')
  assert.equal(created.after, 'x\n')

  // A blob that went missing degrades to "no snapshot of its own" (a refusal), never to
  // a truncated restore.
  const orphaned = { kind: 'edit', beforeLen: full.length, fbRef: 'deadbeefdeadbeef' }
  assert.equal(rebuildCutSides(orphaned, dir), 'failed')
  assert.equal(orphaned.before, undefined)
  assert.equal(revertTextOf(orphaned, 'before'), null)
  setActiveStateDir(null)
})

test('blobs: content-addressed, deduplicated, and GC keeps only live references', () => {
  // The edit chain gives dedup for free: one op's `after` is the next op's `before`, so
  // the same full text would otherwise be stored twice per edit.
  const dir = mkdtempSync(join(tmpdir(), 'blob-'))
  const a = 'line\n'.repeat(500)
  const b = 'other\n'.repeat(500)
  const idA = storeBlob(dir, a)
  assert.equal(storeBlob(dir, a), idA, 'the same text always maps to the same blob')
  assert.equal(blobIdOf(a), idA)
  assert.equal(readBlob(dir, idA), a, 'and reads back byte for byte')
  assert.equal(readBlob(dir, 'deadbeefdeadbeef'), null)
  const idB = storeBlob(dir, b)
  assert.equal(readdirSync(join(dir, 'blobs')).length, 2)

  // Age the orphan past the grace window (it protects a concurrently running process).
  const orphan = join(dir, 'blobs', idB + '.gz')
  utimesSync(orphan, new Date(0), new Date(0))
  const sessions = new Map([['s1', new Map([['/p/a.txt', { path: '/p/a.txt', cwd: '/p', ops: [{ kind: 'edit', fbRef: idA }] }]])]])
  assert.deepEqual([...collectBlobRefs(sessions)], [idA])

  const out = gcBlobs(dir, sessions)
  assert.equal(out.kept, 1)
  assert.equal(out.removed, 1, 'the blob nothing references is collected')
  assert.equal(existsSync(orphan), false)
  assert.equal(readBlob(dir, idA), a, 'a referenced blob survives')

  // A freshly written blob is never collected: another process may not have read it yet.
  const fresh = storeBlob(dir, 'brand new\n')
  assert.ok(fresh)
  assert.equal(gcBlobs(dir, new Map()).removed, 0, 'the grace window holds it back')

  // Unreadable shard lines mean references we could not see: GC stands down.
  const guarded = gcBlobs(dir, new Map(), { skip: true })
  assert.equal(guarded.skipped, true)
  assert.equal(guarded.removed, 0)
})

test('offloadInlineSnapshots moves an inline snapshot into a blob, in place', () => {
  // The pre-blob shape kept base64 gzip inside the shard line. A shard rewrite (load
  // compaction or migration) converts it, so old records shrink and start deduping.
  const dir = mkdtempSync(join(tmpdir(), 'blob-move-'))
  const op = { kind: 'edit', before: 'head', after: 'head', beforeLen: 999, fb: packText('the full text') }
  assert.equal(offloadInlineSnapshots(dir, op), true)
  assert.equal(op.fb, undefined, 'the inline copy is gone from memory too')
  assert.equal(typeof op.fbRef, 'string')
  assert.equal(readBlob(dir, op.fbRef), 'the full text')
  assert.equal(offloadInlineSnapshots(dir, op), false, 'a second pass has nothing to do')
  assert.equal(offloadInlineSnapshots(dir, { kind: 'edit', before: 'x', after: 'y' }), false, 'nothing inline → untouched')
})

test('packText / unpackText round-trip, and a cut side is only written back in full', () => {
  // The cap bounds MEMORY, so the untruncated text of a cut snapshot rides along
  // packed; these two helpers are what let revert and the exact totals use it.
  const big = 'a\n'.repeat(70000) + 'TARGET\n'   // > MAX_CHARS
  const packed = packText(big)
  assert.equal(typeof packed, 'string')
  assert.ok(packed.length < big.length, 'packing shrinks it')
  assert.equal(unpackText(packed), big, 'and it round-trips exactly')
  assert.equal(unpackText(undefined), null)
  assert.equal(packText(''), undefined)

  const cutHead = big.slice(0, 120000)
  const packed2 = packText(big)
  const cutOp = { kind: 'edit', before: cutHead, after: cutHead, beforeLen: big.length, afterLen: big.length, fb: packed2, fa: packed2 }
  assert.equal(revertTextOf(cutOp, 'before'), big, 'a packed cut restores the FULL text')
  assert.equal(unrecoverableCut(cutOp, 'before'), false)
  assert.equal(exactSideOf(cutOp, 'before'), big, 'and the exact path uses it too')

  const legacyCut = { kind: 'edit', before: cutHead, after: cutHead, beforeLen: big.length, afterLen: big.length }
  assert.equal(revertTextOf(legacyCut, 'before'), null, 'a cut head with nothing packed is NOT written back')
  assert.equal(unrecoverableCut(legacyCut, 'before'), true)
  assert.equal(exactSideOf(legacyCut, 'before'), null, 'and it is never diffed as if it were complete')

  const uncut = { kind: 'edit', before: 'x\ny', after: 'x\nz' }
  assert.equal(revertTextOf(uncut, 'before'), 'x\ny')
  assert.equal(exactSideOf(uncut, 'after'), 'x\nz')
  assert.equal(unrecoverableCut(uncut, 'before'), false)
  assert.equal(exactSideOf({ kind: 'write', before: null, after: 'n\n' }, 'before'), '', 'a create has an empty before')
})

test('statsOf: the card total is the range\'s net diff, never the sum of fragments', () => {
  const v1 = 'a\nb\nc\nd\ne'
  const v3 = 'a\nb\nY\nd\ne'
  const op = (over) => Object.assign({ kind: 'edit', at: 1, turn: 1, before: v1, after: v1, oldString: 'b\nc\nd', newString: 'b\nX\nd' }, over)
  const s = statsOf([op(), op({ before: v1, after: v3 })])
  assert.deepEqual([s.added, s.removed], [1, 1], 'two edits of one line are one net change')
  assert.equal(s.estimated, false)
  assert.equal(s.edits, 2, 'the activity counter still counts both ops')
})

test('statsOf: a snapshot cut by the storage cap falls back to the recorded op counts', () => {
  // Measured on a real big file: MAX_CHARS cuts the stored snapshots, and a diff of
  // two cut HEADS is meaningless (it read `+0 −0` for a file that had changed). The
  // per-op numbers — recorded from the untruncated text at write time — are summed.
  const ops = [
    { kind: 'edit', at: 1, turn: 1, before: 'cut', after: 'cut', beforeLen: 181444, oldString: 'x', newString: 'y', added: 5, removed: 2 },
    { kind: 'edit', at: 2, turn: 1, before: 'cut', after: 'cut', afterLen: 183381, oldString: 'y', newString: 'z', added: 3, removed: 1 }
  ]
  const s = statsOf(ops)
  assert.deepEqual([s.added, s.removed], [8, 3])
  assert.equal(s.estimated, true, 'the caller can tell an estimate from an exact net')
})

test('statsOf: an oversized endpoint pair is not diffed either', () => {
  const big = 'x\n'.repeat(300000) // 600k characters, over the diff budget
  const s = statsOf([{ kind: 'edit', at: 1, turn: 1, before: big, after: big, added: 2, removed: 1, oldString: '', newString: '' }])
  assert.deepEqual([s.added, s.removed], [2, 1])
  assert.equal(s.estimated, true)
})

test('statsOf: a legacy op with no counts still never counts a fragment\'s context', () => {
  const s = statsOf([{ kind: 'edit', at: 1, turn: 1, oldString: 'b\nc\nd', newString: 'b\nX\nd' }])
  assert.deepEqual([s.added, s.removed], [1, 1])
  assert.equal(s.estimated, true)
})

test('previewRowsOf: three lines of context per change, ⋯ between distant ones', () => {
  // The hover preview is a FULL-FILE diff, trimmed: the per-op sections only carry the
  // fragments the model wrote, so a one-line edit there is a bare +/− pair.
  const rows = []
  const push = (type, text) => rows.push({ type: type, a: rows.length + 1, b: rows.length + 1, text: text })
  for (let i = 0; i < 10; i++) push('ctx', 'c' + i)
  push('del', 'old')
  push('add', 'new')
  for (let i = 0; i < 20; i++) push('ctx', 'm' + i)
  push('add', 'far')
  for (let i = 0; i < 10; i++) push('ctx', 't' + i)

  const out = previewRowsOf(rows)
  assert.deepEqual(out.map((r) => r.type),
    ['ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'ctx', 'ctx', 'gap', 'ctx', 'ctx', 'ctx', 'add', 'ctx', 'ctx', 'ctx'])
  assert.deepEqual(out.slice(0, 3).map((r) => r.text), ['c7', 'c8', 'c9'], 'three lines above the first change')
  assert.equal(out.find((r) => r.type === 'gap').text, '⋯', 'the skipped middle is marked once')
  assert.deepEqual(out.slice(-3).map((r) => r.text), ['t0', 't1', 't2'], 'and three lines below the last one')
  assert.equal(out.some((r) => r.type === 'ctx' && r.text === 'c0'), false, 'far-away context is dropped')

  const small = [{ type: 'ctx', a: 1, b: 1, text: 'a' }, { type: 'add', a: null, b: 2, text: 'b' }]
  assert.deepEqual(previewRowsOf(small), small, 'a diff that already fits is untouched')
})

test('opCounts: an overwrite diffs against what it replaced, a create counts its content', () => {
  assert.deepEqual(opCounts({ kind: 'edit', oldString: 'a\nb', newString: 'a\nB' }), { added: 1, removed: 1 })
  assert.deepEqual(opCounts({ kind: 'write', before: 'a\nb\nc', content: 'a\nB\nc' }), { added: 1, removed: 1 })
  assert.deepEqual(opCounts({ kind: 'write', before: null, content: 'n1\nn2\n' }), { added: 3, removed: 0 })
  assert.deepEqual(opCounts(null), { added: 0, removed: 0 })
})

test('latestWindowOf / opInLatestWindow: newest labeled turn + newer in-flight ops only', () => {
  const files = new Map([
    ['a.js', { path: 'a.js', cwd: '/w', ops: [
      { kind: 'edit', at: 10, turn: 2 },          // older labeled turn
      { kind: 'write', at: 100, turn: 5 },        // newest labeled turn
      { kind: 'write', at: 50, turn: 0 },         // old unlabeled (cut window) — dropped
      { kind: 'edit', at: 200, turn: 0 },         // in-flight unlabeled — kept
      { kind: 'edit', at: 300, turn: undefined }  // in-flight unlabeled — kept
    ] }]
  ])
  const w = latestWindowOf(files)
  assert.deepEqual(w, { latestTurn: 5, latestTaggedAt: 100 })
  assert.equal(opInLatestWindow({ turn: 5, at: 100 }, 5, 100), true)
  assert.equal(opInLatestWindow({ turn: 0, at: 200 }, 5, 100), true)
  assert.equal(opInLatestWindow({ turn: undefined, at: 300 }, 5, 100), true)
  assert.equal(opInLatestWindow({ turn: 0, at: 50 }, 5, 100), false)
  assert.equal(opInLatestWindow({ turn: 2, at: 10 }, 5, 100), false)
})

// ── legacy state migration ───────────────────────────────────────────────────
// The state file is profile-scoped now, but every record written before that
// split landed in the `profiles/web` file. The migration that was meant to carry
// those records over compared the very same path with itself and so never ran:
// a fresh profile (the desktop one) started with an EMPTY record map while the
// review tab still listed transcript-derived cards, and the path fence refused
// every one of them with 目标路径不在本次会话记录的文件范围内.

/** Run `fn` with $DSH_HOME pointed at a throwaway home, so the legacy lookup can
 *  never touch the developer's real state file. */
function withSandboxHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'drv-home-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return fn(home)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

function sandboxProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'drv-profile-'))
  return { dir, ctx: { baseUrl: pathToFileURL(dir + '/').href } }
}

const LEGACY_RECORD = {
  version: 1,
  savedAt: 1,
  sessions: {
    'session-old': {
      files: { 'src/old.js': { path: 'src/old.js', cwd: '/oldwork', ops: [{ kind: 'write', at: 1, turn: 0, before: null, after: 'x\n' }] } }
    }
  }
}

test('a fresh profile imports the pre-split legacy state file into one shard', () => {
  withSandboxHome((home) => {
    const legacy = join(home, 'profiles', 'web', 'diff-review-state.json')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, JSON.stringify(LEGACY_RECORD), 'utf8')
    const { dir, ctx } = sandboxProfile()

    const first = new Map()
    const status = loadStateInto(first, ctx)
    assert.equal(status.legacy, legacy, 'the legacy location is the profiles/web file, not the profile file')
    assert.equal(status.dir, join(dir, 'diff-review-state'))
    assert.equal(status.imported, 1, 'the legacy session was imported')
    assert.equal(status.records, 1)
    assert.equal(status.skipped, null)
    assert.equal(first.get('session-old').get('src/old.js').cwd, '/oldwork')
    // One-shot: the import landed in a shard, so the next start reads shards only.
    assert.deepEqual(readdirSync(status.dir), [shardNameOf('session-old')])
    assert.match(readFileSync(join(status.dir, shardNameOf('session-old')), 'utf8'), /"sid":"session-old"/)

    const again = new Map()
    const second = loadStateInto(again, ctx)
    assert.equal(second.shards, 1, 'the shard is read back')
    assert.equal(second.records, 1, 'and it is authoritative afterwards')
    assert.equal(second.legacy, null, 'no legacy lookup once the profile has records')
    assert.equal(second.skipped, null)

    rmSync(dir, { recursive: true, force: true })
  })
})

test('this profile\'s own single-file state is migrated into shards and moved aside', () => {
  withSandboxHome(() => {
    const { dir, ctx } = sandboxProfile()
    const single = join(dir, 'diff-review-state.json')
    writeFileSync(single, JSON.stringify({
      version: 1,
      savedAt: 1,
      sessions: {
        'session-a': { files: { 'src/a.js': { path: 'src/a.js', cwd: '/ws', ops: [{ kind: 'edit', at: 5, turn: 2, before: 'x', after: 'y', oldString: 'x', newString: 'y' }] } } }
      }
    }), 'utf8')

    const sessions = new Map()
    const status = loadStateInto(sessions, ctx)
    assert.equal(status.migrated, 1, 'the pre-v7 file was rewritten as a shard')
    assert.equal(sessions.get('session-a').get('src/a.js').ops.length, 1)
    assert.equal(existsSync(single), false, 'the old file is out of the way')
    assert.equal(existsSync(single + '.migrated'), true, '…but kept as a backup')
    // The op survived the round trip through the shard format.
    const reread = new Map()
    loadStateInto(reread, ctx)
    assert.equal(reread.get('session-a').get('src/a.js').ops[0].oldString, 'x')

    rmSync(dir, { recursive: true, force: true })
  })
})

test('the legacy file is only imported while it stays cheap to read', () => {
  withSandboxHome((home) => {
    const legacy = join(home, 'profiles', 'web', 'diff-review-state.json')
    mkdirSync(dirname(legacy), { recursive: true })
    // Sparse: only the SIZE matters to the guard, and a foreign 167 MB dev file must
    // not be parsed at every start-up and duplicated into this profile.
    writeFileSync(legacy, '{"version":1,"sessions":{}}', 'utf8')
    truncateSync(legacy, 17 * 1024 * 1024)
    const { dir, ctx } = sandboxProfile()

    const sessions = new Map()
    const status = loadStateInto(sessions, ctx)
    assert.equal(status.records, 0)
    assert.match(String(status.skipped), /^too-large/)
    assert.equal(status.imported, 0)
    assert.equal(existsSync(join(dir, 'diff-review-state')), false, 'no shard directory was created')

    rmSync(dir, { recursive: true, force: true })
  })
})

test('a missing legacy file is reported, not guessed at', () => {
  withSandboxHome((home) => {
    const { dir, ctx } = sandboxProfile()
    const status = loadStateInto(new Map(), ctx)
    assert.equal(status.legacy, join(home, 'profiles', 'web', 'diff-review-state.json'))
    assert.equal(status.skipped, 'absent')
    assert.equal(status.records, 0)
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── the shard format itself ──────────────────────────────────────────────────
// One append-only `<session>.jsonl` per session, so a recorded edit costs one line
// instead of re-serializing every session (the pre-v7 file reached 167 MB).

/** Write a shard by hand, exactly as `appendShardLine` would. */
function writeShard(dir, lines) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, shardNameOf(lines.sid)), lines.body.join('\n') + '\n', 'utf8')
}

function op(kind, at) {
  return { kind, at, turn: 1, before: null, after: 'x\n' }
}

test('shardNameOf keeps different session ids on different, safe file names', () => {
  assert.equal(shardNameOf('session-0a00a3ef-a453'), 'session-0a00a3ef-a453.jsonl')
  const weird = shardNameOf('../../etc/passwd')
  assert.equal(/[\\/]/.test(weird), false, 'path separators cannot escape the shard directory')
  assert.equal(dirname(join('C:\\shards', weird)), 'C:\\shards', 'the file stays directly inside the shard dir')
  assert.notEqual(shardNameOf('a/b'), shardNameOf('a_b'), 'ids that sanitize alike get a hash suffix')
  assert.equal(shardNameOf('').length > 0, true)
  assert.equal(shardNameOf(null).endsWith('.jsonl'), true)
})

test('shard replay rebuilds records and re-applies the MAX_OPS trim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drv-shard-'))
  const body = ['{"v":1,"sid":"s1"}']
  for (let i = 0; i < 105; i++) body.push(JSON.stringify({ p: 'src/a.js', c: '/ws', o: { kind: 'edit', at: i, turn: 1 } }))
  writeShard(dir, { sid: 's1', body })

  const sessions = new Map()
  const info = loadShards(sessions, dir)
  assert.equal(info.shards, 1)
  assert.equal(info.bad, 0)
  const rec = sessions.get('s1').get('src/a.js')
  assert.equal(rec.ops.length, 100, 'the in-memory cap is re-applied on replay')
  assert.equal(rec.ops[0].at, 5, 'the OLDEST ops are the ones dropped')
  assert.equal(rec.cwd, '/ws')
  rmSync(dir, { recursive: true, force: true })
})

test('trim, clear and torn lines replay exactly as written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drv-shard-'))
  writeShard(dir, {
    sid: 's2',
    body: [
      '{"v":1,"sid":"s2"}',
      JSON.stringify({ p: 'a.js', o: op('write', 1) }),
      JSON.stringify({ p: 'b.js', o: op('write', 2) }),
      JSON.stringify({ p: 'a.js', o: op('edit', 3) }),
      JSON.stringify({ p: 'a.js', n: 1 }), // op-level revert: keep the first op only
      JSON.stringify({ p: 'b.js', n: 0 }), // whole-file revert: drop the record
      JSON.stringify({ p: 'c.js', o: op('write', 4) }),
      '{"p":"c.js","o":{"kind":"edit","at":5' // a torn tail (crash mid-append)
    ]
  })
  const sessions = new Map()
  const info = loadShards(sessions, dir)
  assert.equal(info.bad, 1, 'the torn line is counted, not fatal')
  const files = sessions.get('s2')
  assert.deepEqual([...files.keys()], ['a.js', 'c.js'], 'b.js was dropped by its trim line')
  assert.equal(files.get('a.js').ops.length, 1)
  assert.equal(files.get('a.js').ops[0].at, 1)
  assert.equal(files.get('c.js').ops.length, 1, 'the line after the torn one still replays')
  rmSync(dir, { recursive: true, force: true })
})

test('a clear line drops everything before it in that shard only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drv-shard-'))
  writeShard(dir, { sid: 's3', body: ['{"v":1,"sid":"s3"}', JSON.stringify({ p: 'old.js', o: op('write', 1) }), '{"t":"clear"}', JSON.stringify({ p: 'new.js', o: op('write', 2) })] })
  writeShard(dir, { sid: 's4', body: ['{"v":1,"sid":"s4"}', JSON.stringify({ p: 'other.js', o: op('write', 3) })] })
  const sessions = new Map()
  loadShards(sessions, dir)
  assert.deepEqual([...sessions.get('s3').keys()], ['new.js'])
  assert.deepEqual([...sessions.get('s4').keys()], ['other.js'], 'the other session is untouched')
  rmSync(dir, { recursive: true, force: true })
})

test('a shard whose dead lines outgrow its records is compacted once on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drv-shard-'))
  const body = ['{"v":1,"sid":"s5"}']
  for (let i = 0; i < 200; i++) {
    body.push(JSON.stringify({ p: 'big.js', o: op('write', i) }))
    body.push(JSON.stringify({ p: 'big.js', n: 1 })) // dead line: trims back to one op
  }
  writeShard(dir, { sid: 's5', body })
  const before = readFileSync(join(dir, shardNameOf('s5')), 'utf8').split('\n').length

  const sessions = new Map()
  const info = loadShards(sessions, dir)
  assert.equal(info.compacted, 1, 'the shard was rewritten')
  const after = readFileSync(join(dir, shardNameOf('s5')), 'utf8').trim().split('\n')
  assert.equal(after.length, 2, 'header + the one live op')
  assert.ok(before > 300, 'the file really did carry dead lines')
  // …and the compacted file still replays to the same records.
  const again = new Map()
  const second = loadShards(again, dir)
  assert.equal(second.compacted, 0, 'nothing left to compact')
  assert.equal(again.get('s5').get('big.js').ops.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('applyZhThinking: creates the rule, is idempotent, and never duplicates one the user wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zh-'))
  const file = join(dir, 'AGENTS.md')

  // Nothing there yet → create it with our marked paragraph.
  let res = applyZhThinking(true, file)
  assert.equal(res.ok, true)
  assert.equal(res.changed, true)
  assert.equal(res.created, true)
  assert.ok(readFileSync(file, 'utf8').includes(ZH_THINKING_BLOCK))
  assert.equal(zhThinkingStatus(true, file).injected, true)

  // Idempotent: a second run has nothing to write.
  res = applyZhThinking(true, file)
  assert.equal(res.changed, false)

  // The user already stated the same rule themselves (this profile's own file does):
  // report it and DO NOT duplicate it.
  const mine = join(dir, 'mine.md')
  writeFileSync(mine, '# 语言规则\n\n- 默认始终使用简体中文进行思考（reasoning）。\n', 'utf8')
  const before = readFileSync(mine, 'utf8')
  res = applyZhThinking(true, mine)
  assert.equal(res.alreadyPresent, true)
  assert.equal(res.changed, false)
  assert.equal(readFileSync(mine, 'utf8'), before, 'not one byte of the user file changed')

  // Other content of theirs → our paragraph is appended after it, theirs intact.
  const other = join(dir, 'other.md')
  writeFileSync(other, '# 项目规则\n\n- 用 2 空格缩进\n', 'utf8')
  res = applyZhThinking(true, other)
  assert.equal(res.changed, true)
  const withBlock = readFileSync(other, 'utf8')
  assert.ok(withBlock.startsWith('# 项目规则'), 'their content stays first')
  assert.ok(withBlock.includes('用 2 空格缩进'))
  assert.ok(withBlock.includes(ZH_THINKING_BLOCK))

  // Switching off removes exactly our paragraph.
  res = applyZhThinking(false, other)
  assert.equal(res.removed, true)
  assert.equal(readFileSync(other, 'utf8'), '# 项目规则\n\n- 用 2 空格缩进\n', 'their content survives removal')

  // A file that held nothing but our paragraph (we created it) goes away entirely.
  res = applyZhThinking(false, file)
  assert.equal(res.removed, true)
  assert.equal(existsSync(file), false)

  // A file with no paragraph of ours is not touched at all.
  const untouched = join(dir, 'keep.md')
  writeFileSync(untouched, '# 别的\n', 'utf8')
  res = applyZhThinking(false, untouched)
  assert.equal(res.changed, false)
  assert.equal(res.removed, false)
  assert.equal(readFileSync(untouched, 'utf8'), '# 别的\n')

  // stripZhBlock leaves a clean file when it removes a middle paragraph.
  const three = stripZhBlock('# a\n\n' + ZH_THINKING_BLOCK + '\n\n# b\n')
  assert.equal(three.removed, true)
  assert.equal(three.text, '# a\n\n# b\n')
  assert.equal(stripZhBlock('# a\n').removed, false)
  rmSync(dir, { recursive: true, force: true })
})

test('plugin settings round-trip next to the shards, and loadShards ignores them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zh-settings-'))
  assert.deepEqual(readPluginSettings(dir), {}, 'no file → empty settings (callers apply defaults)')
  assert.equal(writePluginSettings(dir, { zhThinking: false }), true)
  assert.equal(readPluginSettings(dir).zhThinking, false)
  assert.equal(settingsFilePath(dir), join(dir, 'settings.json'))
  // settings.json must never be mistaken for a shard.
  const sessions = new Map()
  assert.equal(loadShards(sessions, dir).shards, 0)
  assert.equal(sessions.size, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('adoptSide / adoptBigSides: big complete sides get a blob ref, cut sides never do', () => {
  // Records written before BLOB_STORE_MIN_CHARS existed kept a whole copy of every large
  // file in the shard line (a 105 KB file → ~210 KB per edit). Those copies ARE the full
  // text, so a load can hash them into blobs and drop them from the line.
  const dir = mkdtempSync(join(tmpdir(), 'blob-adopt-'))
  const big = 'line\n'.repeat(10000) // 50k characters
  const op = { kind: 'edit', before: big, after: big }
  assert.equal(adoptSide(dir, op, 'before'), true)
  assert.equal(typeof op.fbRef, 'string')
  assert.equal(readBlob(dir, op.fbRef), big)
  assert.equal(adoptSide(dir, op, 'before'), false, 'already referenced')

  assert.equal(adoptSide(dir, { kind: 'edit', before: 'tiny', after: 'tiny' }, 'before'), false, 'small sides stay inline')
  // A CUT side is not the full text: adopting it would make a restore truncate the file.
  assert.equal(adoptSide(dir, { kind: 'edit', before: big.slice(0, 120000), beforeLen: 200000 }, 'before'), false)
  // Legacy: exactly MAX_CHARS with no recorded length is treated as cut (conservative).
  assert.equal(adoptSide(dir, { kind: 'edit', before: 'x'.repeat(120000) }, 'before'), false)

  const sessions = new Map([['s1', new Map([['/p/a.txt', { path: '/p/a.txt', ops: [{ kind: 'edit', before: big, after: big }] }]])]])
  assert.deepEqual([...adoptBigSides(dir, sessions).keys()], ['s1'], 'a session with an adopted side needs a rewrite')
  const quiet = new Map([['s2', new Map([['/p/b.txt', { path: '/p/b.txt', ops: [{ kind: 'edit', before: 'x', after: 'y' }] }]])]])
  assert.equal(adoptBigSides(dir, quiet).size, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('loadStateInto adopts big complete sides in an existing shard and rewrites it smaller', () => {
  const root = mkdtempSync(join(tmpdir(), 'adopt-load-'))
  const prof = join(root, 'profiles', 'desktop')
  const sd = join(prof, 'diff-review-state')
  mkdirSync(sd, { recursive: true })
  const big = 'line\n'.repeat(12000) // 60k characters, never truncated
  const shard = join(sd, shardNameOf('s1'))
  writeFileSync(shard,
    JSON.stringify({ v: 1, sid: 's1' }) + '\n' +
    JSON.stringify({ p: 'D:/ws/big.js', c: 'D:/ws', o: { kind: 'edit', at: 1, turn: 1, before: big, after: big, oldString: 'a', newString: 'b' } }) + '\n',
    'utf8')
  const sizeBefore = statSync(shard).size

  const sessions = new Map()
  const status = loadStateInto(sessions, { baseUrl: pathToFileURL(prof + '/').href })
  assert.equal(status.adopted, 1, 'the big side was adopted on load')
  assert.ok(statSync(shard).size < sizeBefore / 2, 'and the shard shrank')
  const op = sessions.get('s1').get('D:/ws/big.js').ops[0]
  assert.equal(op.before, big, 'memory still holds the text')
  assert.equal(readBlob(sd, op.fbRef), big, 'the blob holds it too')
  rmSync(root, { recursive: true, force: true })
})

test('sessionUsage: the shard plus the blobs that session references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'))
  const sid = 's1'
  const ref = storeBlob(dir, 'x'.repeat(5000))
  const op = { kind: 'edit', at: 1, turn: 1, fbRef: ref, beforeLen: 999999 }
  writeFileSync(join(dir, shardNameOf(sid)),
    JSON.stringify({ v: 1, sid }) + '\n' + JSON.stringify({ p: 'D:/ws/a.js', o: op }) + '\n', 'utf8')
  const sessions = new Map([[sid, new Map([['D:/ws/a.js', { path: 'D:/ws/a.js', ops: [op] }]])]])

  const u = sessionUsage(dir, [sid], sessions)
  assert.ok(u.shard > 0, 'the shard file is counted')
  assert.ok(u.blobs > 0, 'and so are the blobs it points at')
  assert.equal(u.total, u.shard + u.blobs)
  assert.equal(u.blobCount, 1)
  assert.equal(u.files, 1)
  assert.equal(u.ops, 1)

  assert.equal(sessionUsage(dir, ['nope'], sessions).total, 0, 'an unknown session is 0, not a throw')
  assert.equal(sessionUsage(null, [sid], sessions).total, 0, 'no state dir → 0')

  // A blob that went missing only removes itself from the sum.
  rmSync(join(dir, 'blobs', ref + '.gz'), { force: true })
  const u2 = sessionUsage(dir, [sid], sessions)
  assert.equal(u2.blobs, 0)
  assert.ok(u2.shard > 0)
  rmSync(dir, { recursive: true, force: true })
})

test('loadShards tolerates a missing directory and unrelated files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drv-shard-'))
  assert.deepEqual(loadShards(new Map(), join(dir, 'nope')),
    { shards: 0, records: 0, bad: 0, compacted: 0, rebuilt: 0, rebuildFailed: 0 })
  writeFileSync(join(dir, 'notes.txt'), 'ignore me', 'utf8')
  const sessions = new Map()
  assert.equal(loadShards(sessions, dir).shards, 0)
  assert.equal(sessions.size, 0)
  rmSync(dir, { recursive: true, force: true })
})
