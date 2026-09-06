import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, isLoopbackRequest, inject } from '../lib/index.js'

/** Sandboxed profile dir per test, so flushes never touch real user data. */
function sandboxBaseUrl() {
  const dir = mkdtempSync(join(tmpdir(), 'drv-smoke-'))
  return { dir, url: pathToFileURL(dir + '\\').href }
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
  const files = parseReviewEvents([
    { type: 'turn/start', time: 1, data: { turn: 7 } },
    { type: 'tool/call', time: 2, data: { callId: 'direct', name: 'edit', arguments: { file_path: 'direct.js', old_string: 'a', new_string: 'b' } } },
    { type: 'tool/result', time: 3, data: { callId: 'direct', message: {} } },
    { type: 'tool/code-dispatch', time: 4, data: { name: 'edit', isError: false, arguments: { file_path: 'nested.js', old_string: 'x', new_string: 'y' } } },
    { type: 'tool/code-dispatch', time: 5, data: { name: 'write', isError: false, arguments: JSON.stringify({ file_path: 'created.js', content: 'hello\n' }) } },
    { type: 'tool/code-dispatch', time: 6, data: { name: 'edit', isError: true, arguments: { file_path: 'failed.js', old_string: 'x', new_string: 'z' } } }
  ])

  assert.deepEqual([...files.keys()], ['direct.js', 'nested.js', 'created.js'])
  assert.equal(files.get('nested.js').ops[0].kind, 'edit')
  assert.equal(files.get('nested.js').ops[0].turn, 7)
  assert.equal(files.get('created.js').ops[0].content, 'hello\n')
  assert.equal(files.has('failed.js'), false)
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

test('isLoopbackRequest fence accepts loopback and rejects foreign hosts', () => {
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1:43120' } }), true)
  assert.equal(isLoopbackRequest({ headers: { host: 'localhost:3080' } }), true)
  assert.equal(isLoopbackRequest({ headers: { host: 'evil.example.com' } }), false)
  assert.equal(isLoopbackRequest({ headers: {} }), false)
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1:43120', origin: 'http://evil.example.com' } }), false)
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' } }), true)
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'cross-site' } }), false)
})
