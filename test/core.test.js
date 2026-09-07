import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cap, detectEditors, diffHunks, diffLines, isSafeRecordedPath, loadSessions,
  merge3, serializeSessions, splitLines, writeJsonAtomicSync
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
