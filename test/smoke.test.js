import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { apply, isLoopbackRequest, inject, launchEditor, locateFragment } from '../lib/index.js'

/** Sandboxed profile dir per test, so flushes never touch real user data.
 *  The trailing slash matters: a backslash encodes to %5C (a plain character,
 *  not a separator), so relative URL resolution would replace the last path
 *  segment and collapse every test's state file onto one shared
 *  /tmp/diff-review-state.json across runs. */
function sandboxBaseUrl() {
  const dir = mkdtempSync(join(tmpdir(), 'drv-smoke-'))
  return { dir, url: pathToFileURL(dir + '/').href }
}
const tmpDirs = []
function track(dir) { tmpDirs.push(dir); return dir }

/** Extract one named function from the shipped client bundle for behavior tests. */
function clientFunction(name) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `client function ${name} exists`)
  const open = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  assert.notEqual(end, -1, `client function ${name} has balanced braces`)
  return new Function(`${source.slice(start, end)}; return ${name}`)()
}

/** Minimal Cordis ctx with an official-shape webServer. */
function makeCtx({ withWebServer = true } = {}) {
  const listeners = new Map()
  const disposers = []
  const routes = []
  const pendingInjections = []
  let webServerOn = withWebServer
  const agents = {
    get() { return undefined },
    list() { return [] },
    isOwnedBy() { return false },
    store: new Map()
  }
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    }
  }
  const ctx = {
    agents,
    baseUrl: sandboxBaseUrl().url,
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(cb)
      return () => {
        const arr = listeners.get(event) || []
        const i = arr.indexOf(cb)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    effect(fn) {
      const disposed = fn()
      disposers.push(typeof disposed === 'function' ? disposed : () => {})
      return () => {}
    },
    get(name) {
      if (name === 'agents') return agents
      if (name === 'webServer') return webServerOn ? webServer : undefined
      return undefined
    },
    // Cordis semantics: a dependent fiber body runs once every injected
    // service is available. Synchronous here when the service already
    // exists; queued otherwise so a test can activate it later.
    inject(names, cb) {
      if (names.every((n) => ctx.get(n) !== undefined)) cb(ctx)
      else pendingInjections.push({ names, cb })
      return { await: async () => {} }
    }
  }
  // Simulate the webServer service activating after apply (cold-boot race).
  const activateWebServer = () => {
    webServerOn = true
    for (const { names, cb } of pendingInjections.splice(0)) {
      if (names.every((n) => ctx.get(n) !== undefined)) cb(ctx)
    }
  }
  return { ctx, listeners, disposers, agents, webServer, routes, activateWebServer }
}

test.after(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch (e) {}
  }
})

test('inject declares only the hard deps (agents + base tools registry)', () => {
  assert.ok(Array.isArray(inject))
  assert.deepEqual(inject, ['agents', 'tools'])
})

test('client parser records nested run_code write/edit dispatches', () => {
  const parseReviewEvents = clientFunction('parseReviewEvents')
  const parsed = parseReviewEvents([
    { type: 'turn/start', time: 1, data: { turn: 7 } },
    { type: 'tool/call', time: 2, data: { callId: 'direct', name: 'edit', arguments: { file_path: 'direct.js', old_string: 'a', new_string: 'b' } } },
    { type: 'tool/result', time: 3, data: { callId: 'direct', message: {} } },
    { type: 'tool/code-dispatch', time: 4, data: { name: 'edit', isError: false, arguments: { file_path: 'nested.js', old_string: 'x', new_string: 'y' } } },
    { type: 'tool/code-dispatch', time: 5, data: { name: 'write', isError: false, arguments: JSON.stringify({ file_path: 'created.js', content: 'hello\n' }) } },
    { type: 'tool/code-dispatch', time: 6, data: { name: 'edit', isError: true, arguments: { file_path: 'failed.js', old_string: 'x', new_string: 'z' } } },
    // DSH renamed tool/code-dispatch to tool/ptc-dispatch (object arguments);
    // the -start twin carries no result and must be ignored.
    { type: 'tool/ptc-dispatch-start', time: 7, data: { name: 'write', arguments: { file_path: 'start-only.js', content: 'no\n' } } },
    { type: 'tool/ptc-dispatch', time: 8, data: { name: 'write', isError: false, arguments: { file_path: 'ptc.js', content: 'ptc\n' } } },
    { type: 'tool/ptc-dispatch', time: 9, data: { name: 'edit', isError: false, arguments: { file_path: 'ptc.js', old_string: 'ptc', new_string: 'ptc2' } } },
    { type: 'tool/ptc-dispatch', time: 10, data: { name: 'edit', isError: true, arguments: { file_path: 'ptc-failed.js', old_string: 'x', new_string: 'z' } } }
  ])
  const files = parsed.files

  assert.deepEqual([...files.keys()], ['direct.js', 'nested.js', 'created.js', 'ptc.js'])
  assert.equal(files.get('nested.js').ops[0].kind, 'edit')
  assert.equal(files.get('nested.js').ops[0].turn, 7)
  assert.equal(files.get('created.js').ops[0].content, 'hello\n')
  assert.equal(files.has('failed.js'), false)
  // renamed event shape: object arguments, one op per completed dispatch
  assert.equal(files.get('ptc.js').ops.length, 2)
  assert.equal(files.get('ptc.js').ops[0].content, 'ptc\n')
  assert.equal(files.get('ptc.js').ops[1].kind, 'edit')
  assert.equal(files.get('ptc.js').ops[1].turn, 7)
  // the -start twin (no result) and errored dispatch must not create records
  assert.equal(files.has('start-only.js'), false)
  assert.equal(files.has('ptc-failed.js'), false)
  // The parser also reports the newest labeled turn: an in-flight turn with no
  // write/edit yet stays distinguishable from the last turn that had edits.
  assert.equal(parsed.activeTurn, 7)
})

test('review jump predicate: applied only when turn scope + file selected + target turn payload loaded', () => {
  const jumpApplied = clientFunction('jumpApplied')
  // "全部修改" (all-scope) list active: same file/turn must NOT be skipped —
  // this is the regression where card jumps from the list mode never expanded
  assert.equal(jumpApplied('all', 'a.js', 'a.js', 3, 3), false)
  // user manually picked a different file, card click must re-apply
  assert.equal(jumpApplied('turn', 'b.js', 'a.js', 3, 3), false)
  // target turn payload not loaded yet (turnShown is another turn)
  assert.equal(jumpApplied('turn', 'a.js', 'a.js', 5, 3), false)
  // fully applied: turn scope, file selected, target turn data loaded
  assert.equal(jumpApplied('turn', 'a.js', 'a.js', 3, 3), true)
  // no jump target at all
  assert.equal(jumpApplied('turn', 'x.js', null, 3, 3), false)
})

test('revert command builder: per-op newest-first + whole-file fallback + quote escaping', () => {
  const revertCmdFor = clientFunction('revertCmdFor')
  const sections = [{ opIndex: 2 }, { kind: 'edit', opIndex: 0 }, { opIndex: 5 }]
  assert.equal(
    revertCmdFor('a"b.js', sections),
    'diff_review_revert(path="a\\"b.js", op=5) → diff_review_revert(path="a\\"b.js", op=2) → diff_review_revert(path="a\\"b.js", op=0)'
  )
  // no op indices -> whole-file fallback
  assert.equal(revertCmdFor('x.js', []), 'diff_review_revert(path="x.js")')
  assert.equal(revertCmdFor('x.js', [{ kind: 'edit' }]), 'diff_review_revert(path="x.js")')
  // no path -> no command
  assert.equal(revertCmdFor('', null), '')
})

test('focusFile: exactly one card open at a time (mutually exclusive list expansion)', () => {
  const focusFile = clientFunction('focusFile')
  // focusing a file collapses every other entry
  assert.deepEqual(focusFile({ a: true, b: true }, 'c'), { c: true })
  assert.deepEqual(focusFile({ a: true }, 'a'), { a: true })
  // collapsing (empty path) closes all
  assert.deepEqual(focusFile({ a: true }, ''), {})
  assert.deepEqual(focusFile(null, 'a'), { a: true })
  assert.deepEqual(focusFile(null, ''), {})
})

test('inLatestWindow: pill counts newest labeled turn + newer unlabeled ops only', () => {
  const inLatestWindow = clientFunction('inLatestWindow')
  // newest labeled turn ops always count
  assert.equal(inLatestWindow(3, { turn: 3, at: 100 }, 100), true)
  // unlabeled op newer than the newest labeled turn's last op: in-flight turn
  assert.equal(inLatestWindow(3, { turn: 0, at: 200 }, 100), true)
  assert.equal(inLatestWindow(3, { turn: undefined, at: 150 }, 100), true)
  // older unlabeled op (window cut inside an earlier turn): dropped
  assert.equal(inLatestWindow(3, { turn: 0, at: 50 }, 100), false)
  // older labeled turn: dropped
  assert.equal(inLatestWindow(3, { turn: 2, at: 300 }, 100), false)
})

test('inLatestWindow: a brand-new turn with no write/edit yet drops the previous turn', () => {
  const inLatestWindow = clientFunction('inLatestWindow')
  // Regression: turn 6 just started (turn/start landed, no write/edit yet) while
  // turn 5 was the last turn that edited files. Querying the pill/badge window
  // with the ACTIVE turn (6) must drop turn 5 — otherwise the running pill keeps
  // showing the previous turn's file changes in a fresh turn.
  assert.equal(inLatestWindow(6, { turn: 5, at: 999 }, 0), false)
  // ops of the active turn itself still count
  assert.equal(inLatestWindow(6, { turn: 6, at: 10 }, 10), true)
  // an unlabeled in-flight op newer than the active turn's last op still counts
  assert.equal(inLatestWindow(6, { turn: 0, at: 11 }, 10), true)
})

test('apply boots and registers the /diff-review prefix', () => {
  const { ctx, listeners, disposers, routes } = makeCtx({ withWebServer: true })
  assert.doesNotThrow(() => apply(ctx))
  const channel = routes.find((r) => r.path === '/diff-review')
  assert.ok(channel, 'prefix /diff-review registered')
  assert.equal(channel.kind, 'prefix')
  const cb = listeners.get('tools/result')?.[0]
  assert.equal(typeof cb, 'function')
  for (const d of disposers) assert.doesNotThrow(() => d())
})

test('apply boots without webServer (degraded) and still records write ops', () => {
  const { ctx, listeners, disposers, routes } = makeCtx({ withWebServer: false })
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(routes.find((r) => r.path === '/diff-review'), undefined, 'no channel without webServer')
  const cb = listeners.get('tools/result')?.[0]
  assert.equal(typeof cb, 'function')
  const exec = {
    tool: 'write',
    name: 'write',
    input: { file_path: 'src/a.txt', content: 'hello\nworld\n' },
    agent: { id: 'session-root' }
  }
  assert.doesNotThrow(() => cb(exec, { value: { before: null, after: 'hello\nworld\n' } }))
  assert.doesNotThrow(() => cb({
    tool: 'edit',
    name: 'edit',
    input: { file_path: 'src/a.txt', old_string: 'hi', new_string: 'yo' },
    agent: { id: 'session-root' }
  }, { isError: true, error: 'boom' }))
  for (const d of disposers) assert.doesNotThrow(() => d())
})

test('channel attaches when webServer activates after apply (cold-boot race)', () => {
  // Loader entries start concurrently and the web-app composition defers the
  // webserver row behind webStartup, so on a cold boot the webServer service
  // becomes active AFTER this plugin applies. The channel must still attach.
  const { ctx, listeners, disposers, routes, activateWebServer } = makeCtx({ withWebServer: false })
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(routes.find((r) => r.path === '/diff-review'), undefined, 'no route before webServer exists')
  activateWebServer()
  const channel = routes.find((r) => r.path === '/diff-review')
  assert.ok(channel, 'prefix /diff-review attached after webServer activated')
  assert.equal(channel.kind, 'prefix')
  const cb = listeners.get('tools/result')?.[0]
  assert.equal(typeof cb, 'function')
  for (const d of disposers) assert.doesNotThrow(() => d())
})

test('apply tolerates subagent owner chains via public API (isOwnedBy probe)', () => {
  const captured = []
  const disposers = []
  const { url } = sandboxBaseUrl()
  const agents = {
    get() { return undefined },
    list() { return [{ id: 'session-child', session: { id: 'session-child' } }, { id: 'session-root', session: { id: 'session-root' } }] },
    isOwnedBy(id, owner) { return id === 'session-child' && owner && owner.id === 'session-root' },
    store: new Map()
  }
  const ctx = {
    agents,
    baseUrl: url,
    on(ev, cb) { if (ev === 'tools/result') captured.push(cb); return () => {} },
    effect(fn) { const d = fn(); disposers.push(typeof d === 'function' ? d : () => {}); return () => {} },
    get(name) { return name === 'agents' ? agents : undefined },
    inject(names, cb) { return { await: async () => {} } }
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(typeof captured[0], 'function')
  assert.doesNotThrow(() => captured[0]({
    tool: 'edit',
    name: 'edit',
    input: { file_path: 'x.txt', old_string: 'a', new_string: 'b' },
    agent: { id: 'session-child' }
  }, { value: { before: 'a', after: 'b' } }))
  for (const d of disposers) assert.doesNotThrow(() => d())
})

/** ctx whose ctx.agents behaves like the real registry: id -> live Agent, with
 *  isOwnedBy() false and an empty owner field — the production shape once the
 *  runtime owner chain is gone and only the durable session header is left. */
function makeLineageCtx() {
  const h = makeCtx({ withWebServer: true })
  const live = new Map()
  h.agents.get = (id) => live.get(id)
  h.agents.list = () => [...live.values()]
  h.agents.isOwnedBy = () => false
  // A live registry entry: lookup (get/list) plus the internal store entry the
  // turn scanner reads. No `owner` — runtime ownership is what is missing.
  h.setLive = (agent) => {
    live.set(agent.id, agent)
    h.agents.store.set(agent.id, { id: agent.id, agent })
  }
  h.drop = (id) => {
    live.delete(id)
    h.agents.store.delete(id)
  }
  return h
}

/** Agent double: id + session header (+ optional snapshotEvents for turn tags). */
function agentOf(id, header, events = []) {
  return { id, session: { id, header: Object.assign({ id }, header), snapshotEvents: () => events } }
}

function recordWrite(h, agent, path, content) {
  h.listeners.get('tools/result')[0](
    { tool: 'write', name: 'write', input: { file_path: path, content }, agent },
    { value: { before: null, after: content } }
  )
}

function recordEdit(h, agent, path, oldString, newString) {
  h.listeners.get('tools/result')[0](
    { tool: 'edit', name: 'edit', input: { file_path: path, old_string: oldString, new_string: newString }, agent },
    { value: { before: oldString, after: newString } }
  )
}

/** Dispose the plugin (flushes the state synchronously) and read it back. */
function flushedState(h) {
  for (const d of h.disposers) d()
  return JSON.parse(readFileSync(new URL('diff-review-state.json', h.ctx.baseUrl), 'utf8'))
}

test('subagent writes surface in the parent session view via durable parentSession lineage', async () => {
  const h = makeLineageCtx()
  h.setLive(agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 3 } }]))
  const childId = '2b642fa0-45f2-47a5-a5d2-20a348058777'
  const child = agentOf(childId, { origin: 'subagent', parentSession: 'session-root', delegationDepth: 1 })
  // The child is NOT resolvable in the registry when its tool result is
  // dispatched — the production failure: only the Agent in hand (exec.agent)
  // carries the durable lineage, so isOwnedBy()/store can never find the parent.
  apply(h.ctx)
  recordWrite(h, child, 'src/sub.js', 'hello\n')
  const channel = h.routes.find((r) => r.path === '/diff-review')

  const summary = await rpcCall(channel, 'summary', { session: 'session-root' })
  assert.equal(rpcValue(summary).files.length, 1, 'child write shows in the parent list')
  assert.equal(rpcValue(summary).files[0].path, 'src/sub.js')
  assert.equal(rpcValue(summary).files[0].ops, 1)
  assert.equal(rpcValue(summary).files[0].writes, 1)

  // The payload the review tab renders by default (turn scope, latest window)…
  const latest = await rpcCall(channel, 'turn', { session: 'session-root', turn: -1 })
  assert.equal(rpcValue(latest).files.length, 1)
  assert.equal(rpcValue(latest).files[0].sections.length, 1)
  assert.deepEqual(rpcValue(latest).files[0].sections[0].hunks.map((x) => x.text), ['hello', ''])
  // …and when the parent's current turn is requested explicitly.
  const turn = await rpcCall(channel, 'turn', { session: 'session-root', turn: 3 })
  assert.equal(rpcValue(turn).files.length, 1, 'folded op carries the parent turn tag')

  // Expandable file content (the file endpoint used when a file is opened).
  const detail = await rpcCall(channel, 'file', { session: 'session-root', path: 'src/sub.js' })
  assert.equal(rpcValue(detail).sections.length, 1)
  assert.equal(rpcValue(detail).sections[0].hunks.length, 2)

  // No stray bucket under the bare child session id.
  assert.deepEqual(Object.keys(flushedState(h).sessions), ['session-root'])

  // The finished child is gone from the registry: its own session view still
  // resolves to the same parent bucket (learned lineage), not to an empty one.
  h.drop(childId)
  const viaDeadChild = await rpcCall(channel, 'summary', { session: childId })
  assert.equal(rpcValue(viaDeadChild).files.length, 1, 'finished child view maps to the parent bucket')
})

test('parent + subagent edits of one file stay a single record (no double counting)', async () => {
  const h = makeLineageCtx()
  const root = agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 4 } }])
  h.setLive(root)
  // Live child: the runtime-owner path and the lineage path must not both record.
  const child = agentOf('7286378f-28e7-4fde-a36a-714d424511cd', { origin: 'subagent', parentSession: 'session-root' })
  h.setLive(child)
  apply(h.ctx)
  recordEdit(h, root, 'src/dup.js', 'a', 'b')
  recordEdit(h, child, 'src/dup.js', 'b', 'c')
  const channel = h.routes.find((r) => r.path === '/diff-review')

  const summary = await rpcCall(channel, 'summary', { session: 'session-root' })
  assert.equal(rpcValue(summary).files.length, 1, 'one list entry for the file')
  assert.equal(rpcValue(summary).files[0].ops, 2, 'each op counted exactly once')
  assert.equal(rpcValue(summary).files[0].edits, 2)

  const turn = await rpcCall(channel, 'turn', { session: 'session-root', turn: 4 })
  assert.equal(rpcValue(turn).files.length, 1)
  assert.deepEqual(rpcValue(turn).files[0].sections.map((s) => s.opIndex), [0, 1])

  // A child view of a live child resolves to the same parent bucket.
  const viaChild = await rpcCall(channel, 'summary', { session: child.id })
  assert.equal(rpcValue(viaChild).files.length, 1, 'child view maps onto the root bucket')

  const state = flushedState(h)
  assert.deepEqual(Object.keys(state.sessions), ['session-root'])
  assert.equal(state.sessions['session-root'].files['src/dup.js'].ops.length, 2)
})

test('nested subagent lineage folds into the top-level root (delegation depth 2)', async () => {
  const h = makeLineageCtx()
  h.setLive(agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 2 } }]))
  h.setLive(agentOf('child-1', { origin: 'subagent', parentSession: 'session-root', delegationDepth: 1 }))
  const grand = agentOf('grand-2', { origin: 'subagent', parentSession: 'child-1', delegationDepth: 2 })
  apply(h.ctx)
  recordWrite(h, grand, 'src/deep.js', 'deep\n')
  const channel = h.routes.find((r) => r.path === '/diff-review')

  const summary = await rpcCall(channel, 'summary', { session: 'session-root' })
  assert.equal(rpcValue(summary).files.length, 1)
  assert.equal(rpcValue(summary).files[0].path, 'src/deep.js')
  const viaChild = await rpcCall(channel, 'summary', { session: 'child-1' })
  assert.equal(rpcValue(viaChild).files.length, 1, 'the middle child view resolves to the root bucket')

  assert.deepEqual(Object.keys(flushedState(h).sessions), ['session-root'])
})

test('negative: a forked session keeps its own bucket despite parentSession', async () => {
  const h = makeLineageCtx()
  h.setLive(agentOf('session-root', {}))
  const forked = agentOf('session-fork', { parentSession: 'session-root' }) // no origin: user fork
  h.setLive(forked)
  apply(h.ctx)
  recordWrite(h, forked, 'src/fork.js', 'f\n')
  const channel = h.routes.find((r) => r.path === '/diff-review')

  const own = await rpcCall(channel, 'summary', { session: 'session-fork' })
  assert.equal(rpcValue(own).files.length, 1)
  assert.equal(rpcValue(own).files[0].path, 'src/fork.js')
  const parent = await rpcCall(channel, 'summary', { session: 'session-root' })
  assert.equal(rpcValue(parent).files.length, 0, 'a fork must not leak into its source session')

  assert.deepEqual(Object.keys(flushedState(h).sessions), ['session-fork'])
})

test('revert from a subagent session resolves its id to the root bucket', async () => {
  const h = makeLineageCtx()
  h.setLive(agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 6 } }]))
  const sandboxDir = fileURLToPath(new URL('.', h.ctx.baseUrl))
  const target = join(sandboxDir, 'revert-target.txt')
  const child = agentOf('child-rev', { origin: 'subagent', parentSession: 'session-root', cwd: sandboxDir })
  h.setLive(child)
  apply(h.ctx)
  recordEdit(h, child, target, 'a', 'b') // folded into the parent bucket
  const channel = h.routes.find((r) => r.path === '/diff-review')

  // A subagent session asks to revert with its OWN session id (the id its
  // diff_review_revert tool call and its own review tab both pass).
  const resp = await rpcCall(channel, 'revert', { session: child.id, path: target, op: null })
  assert.equal(rpcValue(resp).ok, true, JSON.stringify(resp.result))
  assert.equal(readFileSync(target, 'utf8'), 'a', 'restored to the pre-edit content')
})

test('negative: direct root calls and failed subagent calls behave unchanged', async () => {
  const h = makeLineageCtx()
  const root = agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 5 } }])
  h.setLive(root)
  apply(h.ctx)
  const child = agentOf('child-9', { origin: 'subagent', parentSession: 'session-root' })
  h.listeners.get('tools/result')[0](
    { tool: 'write', name: 'write', input: { file_path: 'src/fail.js', content: 'x' }, agent: child },
    { isError: true, error: 'boom' }
  )
  recordWrite(h, root, 'root.js', 'r\n')
  const channel = h.routes.find((r) => r.path === '/diff-review')

  const summary = await rpcCall(channel, 'summary', { session: 'session-root' })
  assert.deepEqual(rpcValue(summary).files.map((f) => f.path), ['root.js'])
  const turn = await rpcCall(channel, 'turn', { session: 'session-root', turn: 5 })
  assert.equal(rpcValue(turn).files.length, 1)
  assert.equal(rpcValue(turn).files[0].path, 'root.js')
})

test('host summary adoption merges per path with the host winning (no double count)', () => {
  const adoptHostSummary = clientFunction('adoptHostSummary')
  const local = [{ path: 'local.js', ops: 1 }, { path: 'both.js', ops: 1, lastTime: 1 }]
  // The host is authoritative for every path it knows, so `both.js` appears
  // exactly once with the host's op count — and `local.js`, which the host never
  // saw (plugin loaded mid-session / cleared state), is KEPT instead of being
  // dropped by a wholesale replace.
  const host = { files: [{ path: 'sub.js', ops: 2 }, { path: 'both.js', ops: 3, lastTime: 9 }], latestTurn: 7 }
  const adopted = adoptHostSummary(host, local, 3)
  assert.equal(adopted.fromHost, true)
  assert.deepEqual(adopted.files.map((f) => f.path).sort(), ['both.js', 'local.js', 'sub.js'])
  assert.equal(adopted.files.filter((f) => f.path === 'both.js').length, 1, 'one entry per path')
  assert.equal(adopted.files.find((f) => f.path === 'both.js').ops, 3, 'the host entry wins for a shared path')
  assert.equal(adopted.files.find((f) => f.path === 'sub.js').ops, 2)
  assert.equal(adopted.files.find((f) => f.path === 'local.js').ops, 1, 'a transcript-only path survives')
  assert.equal(adopted.latestTurn, 7, 'host latestTurn wins when it is the newest')
  // A local-only file can carry the newest turn: the window cursor must not
  // move backwards because the host list is older.
  assert.equal(adoptHostSummary(host, local, 11).latestTurn, 11, 'the higher turn wins')
  // A host payload with a numeric-but-0 latestTurn still adopts the files.
  const zero = adoptHostSummary({ files: [{ path: 'x' }], latestTurn: 0 }, local, 5)
  assert.equal(zero.fromHost, true)
  assert.equal(zero.latestTurn, 5)
  // Entries without a path cannot be keyed: they are dropped from the host side
  // (they could never be rendered or expanded anyway).
  const junk = adoptHostSummary({ files: [{ ops: 1 }, { path: 'ok.js' }], latestTurn: 1 }, [], 0)
  assert.deepEqual(junk.files.map((f) => f.path), ['ok.js'])
})

test('host summary fallback: empty/failed host keeps the local list byte-for-byte', () => {
  const adoptHostSummary = clientFunction('adoptHostSummary')
  const local = [{ path: 'local.js', ops: 1 }]
  for (const host of [null, undefined, {}, { files: [] }, { files: null }, { files: 'nope' }]) {
    const adopted = adoptHostSummary(host, local, 3)
    assert.equal(adopted.fromHost, false, `no host adoption for ${JSON.stringify(host)}`)
    assert.equal(adopted.files, local, 'the local list object is kept as-is')
    assert.equal(adopted.latestTurn, 3, 'the local latestTurn is kept as-is')
  }
})

test('badge/pill: host latest-activity window wins, local window otherwise', () => {
  const hostWindowItems = clientFunction('hostWindowItems')
  const hostItems = [{ path: 'sub.js', ops: 1 }]
  // Host window has files and is not older than the active turn -> its count.
  assert.deepEqual(hostWindowItems({ turn: 4, files: hostItems }, 4), hostItems)
  assert.deepEqual(hostWindowItems({ turn: 4, files: hostItems }, 0), hostItems, 'no active turn: trust the host window')
  // Host window is the PREVIOUS turn's payload while a newer turn runs: do not
  // resurrect it (the local fixed behavior must stay).
  assert.equal(hostWindowItems({ turn: 4, files: hostItems }, 5), null)
  // No host data -> null, so the caller falls back to the local window.
  assert.equal(hostWindowItems(null, 4), null)
  assert.equal(hostWindowItems({ turn: 4, files: [] }, 4), null)
})

test("'all' expansion uses the host file endpoint whenever the list is host-adopted", () => {
  const needHostDetail = clientFunction('needHostDetail')
  const localRec = { path: 'sub.js', ops: [{}] }
  // Host-only entry (subagent file): no sections on the summary item and no
  // local record -> the hunks come from the host file endpoint.
  assert.equal(needHostDetail('all', { path: 'sub.js' }, undefined, false), true)
  // Host-adopted list, but the parent ALSO edited this file (local record
  // exists): the row counts are the host's, so the body must be too — otherwise
  // the subagent's hunk is invisible behind an "编辑×2" header.
  assert.equal(needHostDetail('all', { path: 'sub.js' }, localRec, true), true)
  // Transcript-sourced list (Desktop / older host): the local record is the
  // only source, so nothing is fetched.
  assert.equal(needHostDetail('all', { path: 'sub.js' }, localRec, false), false)
  // Payload already carries sections (turn payload) -> nothing to fetch.
  assert.equal(needHostDetail('all', { path: 'sub.js', sections: [{ hunks: [] }] }, undefined, true), false)
  // Turn scope is unchanged.
  assert.equal(needHostDetail('turn', { path: 'sub.js' }, undefined, true), false)
  assert.equal(needHostDetail('all', null, undefined, true), false)
})

test('client surfaces and the host aggregate agree on a parent+subagent file (no double count)', async () => {
  // End-to-end shape: the host records the parent op and the subagent op for
  // the SAME file into one root bucket (t3); the client must count that once
  // on every surface it drives.
  const adoptHostSummary = clientFunction('adoptHostSummary')
  const hostWindowItems = clientFunction('hostWindowItems')
  const needHostDetail = clientFunction('needHostDetail')
  const h = makeLineageCtx()
  const root = agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 4 } }])
  h.setLive(root)
  const child = agentOf('child-1', { origin: 'subagent', parentSession: 'session-root' })
  h.setLive(child)
  apply(h.ctx)
  recordEdit(h, root, 'src/dup.js', 'a', 'b')
  recordEdit(h, child, 'src/dup.js', 'b', 'c')
  const channel = h.routes.find((r) => r.path === '/diff-review')

  const hostSummary = rpcValue(await rpcCall(channel, 'summary', { session: 'session-root' }))
  const hostTurn = rpcValue(await rpcCall(channel, 'turn', { session: 'session-root', turn: -1 }))
  assert.equal(hostSummary.files.length, 1, 'host aggregates both ops into one entry')
  assert.equal(hostSummary.files[0].ops, 2)
  assert.equal(hostTurn.files.length, 1)
  assert.equal(hostTurn.files[0].ops, 2)

  // The parent's own transcript would only show ONE op (its own edit): that is
  // the local fallback the client had before this change.
  const localFiles = [{ path: 'src/dup.js', name: 'dup.js', ops: 1, writes: 0, edits: 1, added: 1, removed: 1, lastTime: 1 }]
  const adopted = adoptHostSummary(hostSummary, localFiles, 4)
  assert.equal(adopted.fromHost, true)
  assert.equal(adopted.files.length, 1)
  assert.equal(adopted.files[0].ops, 2, 'the adopted list carries the host count, once')
  assert.equal(adopted.files.some((f) => f.ops === 1), false, 'the local (partial) entry is not merged in')

  const hostItems = hostWindowItems({ turn: hostTurn.turn, files: hostTurn.files }, 4)
  assert.equal(hostItems.length, 1)
  assert.equal(hostItems[0].ops, 2, 'badge/pill window counts the same op set')
  // All-scope expansion: the file has no local record -> host file endpoint.
  assert.equal(needHostDetail('all', adopted.files[0], undefined), true)
  const detail = rpcValue(await rpcCall(channel, 'file', { session: 'session-root', path: 'src/dup.js' }))
  assert.equal(detail.sections.length, 2, 'expanding the host-only entry yields both hunks')
})

/** Minimal React double with per-component hook slots, enough to run the real
 *  client bundle in a VM: function components render to plain element trees. */
function makeReactDouble() {
  const hooks = new Map()
  let comp = null
  let idx = 0
  const slot = (fn) => {
    let s = hooks.get(fn)
    if (!s) { s = { states: [], deps: [] }; hooks.set(fn, s) }
    return s
  }
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter((c) => c != null) }),
    useState: (init) => {
      const s = slot(comp)
      const i = idx++
      if (!(i in s.states)) s.states[i] = typeof init === 'function' ? init() : init
      // The setter must write back into the slot: the live store notifies
      // subscribers via setV, and the next render reads the fresh value.
      const setV = (v) => { s.states[i] = typeof v === 'function' ? v(s.states[i]) : v }
      return [s.states[i], setV]
    },
    useEffect: (fn, deps) => {
      const s = slot(comp)
      const i = idx++
      const prev = s.deps[i]
      const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]))
      s.deps[i] = deps ? [...deps] : undefined
      if (changed) fn()
    },
    useRef: (v) => {
      const s = slot(comp)
      const i = idx++
      if (!('ref' + i in s.states)) s.states['ref' + i] = { current: v }
      return s.states['ref' + i]
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    Fragment: 'Fragment',
    beginRender(type) { comp = type; idx = 0 },
    endRender(prev) { comp = prev }
  }
}

/** Load the REAL shipped client bundle and boot its plugin wiring against a
 *  stub connection, so tests can drive rebuildReview -> store -> the actual
 *  TabLabel / ReviewView components instead of re-implementing them. */
function loadRealClient(rpc, opts = {}) {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const React = makeReactDouble()
  let exports = null
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    // A remembered editor choice is how the real UI persists it; seeding it makes
    // open-at-line reach the host's open-with-editor route instead of the
    // workspace fallback (which cannot position a cursor).
    localStorage: {
      getItem: (k) => (opts.editor && k === 'dsh.diff-review.editor' ? JSON.stringify(opts.editor) : null),
      setItem() {}, removeItem() {}
    },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController, URL, RegExp,
    document: {
      createElement: () => ({ textContent: '', remove() {} }),
      head: { appendChild() {} },
      body: { addEventListener() {}, removeEventListener() {} },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    },
    requestAnimationFrame: (fn) => fn()
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.__ModuleLoader__ = {
    load(mod) {
      exports = mod.factory((name) => {
        if (name === 'react') return React
        // The shell seeds @deepseek-ai/dsh-client-ui-primitives as a static module; a
        // test can hand in a stub to prove the plugin uses the shell's own file marks.
        if (name === '@deepseek-ai/dsh-client-ui-primitives' && opts.primitives) return opts.primitives
        throw new Error('unexpected client require: ' + name)
      })
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)

  const calls = []
  const registered = []
  const conn = { rpc: { call: (target, endpoint, payload) => { calls.push({ endpoint, payload }); return rpc(endpoint, payload) } } }
  // `sessionsById` drives updateRunning(): the running pill only renders while the
  // session reports running, so a test that clicks it has to say so.
  const sessionsSvc = { list: { getSnapshot: () => ({ byId: opts.sessionsById || {} }) } }
  // The host registry enforces one contract per slot kind
  // (@deepseek-ai/dsh-client-ui-slots register): a `list` slot THROWS when the
  // registration carries no `id`. Mirroring that here is what catches a
  // registration that silently stops rendering when a host generation changes the
  // slot's kind (0.1.6 turned conversation.chat.turnTail from chain into list).
  const listSlots = new Set(['conversation.chat.turnTail', 'conversation.composer.dock'])
  exports.apply({
    get: (n) => (n === 'connection' ? conn : n === 'sessions' ? sessionsSvc : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') d(); return () => {} },
    slots: {
      inject: (n, cb) => { cb() },
      register: (def, Comp) => {
        if (listSlots.has(def.name) && def.id === undefined) throw new Error(`list slot "${def.name}" requires options.id`)
        registered.push({ def, Comp })
        return () => {}
      }
    },
    sessions: sessionsSvc,
    workspaces: opts.workspaces || {}
  })
  const slotComp = (name, id) => registered.find((r) => r.def.name === name && (id === undefined || r.def.id === id))
  const render = (el) => {
    if (!el || typeof el !== 'object' || typeof el.type !== 'function') return el
    const prev = null
    React.beginRender(el.type)
    const out = el.type(el.props)
    React.endRender(prev)
    return render(out)
  }
  const collect = (tree, cls, out = []) => {
    if (!tree || typeof tree !== 'object') return out
    if (tree.props && typeof tree.props.className === 'string' && tree.props.className.split(' ').includes(cls)) out.push(tree)
    for (const ch of tree.children || []) collect(ch, cls, out)
    return out
  }
  return { calls, registered, slotComp, render, collect }
}

test('client bundle wiring: host data drives badge + list, empty host falls back to the local parse', async () => {
  const LOCAL_EVENTS = [
    { seq: 1, type: 'turn/start', time: 1, data: { turn: 7 } },
    { seq: 2, type: 'tool/call', time: 2, data: { callId: 'c1', name: 'edit', arguments: { file_path: 'local-only.js', old_string: 'a', new_string: 'b' } } },
    { seq: 3, type: 'tool/result', time: 3, data: { callId: 'c1', message: {} } },
    // The parent also edited sub-1.js; the host aggregates that op with the
    // subagent's into one entry (2 ops) — the client must show ONE row.
    { seq: 4, type: 'tool/call', time: 4, data: { callId: 'c2', name: 'edit', arguments: { file_path: 'sub-1.js', old_string: 'a', new_string: 'b' } } },
    { seq: 5, type: 'tool/result', time: 5, data: { callId: 'c2', message: {} } }
  ]
  const sub = (n) => ({ path: `sub-${n}.js`, name: `sub-${n}.js`, ops: 2, writes: 1, edits: 1, added: 5, removed: 1, lastTime: 9 + n })
  const settle = () => new Promise((r) => setTimeout(r, 60))
  // `envelope` = the official Web transport shape: rpc.call resolves with the
  // parsed RPC result { ok: true, value } (client.js unwraps it). Without it the
  // stub returns a bare payload, i.e. the Desktop bridge / older host face.
  const boot = async (hostFiles, turnFiles, envelope) => {
    const wrap = (v) => (envelope ? { ok: true, value: v } : v)
    const c = loadRealClient(async (endpoint, payload) => {
      if (endpoint === 'editors') return wrap({ editors: [] })
      if (endpoint === 'summary') return wrap({ files: hostFiles, latestTurn: 7 })
      if (endpoint === 'turn') return wrap({ turn: 7, files: turnFiles })
      if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', projections: { asOfSeq: 5 } }] } } }
      if (endpoint === 'session/page') return { result: { ok: true, value: { records: LOCAL_EVENTS.map((e) => ({ event: e })) } } }
      return {}
    })
    c.render(c.slotComp('conversation.session.header.actions').Comp({ sessionId: 'session-root' }))
    await settle()
    const view = c.slotComp('conversation.view', 'review')
    // render -> settle passes: the stub runs effects during render and the
    // async host loads resolve between passes.
    let tree = null
    for (let i = 0; i < 5; i++) {
      tree = c.render(view.Comp({ sessionId: 'session-root' }))
      await settle()
    }
    const badge = c.collect(c.render(view.def.label()), 'drv-tab-badge')[0]
    // The session-wide list lives in the 'all' ("全部修改") scope; the default
    // turn scope shows only the requested turn's payload.
    const select = c.collect(tree, 'cdx-turn-select')[0]
    let allTitles = []
    if (select) {
      select.props.onChange({ target: { value: 'all' } })
      allTitles = c.collect(c.render(view.Comp({ sessionId: 'session-root' })), 'cdx-fl-item').map((r) => r.props.title)
    }
    return { c, tree, badge: badge && badge.children[0], allTitles }
  }

  // 3 host files, one of which the parent also touched, plus a transcript-only
  // path the host never saw. Union per path: 4 rows, never a duplicate row, and
  // the badge is the same number the panel shows.
  const host = await boot([sub(1), sub(2), sub(3)], [sub(1), sub(2), sub(3)])
  assert.deepEqual(host.c.collect(host.tree, 'cdx-fl-item').map((r) => r.props.title), ['sub-1.js', 'sub-2.js', 'sub-3.js'], 'turn scope shows the turn payload')
  assert.equal(host.allTitles.filter((t) => t === 'sub-1.js').length, 1, 'a parent+subagent file is one row, not two')
  assert.deepEqual(host.allTitles.slice().sort(), ['local-only.js', 'sub-1.js', 'sub-2.js', 'sub-3.js'], 'host rows win per path; a transcript-only path is kept')
  assert.equal(host.badge, '4', 'badge === list length (the tab and the panel agree)')
  assert.equal(host.c.calls.some((x) => x.endpoint === 'summary'), true, 'the existing summary endpoint is used')

  // Same expectations through the OFFICIAL Web transport face, where rpc.call
  // resolves with { ok: true, value } — the production shape that the original
  // bare-payload bug hid. This is the envelope integration the fix relies on.
  const enveloped = await boot([sub(1), sub(2), sub(3)], [sub(1), sub(2), sub(3)], true)
  assert.equal(enveloped.badge, host.badge, 'badge identical when the transport returns the official envelope')
  assert.deepEqual(enveloped.allTitles.slice().sort(), host.allTitles.slice().sort(), 'list identical with the official envelope')

  // Host empty -> the local parse only (behavior identical to before): the
  // transcript's two files are both in the latest turn, so the badge is 2.
  const local = await boot([], [])
  assert.equal(local.badge, '2', 'badge falls back to the local window')
  assert.deepEqual(local.allTitles.slice().sort(), ['local-only.js', 'sub-1.js'], 'list is the local parse')
})

test("client 'all' scope expands a parent+subagent file from the host (both hunks)", async () => {
  // Regression: the file is in BOTH the transcript (the parent's own op) and the
  // host aggregate (parent + subagent = 2 ops). The row header shows the host
  // count, so the body must come from the host too — the transcript alone would
  // render just one hunk behind an "编辑×2" header.
  const dup = { path: 'src/dup.js', name: 'dup.js', ops: 2, writes: 0, edits: 2, added: 2, removed: 2, lastTime: 9 }
  const LOCAL = [
    { seq: 1, type: 'turn/start', time: 1, data: { turn: 7 } },
    { seq: 2, type: 'tool/call', time: 2, data: { callId: 'c1', name: 'edit', arguments: { file_path: 'src/dup.js', old_string: 'a', new_string: 'b' } } },
    { seq: 3, type: 'tool/result', time: 3, data: { callId: 'c1', message: {} } }
  ]
  const c = loadRealClient(async (endpoint, payload) => {
    if (endpoint === 'editors') return { editors: [] }
    if (endpoint === 'summary') return { files: [dup], latestTurn: 7 }
    if (endpoint === 'turn') return { turn: 7, files: [dup] }
    if (endpoint === 'file') {
      if (payload.path !== 'src/dup.js') return { path: payload.path, sections: [] }
      return { path: payload.path, sections: [
        { kind: 'edit', at: 1, hunks: [{ type: 'add', a: null, b: 1, text: 'parent' }] },
        { kind: 'edit', at: 2, hunks: [{ type: 'add', a: null, b: 2, text: 'subagent' }] }
      ] }
    }
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', projections: { asOfSeq: 3 } }] } } }
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: LOCAL.map((e) => ({ event: e })) } } }
    return {}
  })
  c.render(c.slotComp('conversation.session.header.actions').Comp({ sessionId: 'session-root' }))
  await new Promise((r) => setTimeout(r, 40))
  const view = c.slotComp('conversation.view', 'review')
  let tree = c.render(view.Comp({ sessionId: 'session-root' }))
  await new Promise((r) => setTimeout(r, 40))
  tree = c.render(view.Comp({ sessionId: 'session-root' }))
  const select = c.collect(tree, 'cdx-turn-select')[0]
  assert.ok(select, 'turn/scope switcher rendered')
  select.props.onChange({ target: { value: 'all' } }) // "全部修改"
  tree = c.render(view.Comp({ sessionId: 'session-root' }))
  const rows = c.collect(tree, 'cdx-fl-item')
  assert.deepEqual(rows.map((r) => r.props.title), ['src/dup.js'], 'the host entry is listed once')

  rows[0].props.onClick() // select the file in the detail pane
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(c.calls.some((x) => x.endpoint === 'file' && x.payload.path === 'src/dup.js'), true, 'the host file endpoint was used despite the local record')
  tree = c.render(view.Comp({ sessionId: 'session-root' }))
  assert.equal(c.collect(tree, 'cdx-sec').length, 2, 'both the parent hunk and the subagent hunk render')
  // CodexLine is a nested component (not expanded by the render double), so the
  // hunk payloads are read off the elements themselves.
  const hunks = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (node.props && node.props.h && typeof node.props.h.text === 'string') out.push(node.props.h.text)
    for (const ch of node.children || []) hunks(ch, out)
    return out
  }
  const texts = hunks(tree)
  assert.equal(texts.includes('subagent'), true, 'the subagent hunk is visible')
  assert.equal(texts.includes('parent'), true, 'the parent hunk is visible')
})

test("client 'all' scope: expanding a host-only file goes through the file endpoint", async () => {
  const sub = { path: 'sub-only.js', name: 'sub-only.js', ops: 2, writes: 1, edits: 1, added: 5, removed: 1, lastTime: 9 }
  // Host summary has the subagent file; the host turn window and the parent
  // transcript have nothing, so only the 'all' list can show it.
  const c = loadRealClient(async (endpoint, payload) => {
    if (endpoint === 'editors') return { editors: [] }
    if (endpoint === 'summary') return { files: [sub], latestTurn: 7 }
    if (endpoint === 'turn') return { turn: 7, files: [] }
    if (endpoint === 'file') return { path: payload.path, sections: [{ kind: 'write', at: 1, hunks: [{ type: 'add', a: null, b: 1, text: 'from-host' }] }] }
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', projections: { asOfSeq: 3 } }] } } }
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } }
    return {}
  })
  c.render(c.slotComp('conversation.session.header.actions').Comp({ sessionId: 'session-root' }))
  await new Promise((r) => setTimeout(r, 40))
  const view = c.slotComp('conversation.view', 'review')
  let tree = c.render(view.Comp({ sessionId: 'session-root' }))
  await new Promise((r) => setTimeout(r, 40))
  tree = c.render(view.Comp({ sessionId: 'session-root' }))
  const select = c.collect(tree, 'cdx-turn-select')[0]
  assert.ok(select, 'turn/scope switcher rendered')
  select.props.onChange({ target: { value: 'all' } }) // "全部修改"
  tree = c.render(view.Comp({ sessionId: 'session-root' }))
  const rows = c.collect(tree, 'cdx-fl-item')
  assert.deepEqual(rows.map((r) => r.props.title), ['sub-only.js'], 'the host-only file is listed in the all scope')
  assert.equal(c.calls.some((x) => x.endpoint === 'file'), false, 'no detail fetched before expanding')

  rows[0].props.onClick() // expand the host-only entry
  await new Promise((r) => setTimeout(r, 40))
  const fileCalls = c.calls.filter((x) => x.endpoint === 'file')
  // JSON compare: the payload objects come from the VM realm, so strict
  // prototype-sensitive deepEqual would not match host-realm objects.
  assert.equal(JSON.stringify(fileCalls.map((x) => x.payload)), JSON.stringify([{ session: 'session-root', path: 'sub-only.js' }]), 'expansion fetched the hunks from the file endpoint')
  tree = c.render(view.Comp({ sessionId: 'session-root' }))
  const sections = c.collect(tree, 'cdx-sec')
  assert.equal(sections.length, 1, 'the fetched section renders')
  assert.equal(c.collect(sections[0], 'cdx-line').length >= 0, true)
})

test('isLoopbackRequest fence accepts loopback and rejects foreign hosts', () => {
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1:43120' } }), true)
  assert.equal(isLoopbackRequest({ headers: { host: 'localhost:3080' } }), true)
  assert.equal(isLoopbackRequest({ headers: { host: 'evil.example.com' } }), false)
  assert.equal(isLoopbackRequest({ headers: {} }), false)
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1:43120', origin: 'http://evil.example.com' } }), false)
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' } }), true)
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'cross-site' } }), false)
})

/** Minimal loopback POST + capturing response. `rawBody` is sent verbatim so a
 *  test can also send an envelope that does not match the endpoint. */
function postRaw(channel, url, rawBody) {
  const chunks = [Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))]
  const req = {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', host: '127.0.0.1:43120' },
    [Symbol.asyncIterator]() {
      let i = 0
      return { next: () => (i < chunks.length ? Promise.resolve({ value: chunks[i++], done: false }) : Promise.resolve({ value: undefined, done: true })) }
    }
  }
  let out = ''
  const res = { writeHead() {}, end(x) { out = String(x || '') } }
  return channel.handler(req, res).then(() => JSON.parse(out))
}

function rpcCall(channel, method, body) {
  return postRaw(channel, '/diff-review/' + method, JSON.stringify({ type: 'client-request', rpcId: 't', method, payload: body }))
}

/** Mirror of the official Web transport's parseConnectionResponse: it THROWS on
 *  anything other than { ok: true, value } | { ok: false, error: { code,
 *  message, details } }. A bare payload therefore makes EVERY client call fail
 *  inside the transport, before the plugin can see it — the review view then
 *  silently falls back to local history and never shows subagent edits.
 *  Asserting host replies through this helper keeps that contract pinned. */
function rpcValue(resp) {
  assert.ok(resp && typeof resp === 'object' && !Array.isArray(resp), 'reply is a record')
  assert.equal(resp.type, 'server-response', 'reply is a server-response')
  assert.equal(typeof resp.rpcId, 'string', 'reply echoes rpcId')
  const result = resp.result
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), 'result is a record')
  if (result.ok === true) return result.value
  assert.equal(result.ok, false, 'result.ok is true|false')
  const error = result.error
  assert.ok(error && typeof error === 'object' && !Array.isArray(error), 'error is a record')
  assert.equal(typeof error.code, 'string', 'error.code is a string')
  assert.equal(typeof error.message, 'string', 'error.message is a string')
  assert.ok(error.details && typeof error.details === 'object' && !Array.isArray(error.details), 'error.details is a record')
  return { ok: false, error }
}

test('channel replies are always a well-formed RPC envelope (failure branches)', async () => {
  const { ctx, routes } = makeCtx({ withWebServer: true })
  apply(ctx)
  const channel = routes.find((r) => r.path === '/diff-review')
  assert.ok(channel, 'channel attached')

  // (a) Invalid request envelope: the reply must still satisfy the official
  // contract — parseConnectionResponse THROWS on a bare `{ ok: false, error:
  // 'string' }`, which is exactly the shape that used to escape the transport.
  const bad = await postRaw(channel, '/diff-review/turn', { type: 'client-request', rpcId: 't', method: 'summary' })
  assert.equal(bad.type, 'server-response')
  assert.equal(rpcValue(bad).ok, false, 'failed replies are RPC failures')
  assert.equal(bad.result.error.code, 'invalid-envelope')
  assert.equal(typeof bad.result.error.message, 'string')
  assert.deepEqual(bad.result.error.details, {})

  // (b) A handler that throws must surface as the failure envelope, not as a
  // bare payload or a 500 that the transport turns into an opaque error.
  const boom = makeCtx({ withWebServer: true })
  Object.defineProperty(boom.ctx.agents, 'get', { get() { throw new Error('registry exploded') } })
  apply(boom.ctx)
  const boomChannel = boom.routes.find((r) => r.path === '/diff-review')
  const failed = await rpcCall(boomChannel, 'summary', { session: 'session-x' })
  const failure = rpcValue(failed)
  assert.equal(failure.ok, false, 'a throwing handler replies with ok:false')
  assert.equal(failed.result.error.code, 'diff-review-handler')
  assert.match(failed.result.error.message, /registry exploded/)
  assert.deepEqual(failed.result.error.details, {})
  // The route stays usable for other endpoints afterwards.
  const editors = await rpcCall(boomChannel, 'editors', {})
  assert.equal(Array.isArray(rpcValue(editors).editors), true, 'the channel still serves later requests')
})

test('host tags ops with the turn from snapshotEvents() (new DSH event surface)', async () => {
  const { ctx, listeners, routes } = makeCtx({ withWebServer: true })
  // New DSH: the session exposes snapshotEvents() instead of the live events
  // array. With only the old `session.events` read, tagging silently fell
  // back to turn 0 and every per-turn query came back empty.
  const events = [{ type: 'turn/start', data: { turn: 4 } }]
  ctx.agents.store.set('session-root', { agent: { session: { snapshotEvents: () => events } } })
  assert.doesNotThrow(() => apply(ctx))
  const channel = routes.find((r) => r.path === '/diff-review')
  assert.ok(channel, 'channel attached')
  const cb = listeners.get('tools/result')?.[0]
  assert.equal(typeof cb, 'function')
  cb(
    { tool: 'write', name: 'write', input: { file_path: 'src/t.txt', content: 'x\n' }, agent: { id: 'session-root' } },
    { value: { before: null, after: 'x\n' } }
  )
  const resp = await rpcCall(channel, 'turn', { session: 'session-root', turn: 4 })
  assert.equal(rpcValue(resp).files.length, 1, 'op lands under turn 4')
  assert.equal(rpcValue(resp).files[0].path, 'src/t.txt')
  const resp0 = await rpcCall(channel, 'turn', { session: 'session-root', turn: 0 })
  assert.equal(rpcValue(resp0).files.length, 0, 'op must not be tagged turn 0')
})

test('queries are served from the resolved root bucket, never a stale legacy child bucket', async () => {
  const h = makeLineageCtx()
  const childId = '9f1c0b7e-1d2a-4f3b-8c4d-5e6f7a8b9c0d'
  // A pre-v5 state file: the old resolveRootId wrote ops under the bare child
  // uuid, so such a bucket can still be on disk after the upgrade.
  writeFileSync(new URL('diff-review-state.json', h.ctx.baseUrl), JSON.stringify({
    version: 1,
    sessions: { [childId]: { files: { 'legacy.js': { path: 'legacy.js', cwd: undefined, ops: [{ kind: 'write', content: 'old\n', at: 1, turn: 1 }] } } } }
  }))
  const root = agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 3 } }])
  h.setLive(root)
  const child = agentOf(childId, { origin: 'subagent', parentSession: 'session-root', delegationDepth: 1 })
  h.setLive(child)
  apply(h.ctx)
  recordWrite(h, root, 'src/new.js', 'new\n')
  const channel = h.routes.find((r) => r.path === '/diff-review')

  // The child's own view must show what the parent sees — not the stale bucket
  // the old code left behind under the child id.
  const viaChild = rpcValue(await rpcCall(channel, 'summary', { session: childId }))
  assert.deepEqual(viaChild.files.map((f) => f.path), ['src/new.js'], 'the root bucket wins over the legacy child bucket')
  const viaRoot = rpcValue(await rpcCall(channel, 'summary', { session: 'session-root' }))
  assert.deepEqual(viaRoot.files.map((f) => f.path), ['src/new.js'])

  // Clearing from a subagent view clears the aggregate AND the legacy bucket,
  // so a refresh cannot resurrect either half.
  await rpcCall(channel, 'clear', { session: childId })
  assert.deepEqual(rpcValue(await rpcCall(channel, 'summary', { session: 'session-root' })).files, [])
  assert.deepEqual(rpcValue(await rpcCall(channel, 'summary', { session: childId })).files, [])
  for (const d of h.disposers) d()
})

test('client unwraps the official RPC envelope and tolerates bare payloads', () => {
  const hostValueOf = clientFunction('hostValueOf')
  // Official Web transport face: { ok: true, value }
  assert.deepEqual(hostValueOf({ ok: true, value: { files: ['a'] } }), { files: ['a'] })
  assert.equal(hostValueOf({ ok: true, value: null }), null)
  // Desktop bridge / older host face: the bare payload reaches the plugin.
  assert.deepEqual(hostValueOf({ files: ['a'], latestTurn: 3 }), { files: ['a'], latestTurn: 3 })
  assert.deepEqual(hostValueOf({ editors: [] }), { editors: [] })
  // Payload-level ok flags are business results, NOT envelopes: `error` is a
  // string there, so they must pass through untouched (open-with-editor,
  // revert). Promoting them would misreport a business refusal as a transport
  // failure and send the caller down the wrong fallback.
  assert.deepEqual(hostValueOf({ ok: true }), { ok: true })
  assert.deepEqual(hostValueOf({ ok: false, error: '编辑器未安装' }), { ok: false, error: '编辑器未安装' })
  // Transport-level failure carries the contract-shaped error record.
  assert.throws(() => hostValueOf({ ok: false, error: { code: 'x', message: 'boom', details: {} } }), /boom/)
})

test('tab badge keeps the host latest-activity window across a fresh turn', () => {
  // The running pill drops a host window older than the active turn (its
  // semantic is "this round"); the tab badge must NOT — it counts pending
  // review items, and subagent changes exist only in the host. Regression:
  // the badge vanished (read 0) whenever the user opened a new turn.
  const badgeHostItems = clientFunction('badgeHostItems')
  const hostWindowItems = clientFunction('hostWindowItems')
  const window33 = { turn: 33, files: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }] }
  // Badge face: keeps the window even though the active turn (34) is newer.
  assert.equal(badgeHostItems(window33).length, 3, 'badge shows the latest activity in a fresh turn')
  assert.equal(badgeHostItems({ turn: 34, files: [{ path: 'd.js' }] }).length, 1, 'badge follows new activity')
  assert.equal(badgeHostItems(null), null, 'no host data -> local fallback')
  assert.equal(badgeHostItems({ turn: 33, files: [] }), null, 'empty window -> local fallback')
  // Pill face: unchanged — the stale window is still suppressed there.
  assert.equal(hostWindowItems(window33, 34), null, 'pill still follows the in-flight turn')
  assert.equal(hostWindowItems(window33, 33).length, 3, 'pill shows the current turn window')
})

test('revert tool resolves @deepseek-ai/dsh-tools from the host install (link: mode)', (t) => {
  // Regression: with a `link:` install the plugin's real path lives outside the
  // profile, so the ordinary node_modules walk cannot see the HOST's own
  // @deepseek-ai/dsh-tools — startup logged "revert tool import failed" and the
  // diff_review_revert tool silently never registered. The host-anchored
  // fallback resolves it from the running dsh entry instead.
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = src.indexOf('function hostToolsUrl(')
  assert.notEqual(start, -1, 'hostToolsUrl exists in the host half')
  const open = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  const hostToolsUrl = new Function('createRequire', 'realpathSync', 'pathToFileURL',
    `${src.slice(start, end)}; return hostToolsUrl`)(createRequire, realpathSync, pathToFileURL)

  // A synthetic host install: `<host>/lib/bin.js` plus a hoisted
  // `<host>/node_modules/@deepseek-ai/dsh-tools`. Deterministic and
  // platform-independent, so the mechanism is asserted on every machine
  // (the real-host check below is the one that needs a dsh on PATH).
  const root = track(mkdtempSync(join(tmpdir(), 'drv-host-')))
  const hostDir = join(root, 'host')
  const pkgDir = join(hostDir, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(join(hostDir, 'lib'), { recursive: true })
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(hostDir, 'lib', 'bin.js'), '// host entry\n')
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0', main: 'lib/index.js' }))
  writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export const defineTool = () => {}\n')
  const saved = process.argv[1]
  try {
    process.argv[1] = join(hostDir, 'lib', 'bin.js')
    const url = hostToolsUrl()
    assert.ok(url, 'resolves through the host entry')
    assert.match(url, /@deepseek-ai\/dsh-tools\/lib\/index\.js$/)
  } finally {
    process.argv[1] = saved
  }
  // No anchor -> null instead of throwing, so callers report the original error.
  process.argv[1] = '/nonexistent/dsh-entry.js'
  try { assert.equal(hostToolsUrl(), null) } finally { process.argv[1] = saved }

  // Real host, when one is discoverable: the same resolution must land on the
  // installed package (skipped explicitly rather than silently passing).
  const bin = findDshEntry()
  if (!bin) { t.skip('no dsh entry on PATH: real-host anchor not checked'); return }
  process.argv[1] = bin
  try {
    const url = hostToolsUrl()
    assert.ok(url, 'resolves through the real dsh entry')
    assert.match(url, /@deepseek-ai\/dsh-tools\/lib\/index\.js$/)
  } finally {
    process.argv[1] = saved
  }
})

/** Locate the dsh CLI entry cross-platform (PATH lookup + shim unwrapping). */
function findDshEntry() {
  try {
    const out = process.platform === 'win32'
      ? execFileSync('where', ['dsh'], { encoding: 'utf8' })
      : execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' })
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (!first) return null
    const real = realpathSync(first)
    if (!/\.(cmd|ps1|bat)$/i.test(real)) return real
    // A shell shim: the real entry is the package bin next to it.
    const guess = join(dirname(real), '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    return existsSync(guess) ? guess : null
  } catch (e) {
    return null
  }
}

/** Slice the balanced `{...}` literal starting at/after `anchor`, so a source
 *  declaration (here: the revert tool's output schema) can be asserted on
 *  directly instead of restated in the test. */
function objectLiteralAfter(source, anchor) {
  const open = source.indexOf('{', anchor)
  assert.notEqual(open, -1, `an object literal follows ${JSON.stringify(anchor)}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  assert.fail('the object literal is balanced')
}

/** The HOST's own output validator, when a dsh install is discoverable: the
 *  schema below is enforced by that code, so validating with it is the real
 *  contract rather than a second copy of the rule. */
async function hostOutputValidator() {
  const bin = findDshEntry()
  if (bin) {
    try {
      const req = createRequire(bin)
      const mod = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href)
      if (typeof mod.validateJsonSchemaValue === 'function') return mod.validateJsonSchemaValue
    } catch (e) {}
  }
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.validateJsonSchemaValue === 'function') return mod.validateJsonSchemaValue
  } catch (e) {}
  return null
}

test('revert tool output schema declares every field the revert body returns', async (t) => {
  // Regression: the host validates the tool body against the DECLARED output
  // schema with additionalProperties:false, while doRevert answers
  // { ok, mode, message }. `mode` was undeclared, so every successful revert
  // (the per-turn 撤销 button fills exactly this tool call into the composer)
  // came back as `tool "diff_review_revert" returned invalid output:
  // "value.mode" is not a declared property (additionalProperties: false)` —
  // an error the user reads as a failed revert although the file was restored.
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const anchor = src.indexOf("name: 'diff_review_revert'")
  assert.notEqual(anchor, -1, 'the revert tool is registered under its name')
  const schema = new Function(`return (${objectLiteralAfter(src, src.indexOf('schema: {', anchor))})`)()
  assert.equal(schema.additionalProperties, false, 'the output contract stays strict (no blanket relaxation)')

  const h = makeLineageCtx()
  const sandboxDir = fileURLToPath(new URL('.', h.ctx.baseUrl))
  const root = agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 4 } }])
  h.setLive(root)
  apply(h.ctx)
  const channel = h.routes.find((r) => r.path === '/diff-review')

  // Single-operation revert: mode 'op'.
  const opPath = join(sandboxDir, 'revert-op.txt')
  recordEdit(h, root, opPath, 'a\n', 'b\n')
  const opValue = rpcValue(await rpcCall(channel, 'revert', { session: root.id, path: opPath, op: 0 }))
  assert.equal(opValue.mode, 'op', 'a targeted operation reports the op scope')
  assert.equal(readFileSync(opPath, 'utf8'), 'a\n', 'the pre-edit content is restored')

  // Whole-file revert: mode 'file'.
  const filePath = join(sandboxDir, 'revert-file.txt')
  recordEdit(h, root, filePath, 'x\n', 'y\n')
  const fileValue = rpcValue(await rpcCall(channel, 'revert', { session: root.id, path: filePath, op: null }))
  assert.equal(fileValue.mode, 'file', 'a whole-file revert reports the file scope')
  assert.equal(readFileSync(filePath, 'utf8'), 'x\n')

  // Failure replies travel through the same schema (record already consumed).
  const failValue = rpcValue(await rpcCall(channel, 'revert', { session: root.id, path: filePath, op: null }))
  assert.equal(failValue.ok, false)

  const validate = await hostOutputValidator()
  if (!validate) t.diagnostic('no dsh install discoverable: output schema checked structurally only')
  for (const value of [opValue, fileValue, failValue]) {
    for (const key of Object.keys(value)) {
      assert.ok(Object.hasOwn(schema.properties, key), `output schema declares "${key}" (reply: ${JSON.stringify(value)})`)
    }
    if (validate) {
      assert.deepEqual(validate(schema, value, 'value'), [], `host validator accepts ${JSON.stringify(value)}`)
    }
  }
  for (const d of h.disposers) d()
})

test('locateFragment recovers a fragment line from the before snapshot', () => {
  const file = ['a', 'b', 'c', 'dup', 'e', 'dup', 'g'].join('\n')
  // Exact for the first site, and the count is what tells replace_all apart.
  assert.deepEqual(locateFragment(file, 'dup'), { line: 4, count: 2 })
  assert.deepEqual(locateFragment(file, 'c\ndup'), { line: 3, count: 1 })
  assert.deepEqual(locateFragment(file, 'g'), { line: 7, count: 1 })
  // Nothing to anchor on: no snapshot (legacy op), empty fragment, no match, or a
  // truncated snapshot. The caller must fall back to relative numbering instead.
  assert.equal(locateFragment(undefined, 'dup'), null)
  assert.equal(locateFragment(null, 'dup'), null)
  assert.equal(locateFragment(file, ''), null)
  assert.equal(locateFragment(file, 'nope'), null)
  assert.equal(locateFragment('a\nb', 'g'), null)
})

test('locateFragment matches text, not whole lines (CRLF included)', () => {
  const file = ['l1', '  foo = 1;', 'l3'].join('\n')
  // A fragment that is only PART of a line: whole-line comparison returned null
  // here, which pushed those edits onto the relative-number fallback even though
  // the offset was right there (21 of 723 edits in one real state file).
  assert.deepEqual(locateFragment(file, 'foo = 1'), { line: 2, count: 1 })
  assert.deepEqual(locateFragment(file, 'foo'), { line: 2, count: 1 })
  // A fragment that starts mid-line and continues onto the next line.
  assert.deepEqual(locateFragment(file, '= 1;\nl3'), { line: 2, count: 1 })
  // A CRLF checkout whose old_string arrives with bare \n still locates.
  const crlf = 'a\r\nold\r\nc'
  assert.deepEqual(locateFragment(crlf, 'old'), { line: 2, count: 1 })
  assert.deepEqual(locateFragment(crlf, 'a\nold'), { line: 1, count: 1 })
  assert.deepEqual(locateFragment(crlf, 'a\r\nold'), { line: 1, count: 1 })
  // Regex metacharacters in the fragment are literal, not a pattern.
  assert.deepEqual(locateFragment('x\nf(a)[b]\ny', 'f(a)[b]'), { line: 2, count: 1 })
  assert.equal(locateFragment('x\nf(a)[b]\ny', 'f(a)b'), null)
  // The client mirror must agree with the host on all of it.
  const locateFragmentL = clientFunction('locateFragmentL')
  for (const [before, fragment, expected] of [
    [file, 'foo = 1', { line: 2, count: 1 }],
    [file, '= 1;\nl3', { line: 2, count: 1 }],
    [crlf, 'a\nold', { line: 1, count: 1 }],
    ['x\nf(a)[b]\ny', 'f(a)b', null]
  ]) {
    assert.deepEqual(locateFragmentL(before, fragment), expected, 'client mirror: ' + JSON.stringify(fragment))
  }
})

test('a snapshot cut by the storage cap still reports REAL lines, and its revert is refused', async () => {
  // A huge file is stored capped at MAX_CHARS (120000), and the edit here sits
  // PAST the cut, so the stored snapshot cannot locate it. Recovering the offset
  // at edit time from the UNTRUNCATED text (lineHint) keeps the gutter on real
  // file lines — and that same op must never be reverted from the cut snapshot,
  // because writing 120000 characters back would destroy the rest of the file.
  // Both halves come from one real ~200 KB Unity prefab that did exactly this.
  const h = makeLineageCtx()
  const sandboxDir = fileURLToPath(new URL('.', h.ctx.baseUrl))
  const target = join(sandboxDir, 'huge-prefab.txt')
  const root = agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 8 } }])
  h.setLive(root)
  apply(h.ctx)

  const filler = Array.from({ length: 2000 }, (_, i) => 'line' + i + ' ' + 'x'.repeat(80)).join('\n')
  const before = filler + '\nTARGET_LINE\ntail\n'
  const after = before.replace('TARGET_LINE', 'CHANGED_LINE')
  const expectedLine = before.split('\n').indexOf('TARGET_LINE') + 1
  assert.ok(before.length > 120000, 'the fixture really is bigger than the snapshot cap')
  h.listeners.get('tools/result')[0](
    { tool: 'edit', name: 'edit', input: { file_path: target, old_string: 'TARGET_LINE', new_string: 'CHANGED_LINE' }, agent: root },
    { value: { before, after } }
  )
  writeFileSync(target, after)
  const channel = h.routes.find((r) => r.path === '/diff-review')

  const detail = rpcValue(await rpcCall(channel, 'file', { session: root.id, path: target }))
  assert.equal(detail.sections[0].lineExact, true, 'the real line survived the cap')
  assert.equal(detail.sections[0].lineBase, expectedLine)
  assert.equal(detail.sections[0].hunks.find((x) => x.type === 'add').b, expectedLine, 'the added line carries the real line number')

  const resp = rpcValue(await rpcCall(channel, 'revert', { session: root.id, path: target, op: null }))
  assert.equal(resp.ok, false, 'a cut snapshot is never written back')
  assert.match(resp.error, /截断/)
  assert.equal(readFileSync(target, 'utf8'), after, 'the file keeps its full content')
  for (const d of h.disposers) d()
})

test('a legacy op with no snapshot of its own takes its real line from the file on disk', async () => {
  // The last case left for relative numbering: an op recorded before lineHint
  // existed whose snapshot the cap cut (the 200 KB prefab again). Nothing inside
  // the record can locate it, so the CURRENT file is the only source — and the
  // right one, since the gutter's whole job is to open that file at that line.
  const h = makeLineageCtx()
  const sandboxDir = fileURLToPath(new URL('.', h.ctx.baseUrl))
  const target = join(sandboxDir, 'legacy-op.txt')
  const missing = join(sandboxDir, 'legacy-gone.txt')
  const root = agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 3 } }])
  h.setLive(root)
  apply(h.ctx)
  writeFileSync(target, ['l1', 'l2', '  anchor = OLD;', 'l4'].join('\n'))
  // `value: {}` is the legacy shape: no before/after snapshot at all.
  h.listeners.get('tools/result')[0](
    { tool: 'edit', name: 'edit', input: { file_path: target, old_string: 'anchor = OLD', new_string: 'anchor = NEW' }, agent: root },
    { value: {} }
  )
  h.listeners.get('tools/result')[0](
    { tool: 'edit', name: 'edit', input: { file_path: missing, old_string: 'nowhere', new_string: 'elsewhere' }, agent: root },
    { value: {} }
  )
  const channel = h.routes.find((r) => r.path === '/diff-review')

  const detail = rpcValue(await rpcCall(channel, 'file', { session: root.id, path: target }))
  assert.equal(detail.sections[0].lineExact, true, 'the disk lookup gives a real file line')
  assert.equal(detail.sections[0].lineBase, 3)
  assert.equal(detail.sections[0].lineSource, 'disk')
  assert.equal(detail.sections[0].hunks.find((x) => x.type === 'del').a, 3, 'the removed line carries it too')

  // No file on disk either: relative numbering stays, flagged rather than faked.
  const gone = rpcValue(await rpcCall(channel, 'file', { session: root.id, path: missing }))
  assert.equal(gone.sections[0].lineExact, false)
  assert.equal(gone.sections[0].lineSource, null)
  for (const d of h.disposers) d()
})

test('edit sections report REAL file lines recovered from the before snapshot', async () => {
  const h = makeLineageCtx()
  const root = agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 2 } }])
  h.setLive(root)
  apply(h.ctx)
  const before = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n')
  // The fragment keeps context lines so the diff has both sides AND trailing
  // context — the numbers that used to restart at 1 in every direction.
  h.listeners.get('tools/result')[0](
    { tool: 'edit', name: 'edit', input: { file_path: 'src/mid.js', old_string: 'l3\nl4\nl5', new_string: 'l3\nL4\nl5' }, agent: root },
    { value: { before, after: before.replace('l4', 'L4') } }
  )
  const channel = h.routes.find((r) => r.path === '/diff-review')
  const detail = rpcValue(await rpcCall(channel, 'file', { session: 'session-root', path: 'src/mid.js' }))
  const sec = detail.sections[0]
  assert.equal(sec.lineExact, true, 'the snapshot makes the offset exact')
  assert.equal(sec.lineBase, 3, 'the base is the fragment\'s first file line (l3)')
  assert.equal(sec.hunks.find((x) => x.type === 'del').a, 4, 'deletion reports the real file line')
  assert.equal(sec.hunks.find((x) => x.type === 'add').b, 4, 'insertion reports the real file line')
  // The line after the change keeps counting from the file, not from the fragment.
  const ctx = sec.hunks.filter((x) => x.type === 'ctx')
  assert.equal(ctx[0].a, 3, 'leading context is on real line numbers')
  assert.equal(ctx[ctx.length - 1].a, 5, 'trailing context stays on real line numbers too')
  for (const d of h.disposers) d()
})

test('replace_all edits report every site, and a missing snapshot is marked relative', async () => {
  const h = makeLineageCtx()
  const root = agentOf('session-root', {}, [{ type: 'turn/start', data: { turn: 3 } }])
  h.setLive(root)
  apply(h.ctx)
  const cb = h.listeners.get('tools/result')[0]
  const before = ['a', 'dup', 'b', 'dup', 'c'].join('\n')
  cb(
    { tool: 'edit', name: 'edit', input: { file_path: 'src/all.js', old_string: 'dup', new_string: 'DUP', replace_all: true }, agent: root },
    { value: { before, after: before.split('dup').join('DUP') } }
  )
  // A legacy record (no before/after value at all): the op is still recorded, but
  // there is no snapshot to anchor on.
  cb(
    { tool: 'edit', name: 'edit', input: { file_path: 'src/legacy.js', old_string: 'x', new_string: 'y' }, agent: root },
    { value: {} }
  )
  const channel = h.routes.find((r) => r.path === '/diff-review')

  const all = rpcValue(await rpcCall(channel, 'file', { session: 'session-root', path: 'src/all.js' }))
  assert.equal(all.sections[0].lineExact, true)
  assert.equal(all.sections[0].lineBase, 2, 'the reported line is the FIRST site')
  assert.equal(all.sections[0].multiMatch, 2, 'replace_all replaced two sites')

  const legacy = rpcValue(await rpcCall(channel, 'file', { session: 'session-root', path: 'src/legacy.js' }))
  assert.equal(legacy.sections[0].lineExact, false, 'no snapshot -> flagged, not faked')
  assert.equal(legacy.sections[0].lineBase, null)
  assert.equal(legacy.sections[0].hunks.find((x) => x.type === 'del').a, 1, 'numbers stay fragment-relative')

  // replace_all is what makes the fragment non-unique, so it is recorded per op.
  const state = flushedState(h)
  const ops = state.sessions['session-root'].files['src/all.js'].ops
  assert.equal(ops[0].replaceAll, true)
  const legacyOps = state.sessions['session-root'].files['src/legacy.js'].ops
  assert.equal(legacyOps[0].replaceAll, false)
  assert.equal('before' in legacyOps[0], false, 'a missing snapshot stays undefined')
})

test('client: open target per section + the per-turn window cutoff', () => {
  const sectionOpenLine = clientFunction('sectionOpenLine')
  const lastLabeledAtOf = clientFunction('lastLabeledAtOf')
  // New-side anchor = the smallest new-side line the section touches; a pure
  // deletion has none, so it falls back to the recovered base line.
  assert.equal(sectionOpenLine({ lineExact: true, hunks: [
    { type: 'ctx', a: 5, b: 5, text: 'l5' }, { type: 'del', a: 6, b: null, text: 'x' }, { type: 'add', a: null, b: 6, text: 'y' }
  ] }), 5)
  assert.equal(sectionOpenLine({ lineExact: true, lineBase: 9, hunks: [{ type: 'del', a: 9, b: null, text: 'gone' }] }), 9)
  // Fragment-relative sections have no open target at all.
  assert.equal(sectionOpenLine({ lineExact: false, hunks: [{ type: 'add', a: null, b: 3, text: 'x' }] }), null)
  assert.equal(sectionOpenLine(null), null)

  // The unlabeled-op cutoff is the newest TAGGED op, not the requested turn's own
  // ops: that is what stops a new turn from inheriting earlier stragglers.
  const files = new Map([['p', { ops: [{ turn: 3, at: 100 }, { turn: 0, at: 150 }, { turn: 4, at: 120 }] }]])
  assert.equal(lastLabeledAtOf(files), 120)
  assert.equal(lastLabeledAtOf(new Map([['p', { ops: [{ turn: 0, at: 50 }, { at: 60 }] }]])), 0, 'all-unlabeled sessions behave as before')
  assert.equal(lastLabeledAtOf(new Map()), 0)
})

test("client: every change opens the editor at its line, and relative numbers are marked", async () => {
  const line = (n, text, type) => (type === 'add'
    ? { type: 'add', a: null, b: n, text: text }
    : type === 'del' ? { type: 'del', a: n, b: null, text: text } : { type: 'ctx', a: n, b: n, text: text });
  const exactSections = [{ kind: 'edit', at: 5, lineExact: true, lineBase: 3, hunks: [
    line(3, 'l3', 'ctx'), line(4, 'l4', 'del'), line(4, 'L4', 'add'), line(5, 'l5', 'ctx')
  ] }];
  const relSections = [{ kind: 'edit', at: 5, lineExact: false, lineBase: null, hunks: [line(1, 'NEW', 'add')] }];
  const file = { path: 'src/mid.js', name: 'mid.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9 };
  const settle = () => new Promise((r) => setTimeout(r, 60));

  const boot = async (sections) => {
    const item = Object.assign({}, file, { sections: sections });
    const c = loadRealClient(async (endpoint, payload) => {
      if (endpoint === 'editors') return { editors: [] };
      if (endpoint === 'summary') return { files: [file], latestTurn: 5 };
      if (endpoint === 'turn') return { turn: 5, files: [item] };
      if (endpoint === 'file') return { path: payload.path, sections: sections };
      if (endpoint === 'open-with-editor') return { ok: true };
      if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } };
      if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } };
      return {};
    }, { editor: { id: 'vscode', name: 'VS Code' } });
    c.render(c.slotComp('conversation.session.header.actions').Comp({ sessionId: 'session-root' }));
    await settle();
    const view = c.slotComp('conversation.view', 'review');
    let tree = null;
    for (let i = 0; i < 3; i++) { tree = c.render(view.Comp({ sessionId: 'session-root' })); await settle(); }
    c.collect(tree, 'cdx-fl-item')[0].props.onClick(); // select the file -> detail pane
    await settle();
    tree = c.render(view.Comp({ sessionId: 'session-root' }));
    return { c, tree };
  };

  // Real lines: the section header carries one button, and only the CHANGED row
  // carries another (context rows do not). Per-row buttons live inside CodexLine,
  // a nested component, so those elements are expanded explicitly.
  const expandLines = (c, tree) => {
    const els = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.type === 'function' && node.type.name === 'CodexLine') els.push(node);
      for (const ch of node.children || []) walk(ch);
    };
    walk(tree);
    return els.map((el) => c.render(el));
  };
  const real = await boot(exactSections);
  const headButtons = real.c.collect(real.tree, 'cdx-open');
  assert.equal(headButtons.length, 1, 'the section header carries one open button');
  const rendered = expandLines(real.c, real.tree);
  assert.equal(rendered.length, 4, 'four rows rendered');
  const rowButtons = rendered.flatMap((r) => real.c.collect(r, 'cdx-open'));
  assert.equal(rowButtons.length, 2, 'both changed rows get a button; context rows do not');
  assert.match(rowButtons[0].props.title, /第 3 行/, 'a deleted row jumps to the section anchor — its own line no longer exists');
  assert.match(rowButtons[1].props.title, /第 4 行/, 'an added row jumps to its own new-side line');

  rowButtons[1].props.onClick();
  await settle();
  let openCalls = real.c.calls.filter((x) => x.endpoint === 'open-with-editor');
  assert.equal(openCalls.length, 1, 'the click routed to the host editor route');
  assert.equal(openCalls[0].payload.line, 4, 'the changed row jumps to its own new-side line');
  assert.equal(openCalls[0].payload.editor, 'vscode', 'the remembered editor is used');
  headButtons[0].props.onClick();
  await settle();
  openCalls = real.c.calls.filter((x) => x.endpoint === 'open-with-editor');
  assert.equal(openCalls[1].payload.line, 3, 'the header button jumps to the section new-side anchor');
  assert.equal(real.c.collect(real.tree, 'cdx-sec-note').length, 0, 'exact sections carry no relative badge');

  // Fragment-relative: marked, and NO button that would jump to a made-up line.
  const rel = await boot(relSections);
  assert.equal(rel.c.collect(rel.tree, 'cdx-open').length, 0, 'no header button without real lines');
  const relRendered = expandLines(rel.c, rel.tree);
  assert.equal(relRendered.flatMap((r) => rel.c.collect(r, 'cdx-open')).length, 0, 'no per-row button either');
  const notes = rel.c.collect(rel.tree, 'cdx-sec-note');
  assert.equal(notes.length, 1, 'the relative badge is shown');
  assert.equal(notes[0].children[0], '相对行号');
  const gutters = relRendered.flatMap((r) => rel.c.collect(r, 'cdx-gutter'));
  assert.equal(gutters.some((g) => g.children[0] === '~1'), true, 'the gutter marks the number as relative');
  assert.equal(rel.c.calls.some((x) => x.endpoint === 'open-with-editor'), false, 'nothing was opened');
})

test('open-at-line falls back to the shell preview when no external editor is chosen', async () => {
  const sections = [{ kind: 'edit', at: 5, lineExact: true, lineBase: 3, hunks: [
    { type: 'ctx', a: 3, b: 3, text: 'l3' }, { type: 'del', a: 4, b: null, text: 'l4' },
    { type: 'add', a: null, b: 4, text: 'L4' }, { type: 'ctx', a: 5, b: 5, text: 'l5' }
  ] }];
  const file = { path: 'src/mid.js', name: 'mid.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9, sections: sections };
  const c = loadRealClient(async (endpoint, payload) => {
    if (endpoint === 'editors') return { editors: [] };
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 };
    if (endpoint === 'turn') return { turn: 5, files: [file] };
    if (endpoint === 'file') return { path: payload.path, sections: sections };
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } };
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } };
    return {};
  }) // no editor: the shell preview is the only way to land on a line
  const shellOpens = [];
  // The chat supplies openFile to turn cards; capturing it there is what lets the
  // review buttons use the shell's own opener (right-sidebar preview at the line).
  c.render(c.slotComp('conversation.chat.turnTail').Comp({
    matched: { turn: 5 }, sessionId: 'session-root', turn: {}, seq: 1,
    openFile: (path, options) => shellOpens.push([path, options])
  }));
  await new Promise((r) => setTimeout(r, 40));
  c.render(c.slotComp('conversation.session.header.actions').Comp({ sessionId: 'session-root' }));
  await new Promise((r) => setTimeout(r, 40));
  const view = c.slotComp('conversation.view', 'review');
  let tree = null;
  for (let i = 0; i < 3; i++) { tree = c.render(view.Comp({ sessionId: 'session-root' })); await new Promise((r) => setTimeout(r, 60)); }
  c.collect(tree, 'cdx-fl-item')[0].props.onClick();
  await new Promise((r) => setTimeout(r, 40));
  tree = c.render(view.Comp({ sessionId: 'session-root' }));
  const expandLines = (t) => {
    const els = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.type === 'function' && node.type.name === 'CodexLine') els.push(node);
      for (const ch of node.children || []) walk(ch);
    };
    walk(t);
    return els.map((el) => c.render(el));
  };
  const buttons = expandLines(tree).flatMap((r) => c.collect(r, 'cdx-open'));
  assert.equal(buttons.length, 2, 'both changed rows offer a jump');
  buttons[1].props.onClick(); // the added row
  // JSON compare: the options object is built in the VM realm, so a
  // prototype-sensitive deepEqual would not match host-realm objects.
  assert.equal(JSON.stringify(shellOpens), JSON.stringify([['src/mid.js', { line: 4 }]]), 'the shell preview opens at the line');
  assert.equal(c.calls.some((x) => x.endpoint === 'open-with-editor'), false, 'no external editor was called');
})

test('a chosen external editor opens the file at the line, not the sidebar preview', async () => {
  const sections = [{ kind: 'edit', at: 5, lineExact: true, lineBase: 3, hunks: [
    { type: 'ctx', a: 3, b: 3, text: 'l3' }, { type: 'del', a: 4, b: null, text: 'l4' },
    { type: 'add', a: null, b: 4, text: 'L4' }, { type: 'ctx', a: 5, b: 5, text: 'l5' }
  ] }];
  const file = { path: 'src/mid.js', name: 'mid.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9, sections: sections };
  // The shell's opener does not defer to a chosen editor (measured: VS Code selected,
  // still the sidebar preview), so a selected editor must win over it.
  const c = loadRealClient(async (endpoint, payload) => {
    if (endpoint === 'editors') return { editors: [] };
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 };
    if (endpoint === 'turn') return { turn: 5, files: [file] };
    if (endpoint === 'file') return { path: payload.path, sections: sections };
    if (endpoint === 'open-with-editor') return { ok: true };
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } };
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } };
    return {};
  }, { editor: { id: 'vscode', name: 'VS Code' } })
  const shellOpens = []
  c.render(c.slotComp('conversation.chat.turnTail').Comp({
    matched: { turn: 5 }, sessionId: 'session-root', turn: {}, seq: 1,
    openFile: (path, options) => shellOpens.push([path, options])
  }))
  await new Promise((r) => setTimeout(r, 40))
  c.render(c.slotComp('conversation.session.header.actions').Comp({ sessionId: 'session-root' }))
  await new Promise((r) => setTimeout(r, 40))
  const view = c.slotComp('conversation.view', 'review')
  let tree = null
  for (let i = 0; i < 3; i++) { tree = c.render(view.Comp({ sessionId: 'session-root' })); await new Promise((r) => setTimeout(r, 60)) }
  c.collect(tree, 'cdx-fl-item')[0].props.onClick()
  await new Promise((r) => setTimeout(r, 40))
  tree = c.render(view.Comp({ sessionId: 'session-root' }))
  const els = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function' && node.type.name === 'CodexLine') els.push(node)
    for (const ch of node.children || []) walk(ch)
  }
  walk(tree)
  const buttons = els.map((el) => c.render(el)).flatMap((r) => c.collect(r, 'cdx-open'))
  buttons[1].props.onClick()
  const opened = c.calls.filter((x) => x.endpoint === 'open-with-editor')
  assert.equal(opened.length, 1, 'the chosen editor is used')
  assert.equal(opened[0].payload.editor, 'vscode', 'by id')
  assert.equal(opened[0].payload.line, 4, 'and it is told which line to reveal')
  assert.equal(shellOpens.length, 0, 'the sidebar preview is not used while an editor is chosen')
  // The picker lives in the review toolbar now (in the header it sat next to the
  // shell's own "open in app" chip), and it replaced the refresh / clear buttons.
  assert.equal(c.slotComp('conversation.session.header.utilities', 'diff-review-editor'), undefined, 'no picker chip in the session header')
  assert.equal(c.collect(tree, 'cdx-tool-btn').length, 0, 'the refresh / clear buttons are gone from the toolbar')
  const toolbarEditor = c.collect(tree, 'cdx-toolbar-editor')[0]
  assert.ok(toolbarEditor, 'the toolbar has an editor-picker slot')
  const pickerEl = c.render(toolbarEditor.children[0])
  assert.equal(pickerEl.props.className, 'drv-editor', 'the picker renders there')
  assert.equal(c.collect(pickerEl, 'drv-editor-btn').length, 1, 'with its chip button')
})

test('the OS default application opens the file when no editor can take it', async () => {
  const sections = [{ kind: 'edit', at: 5, lineExact: true, lineBase: 3, hunks: [
    { type: 'ctx', a: 3, b: 3, text: 'l3' }, { type: 'del', a: 4, b: null, text: 'l4' },
    { type: 'add', a: null, b: 4, text: 'L4' }, { type: 'ctx', a: 5, b: 5, text: 'l5' }
  ] }];
  const file = { path: 'src/mid.js', name: 'mid.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9, sections: sections };
  // The shell's own card opens a presented file through the OS default application
  // ("用默认应用打开"), which is what actually launches VS Code on this machine. The
  // plugin's open buttons must have the same last resort instead of doing nothing.
  const opened = []
  const c = loadRealClient(async (endpoint, payload) => {
    if (endpoint === 'editors') return { editors: [] };
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 };
    if (endpoint === 'turn') return { turn: 5, files: [file] };
    if (endpoint === 'file') return { path: payload.path, sections: sections };
    if (endpoint === 'open-with-editor') return { ok: false, error: '编辑器 vscode 未安装或未检测到' };
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } };
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } };
    return {};
  }, { workspaces: { openPath: (p) => { opened.push(p); return Promise.resolve() } } })
  // No turn card is rendered, so no shell opener is captured: preview is unavailable
  // and the default-application route is the only one left.
  const view = c.slotComp('conversation.view', 'review')
  let tree = null
  for (let i = 0; i < 3; i++) { tree = c.render(view.Comp({ sessionId: 'session-root' })); await new Promise((r) => setTimeout(r, 60)) }
  c.collect(tree, 'cdx-fl-item')[0].props.onClick()
  await new Promise((r) => setTimeout(r, 40))
  tree = c.render(view.Comp({ sessionId: 'session-root' }))
  const openButtons = () => {
    const els = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.type === 'function' && node.type.name === 'CodexLine') els.push(node)
      for (const ch of node.children || []) walk(ch)
    }
    walk(tree)
    return els.map((el) => c.render(el)).flatMap((r) => c.collect(r, 'cdx-open'))
  }
  openButtons()[0].props.onClick()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(opened.length, 1, 'the default application is asked to open the file')
  assert.match(opened[0], /mid\.js$/, 'with the absolute path')

  // A chosen editor that the host refuses must fall through the same way, not no-op.
  const opened2 = []
  const c2 = loadRealClient(async (endpoint, payload) => {
    if (endpoint === 'editors') return { editors: [] };
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 };
    if (endpoint === 'turn') return { turn: 5, files: [file] };
    if (endpoint === 'file') return { path: payload.path, sections: sections };
    if (endpoint === 'open-with-editor') return { ok: false, error: '编辑器 vscode 未安装或未检测到' };
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } };
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } };
    return {};
  }, { editor: { id: 'vscode', name: 'VS Code' }, workspaces: { openPath: (p) => { opened2.push(p); return Promise.resolve() } } })
  const view2 = c2.slotComp('conversation.view', 'review')
  let tree2 = null
  for (let i = 0; i < 3; i++) { tree2 = c2.render(view2.Comp({ sessionId: 'session-root' })); await new Promise((r) => setTimeout(r, 60)) }
  c2.collect(tree2, 'cdx-fl-item')[0].props.onClick()
  await new Promise((r) => setTimeout(r, 40))
  tree2 = c2.render(view2.Comp({ sessionId: 'session-root' }))
  const els2 = []
  const walk2 = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function' && node.type.name === 'CodexLine') els2.push(node)
    for (const ch of node.children || []) walk2(ch)
  }
  walk2(tree2)
  els2.map((el) => c2.render(el)).flatMap((r) => c2.collect(r, 'cdx-open'))[0].props.onClick()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(c2.calls.some((x) => x.endpoint === 'open-with-editor'), true, 'the editor was tried first')
  assert.equal(opened2.length, 1, 'and the default application caught the failure')
})

test('editor launch: a Windows .cmd shim runs through cmd.exe with its args intact', async (t) => {
  if (process.platform !== 'win32') { t.skip('the cmd shim path is Windows-only'); return }
  // Windows editors are usually installed as a `.cmd` shim, which execFileSync
  // cannot exec (ENOENT) — the silent cause of an "open in editor" click that
  // appears to do nothing.
  const dir = track(mkdtempSync(join(tmpdir(), 'drv-shim-')))
  const shim = join(dir, 'my editor.cmd')
  const out = join(dir, 'args.txt')
  writeFileSync(shim, '@echo off\r\n> "' + out + '" echo %*\r\n')
  await launchEditor(shim, ['--goto', 'D:/ws/some file.js:42:1'])
  // The launch resolves on `spawn`, so the shim may still be writing: poll briefly.
  let captured = ''
  for (let i = 0; i < 40 && !captured; i++) {
    try { captured = readFileSync(out, 'utf8').trim() } catch (e) { await new Promise((r) => setTimeout(r, 50)) }
  }
  assert.match(captured, /--goto/, 'the editor flag survives the shim')
  assert.match(captured, /some file\.js:42:1/, 'a path with a space and the :line:col suffix survive')
})

test('editor launch does not wait for the editor to exit', async (t) => {
  if (process.platform !== 'win32') { t.skip('the cmd shim path is Windows-only'); return }
  // VS Code keeps running after it takes the file, so a synchronous wait reported
  // ETIMEDOUT for an editor that HAD opened — and blocked the host the whole time.
  const dir = track(mkdtempSync(join(tmpdir(), 'drv-detach-')))
  const shim = join(dir, 'slow editor.cmd')
  // ~1s of "the editor is still running" after the file is handed over. Kept short
  // (and window-less: the launch is not detached, so cmd.exe inherits this console
  // instead of opening its own black window on every test run).
  writeFileSync(shim, '@echo off\r\nping -n 2 127.0.0.1 >nul\r\n')
  const started = Date.now()
  await launchEditor(shim, ['--goto', 'D:/ws/a.js:1:1'])
  const elapsed = Date.now() - started
  assert.equal(elapsed < 2000, true, 'the launch returns as soon as the process spawns (took ' + elapsed + 'ms)')
})

test('an absolute file path is never joined onto the cwd a second time', async () => {
  const sections = [{ kind: 'edit', at: 5, lineExact: true, lineBase: 3, hunks: [
    { type: 'add', a: null, b: 4, text: 'L4' }
  ] }];
  const file = { path: 'D:/ws/abs.js', name: 'abs.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9, sections: sections };
  const opened = []
  const c = loadRealClient(async (endpoint, payload) => {
    if (endpoint === 'editors') return { editors: [] };
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 };
    if (endpoint === 'turn') return { turn: 5, files: [file] };
    if (endpoint === 'file') return { path: payload.path, sections: sections };
    if (endpoint === 'open-with-editor') return { ok: true };
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } };
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } };
    return {};
  }, { editor: { id: 'vscode', name: 'VS Code' }, workspaces: { openPath: (p) => { opened.push(p); return Promise.resolve() } } })
  const view = c.slotComp('conversation.view', 'review')
  let tree = null
  for (let i = 0; i < 3; i++) { tree = c.render(view.Comp({ sessionId: 'session-root' })); await new Promise((r) => setTimeout(r, 60)) }
  c.collect(tree, 'cdx-fl-item')[0].props.onClick()
  await new Promise((r) => setTimeout(r, 40))
  tree = c.render(view.Comp({ sessionId: 'session-root' }))
  const els = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function' && node.type.name === 'CodexLine') els.push(node)
    for (const ch of node.children || []) walk(ch)
  }
  walk(tree)
  els.map((el) => c.render(el)).flatMap((r) => c.collect(r, 'cdx-open'))[0].props.onClick()
  await new Promise((r) => setTimeout(r, 20))
  const openedCall = c.calls.filter((x) => x.endpoint === 'open-with-editor')[0]
  assert.ok(openedCall, 'the editor route was asked')
  assert.equal(openedCall.payload.path, 'D:/ws/abs.js', 'the absolute path reaches the host untouched')
})

test('the editor chip shows the shell’s own application icons', async () => {
  const file = { path: 'src/a.js', name: 'a.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9 }
  const boot = async (editor) => {
    const c = loadRealClient(async (endpoint) => {
      if (endpoint === 'editors') return { editors: [] }
      if (endpoint === 'summary') return { files: [file], latestTurn: 5 }
      if (endpoint === 'turn') return { turn: 5, files: [file] }
      if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } }
      if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } }
      return {}
    }, editor ? { editor } : {})
    const view = c.slotComp('conversation.view', 'review')
    let tree = null
    for (let i = 0; i < 3; i++) { tree = c.render(view.Comp({ sessionId: 'session-root' })); await new Promise((r) => setTimeout(r, 60)) }
    // toolbar → EditorPicker → chip → label → EditorIcon: the harness renders one
    // component level at a time, so walk it explicitly.
    const pickerView = c.render(c.collect(tree, 'cdx-toolbar-editor')[0].children[0])
    const label = c.collect(pickerView, 'drv-editor-label')[0]
    // The chip's label wraps icon + text in a Fragment, so search the subtree.
    const findIcon = (node) => {
      if (!node || typeof node !== 'object') return null
      if (typeof node.type === 'function' && node.type.name === 'EditorIcon') return node
      for (const ch of node.children || []) { const hit = findIcon(ch); if (hit) return hit }
      return null
    }
    return c.render(findIcon(label))
  }
  const icon = await boot({ id: 'vscode', name: 'Visual Studio Code' })
  assert.equal(icon.props.className, 'drv-editor-icon', 'a real application icon is used')
  assert.equal(icon.props.src, '/open-in-app/icon/vscode', 'served by the shell icon route (same mark as its own menu)')
  // Editors the shell's catalog does not know keep the letter avatar.
  const fallback = await boot({ id: 'notepadpp', name: 'Notepad++' })
  assert.equal(fallback.props.className, undefined, 'no img for an unmapped editor')
  assert.equal(fallback.children[0], 'N', 'the letter avatar is used instead')
})

test('editor probing runs once, not on every review-tab visit', async () => {
  const editorCalls = []
  const file = { path: 'src/a.js', name: 'a.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9 }
  const c = loadRealClient(async (endpoint) => {
    if (endpoint === 'editors') { editorCalls.push(1); return { editors: [{ id: 'vscode', name: 'Visual Studio Code', detected: true }] } }
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 }
    if (endpoint === 'turn') return { turn: 5, files: [file] }
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } }
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } }
    return {}
  })
  const view = c.slotComp('conversation.view', 'review')
  const draw = () => c.render(view.Comp({ sessionId: 'session-root' }))
  let tree = null
  for (let visit = 0; visit < 3; visit++) { tree = draw(); await new Promise((r) => setTimeout(r, 60)) }
  assert.equal(editorCalls.length, 1, 'the probe runs once for the session, not on every visit')
  // …and the picker offers an explicit re-probe for after installing something new.
  const pickerOf = (t) => c.render(c.collect(t, 'cdx-toolbar-editor')[0].children[0])
  pickerOf(tree) // mounting the picker must not probe again
  assert.equal(editorCalls.length, 1, 'mounting the picker does not re-probe')
  c.collect(pickerOf(draw()), 'drv-editor-btn')[0].props.onClick() // open the menu
  const rescan = c.collect(pickerOf(draw()), 'drv-editor-rescan')[0]
  assert.ok(rescan, 'the menu offers a re-probe entry')
  rescan.props.onClick()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(editorCalls.length, 2, 'the re-probe entry asks the host again')
})

test('the review tab label exposes the stable selector the pill clicks', () => {
  const c = loadRealClient(async () => ({}))
  const def = c.slotComp('conversation.view', 'review').def
  const label = c.render(def.label())
  assert.equal(label.props['data-dsh-view'], 'review', 'the label anchors the DOM fallback')
  assert.equal(c.collect(label, 'drv-tab-label').length, 1)
})

test('the running pill switches views through the official store action', async () => {
  const file = { path: 'src/a.js', name: 'a.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9 }
  const c = loadRealClient(async (endpoint) => {
    if (endpoint === 'editors') return { editors: [] }
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 }
    if (endpoint === 'turn') return { turn: 5, files: [file] }
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } }
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } }
    return {}
  }, { sessionsById: { 'session-root': { running: true, cwd: 'D:/ws' } } })
  const opened = []
  const acknowledged = []
  const viewProps = (extra) => Object.assign({
    sessionId: 'session-root',
    openView: (view, focus) => opened.push([view, focus]),
    completeViewRequest: () => acknowledged.push(1),
    viewRequest: { view: 'review', focus: 'jump' }
  }, extra || {})
  c.render(c.slotComp('conversation.session.header.actions').Comp({ sessionId: 'session-root' }))
  await new Promise((r) => setTimeout(r, 40))
  const view = c.slotComp('conversation.view', 'review')
  // The shell hands conversation.view entries openView; capturing it there is what
  // lets the pill — whose own slot never receives it — switch views officially.
  c.render(view.Comp(viewProps()))
  await new Promise((r) => setTimeout(r, 40))
  c.render(view.Comp(viewProps()))
  assert.equal(acknowledged.length >= 1, true, 'the one-shot view request is acknowledged')

  const pillEl = c.render(c.slotComp('conversation.composer.dock').Comp({ sessionId: 'session-root' }))
  assert.ok(pillEl && pillEl.props && pillEl.props.className === 'cdx-pill', 'the pill renders while the session is running')
  pillEl.props.onClick()
  assert.equal(opened.length, 1, 'the click asked the shell for the review view')
  assert.equal(opened[0][0], 'review')
})

test('the running pill cannot be squeezed into a one-glyph column by the dock row', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const rule = /\.cdx-pill \{[^}]*\}/.exec(source)
  assert.ok(rule, 'the .cdx-pill rule ships')
  // Host 0.1.6 wraps `conversation.composer.dock` in a horizontal flex row
  // (.uV2eYG_dock) next to the built-in ContextMeter (flex:none) and to other
  // plugins' entries. CJK text breaks between every glyph, so this pill was the
  // only item that could shrink and it collapsed to one character per line —
  // with border-radius:999px, a ball. The shrink guard is the fix.
  assert.match(rule[0], /flex:0 0 auto/, 'the pill refuses to shrink')
  assert.match(rule[0], /white-space:nowrap/, 'the label stays on one line')
  // The chip wears the per-turn card's skin — same fill, border, radius and count
  // colors (theme tokens), so the two never drift apart again.
  assert.match(rule[0], /--dsw-static-neutral-50/, 'the chip takes the card fill token')
  assert.match(rule[0], /--dsw-alias-border-l1/, 'and the card border token')
  assert.match(rule[0], /border-radius:16px/, 'and the card radius')
  assert.equal(/colors\.turn|turnBg|turnBorder/.test(source), false, 'no plugin palette left on the chip or card')
})

test('the turn card registration serves both host slot generations (chain <=0.1.5, list 0.1.6+)', async () => {
  const file = { path: 'src/a.js', name: 'a.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9 }
  const c = loadRealClient(async (endpoint) => {
    if (endpoint === 'editors') return { editors: [] }
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 }
    if (endpoint === 'turn') return { turn: 5, files: [file] }
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } }
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } }
    return {}
  })
  const tail = c.slotComp('conversation.chat.turnTail')
  assert.ok(tail, 'the per-turn card is registered')
  // 0.1.6+ (list): a stable id is mandatory — the registry stub above throws
  // without it, exactly like the host, which is how the card went missing.
  assert.equal(typeof tail.def.id, 'string', 'the list host addresses the entry by id')
  assert.equal(typeof tail.def.order, 'number', 'the list host orders it among the contributions')
  // <=0.1.5 (chain): `select` is the mandatory election there.
  assert.equal(typeof tail.def.select, 'function', 'the chain host still gets its selector')
  assert.equal(tail.def.select({ turn: { turn: 5 } }).turn, 5)
  assert.equal(tail.def.select({ turn: {} }), null, 'a turn without a number declines')
  // New-host props: the TurnLocation arrives directly and there is no `matched`.
  // Reading `matched.turn` alone left the card blank on 0.1.6.
  const props = { sessionId: 'session-root', turn: { turn: 5 }, seq: 3, openFile: () => {} }
  c.render(tail.Comp(props))
  await new Promise((r) => setTimeout(r, 40))
  const tree = c.render(tail.Comp(props))
  // The card wears the official changed-files skin (cdx-cf-*), so assert on its markup.
  const titles = c.collect(tree, 'cdx-cf-title')
  assert.equal(titles.length, 1, 'the per-turn card renders from the owner props alone')
  assert.match(String(titles[0].props.title), /a\.js/, 'the card names the edited file')
  assert.equal(c.collect(tree, 'cdx-cf-tile').length, 1, 'the header shows the official tile')
  assert.equal(c.collect(tree, 'cdx-cf-btn').length, 2, 'the plugin still offers 撤销 / 审核')
})

test('the per-turn card folds past three files, like the official card', async () => {
  const files = [1, 2, 3, 4, 5].map((n) => ({ path: `src/f${n}.js`, name: `f${n}.js`, cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: n, removed: 1, lastTime: 9 + n }))
  const c = loadRealClient(async (endpoint) => {
    if (endpoint === 'editors') return { editors: [] }
    if (endpoint === 'summary') return { files, latestTurn: 5 }
    if (endpoint === 'turn') return { turn: 5, files }
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } }
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } }
    return {}
  })
  const tail = c.slotComp('conversation.chat.turnTail')
  const props = { sessionId: 'session-root', turn: { turn: 5 }, seq: 3, openFile: () => {} }
  c.render(tail.Comp(props))
  await new Promise((r) => setTimeout(r, 40))
  let tree = c.render(tail.Comp(props))
  assert.equal(c.collect(tree, 'cdx-cf-row').length, 3, '5 files fold down to the official 3-row summary')
  const fold = c.collect(tree, 'cdx-cf-toggle')[0]
  assert.ok(fold, 'the fold row is offered')
  assert.equal(fold.children[0].children[0], '全部 5 个文件')
  fold.props.onClick({ stopPropagation() {} })
  tree = c.render(tail.Comp(props))
  assert.equal(c.collect(tree, 'cdx-cf-row').length, 5, 'the fold row reveals every file')
  assert.equal(c.collect(tree, 'cdx-cf-toggle')[0].children[0].children[0], '收起')
  // <=3 files: no fold row at all, matching the official card.
  const short = loadRealClient(async (endpoint) => {
    if (endpoint === 'editors') return { editors: [] }
    if (endpoint === 'summary') return { files: files.slice(0, 3), latestTurn: 5 }
    if (endpoint === 'turn') return { turn: 5, files: files.slice(0, 3) }
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } }
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } }
    return {}
  })
  const shortTail = short.slotComp('conversation.chat.turnTail')
  short.render(shortTail.Comp(props))
  await new Promise((r) => setTimeout(r, 40))
  const shortTree = short.render(shortTail.Comp(props))
  assert.equal(short.collect(shortTree, 'cdx-cf-row').length, 3, 'a short list shows every row')
  assert.equal(short.collect(shortTree, 'cdx-cf-toggle').length, 0, 'and offers no fold row')
})

test('file-type marks come from the shell primitives when that module is present', async () => {
  const file = { path: 'src/a.js', name: 'a.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9 }
  const rpc = async (endpoint) => {
    if (endpoint === 'editors') return { editors: [] }
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 }
    if (endpoint === 'turn') return { turn: 5, files: [file] }
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } }
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } }
    return {}
  }
  // A stand-in for the shell's FileTypeIcon: the plugin must delegate to it, at the
  // row's size, instead of drawing its own letter chip.
  const seen = []
  const FileTypeIcon = (props) => {
    seen.push(props)
    return { type: 'span', props: { className: 'dsh-filetype-icon', 'data-path': props.path }, children: [] }
  }
  const withShell = loadRealClient(rpc, { primitives: { FileTypeIcon } })
  const view = withShell.slotComp('conversation.view', 'review')
  const settle = () => new Promise((r) => setTimeout(r, 60))
  // Render/settle passes: the stub runs effects during render and the async host
  // loads resolve between passes (same dance as the other review-view tests).
  let tree = null
  for (let i = 0; i < 5; i++) { tree = withShell.render(view.Comp({ sessionId: 'session-root' })); await settle() }
  assert.equal(withShell.collect(tree, 'cdx-fl-item').length, 1, 'the file row rendered')
  // The badge is a nested component: the harness renders one level at a time, so the
  // mark is reached by rendering the row's badge element itself.
  const badgeOf = (c, t) => c.collect(t, 'cdx-fl-item')[0].children
    .find((ch) => ch && typeof ch.type === 'function' && ch.type.name === 'FileTypeBadge')
  const mark = withShell.render(withShell.render(badgeOf(withShell, tree)).children[0])
  assert.equal(mark.props.className, 'dsh-filetype-icon', 'the shell mark is used inside the row')
  assert.equal(seen[0].path, 'src/a.js', 'the mark is asked for the row path')
  assert.equal(seen[0].size, 16, 'at the row size')
  // Without the module (Desktop / older compositions) the plugin still renders a mark.
  const withoutShell = loadRealClient(rpc)
  const view2 = withoutShell.slotComp('conversation.view', 'review')
  let tree2 = null
  for (let i = 0; i < 5; i++) { tree2 = withoutShell.render(view2.Comp({ sessionId: 'session-root' })); await settle() }
  const fallback = withoutShell.render(badgeOf(withoutShell, tree2))
  assert.equal(fallback.props.className, 'cdx-filetype', 'the letter chip is the fallback')
  assert.equal(fallback.children[0], 'JS', 'and it names the type')
})

test('the plugin takes the turn cards over: official ones hidden, ours marked apart', async () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const rule = /const OFFICIAL_CARD_CSS = "([^"]+)"/.exec(source)
  assert.ok(rule, 'the takeover rule ships')
  assert.match(rule[1], /\[data-changed-files\]/, 'the official changed-files card is targeted')
  // Delivery stays the shell's feature: its presented-files block is NOT hidden.
  assert.equal(/data-after-changes/.test(rule[1]), false, 'the official delivered-files block stays visible')
  // Our own card must not carry the official attribute, or the rule would hide it too.
  assert.equal(source.includes('"data-changed-files"'), false, 'our card never uses the official attribute')
  assert.equal(source.includes('"data-dsh-review-card"'), true, 'and carries its own marker instead')
  const file = { path: 'src/a.js', name: 'a.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9 }
  const c = loadRealClient(async (endpoint) => {
    if (endpoint === 'editors') return { editors: [] }
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 }
    if (endpoint === 'turn') return { turn: 5, files: [file] }
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } }
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } }
    return {}
  })
  const tail = c.slotComp('conversation.chat.turnTail')
  const props = { sessionId: 'session-root', turn: { turn: 5 }, seq: 3, openFile: () => {} }
  c.render(tail.Comp(props))
  await new Promise((r) => setTimeout(r, 40))
  const card = c.collect(c.render(tail.Comp(props)), 'cdx-cf-card')[0]
  assert.equal(card.props['data-dsh-review-card'], true, 'our card is marked with its own attribute')
  assert.equal(card.props['data-changed-files'], undefined, 'and not with the official one')
})

test('settings can hand the shell cards back', async () => {
  const c = loadRealClient(async () => ({}))
  const section = c.slotComp('settings.section', 'diff-review')
  assert.ok(section, 'the settings section registered')
  let tree = c.render(section.Comp({}))
  let box = c.collect(tree, 'drv-official-toggle')[0]
  assert.ok(box, 'the takeover toggle renders')
  assert.equal(box.props.checked, true, 'the plugin takes the cards over by default')
  box.props.onChange({ target: { checked: false } })
  tree = c.render(section.Comp({}))
  box = c.collect(tree, 'drv-official-toggle')[0]
  assert.equal(box.props.checked, false, 'unchecking hands them back to the shell')
})

test('the split divider clamps the file list so neither pane collapses', () => {
  const clampListWidth = clientFunction('clampListWidth')
  assert.equal(clampListWidth(300, 900, 140, 260), 300, 'a sane width passes through')
  assert.equal(clampListWidth(50, 900, 140, 260), 140, 'the list keeps its floor')
  assert.equal(clampListWidth(800, 900, 140, 260), 640, 'the diff keeps its share (900 - 260)')
  assert.equal(clampListWidth(400, 0, 140, 260), 400, 'an unknown pane width enforces only the floor')
  assert.equal(clampListWidth(NaN, 900, 140, 260), 140, 'a broken drag lands on the floor')
})

test('the review split view has a draggable divider that resizes the file list', async () => {
  const file = { path: 'src/a.js', name: 'a.js', cwd: 'D:/ws', ops: 1, writes: 0, edits: 1, added: 1, removed: 0, lastTime: 9 }
  const c = loadRealClient(async (endpoint) => {
    if (endpoint === 'editors') return { editors: [] }
    if (endpoint === 'summary') return { files: [file], latestTurn: 5 }
    if (endpoint === 'turn') return { turn: 5, files: [file] }
    if (endpoint === 'session/list') return { result: { ok: true, value: { items: [{ sessionId: 'session-root', cwd: 'D:/ws', projections: { asOfSeq: 1 } }] } } }
    if (endpoint === 'session/page') return { result: { ok: true, value: { records: [] } } }
    return {}
  })
  const view = c.slotComp('conversation.view', 'review')
  const draw = () => c.render(view.Comp({ sessionId: 'session-root' }))
  c.render(view.Comp({ sessionId: 'session-root' }))
  await new Promise((r) => setTimeout(r, 40))
  let tree = draw()
  const splitter = c.collect(tree, 'cdx-splitter')[0]
  assert.ok(splitter, 'the split view renders a divider between the panes')
  assert.equal(splitter.props.role, 'separator')
  assert.equal(c.collect(tree, 'cdx-filelist')[0].props.style, undefined, 'until dragged, CSS owns the width')
  // Drag right by 100px. The DOM-less harness has no pane metrics, so the math
  // falls back to the floor plus the pointer delta (default list width: 270px).
  splitter.props.onPointerDown({ clientX: 200, currentTarget: null, preventDefault() {} })
  splitter.props.onPointerMove({ clientX: 300 })
  splitter.props.onPointerUp({})
  const dragged = c.collect(draw(), 'cdx-filelist')[0]
  assert.equal(dragged.props.style.width, '370px', 'the list follows the divider')
  // Double-click drops the dragged width and hands the pane back to CSS.
  c.collect(draw(), 'cdx-splitter')[0].props.onDoubleClick()
  assert.equal(c.collect(draw(), 'cdx-filelist')[0].props.style, undefined, 'double-click restores the responsive default')
})
