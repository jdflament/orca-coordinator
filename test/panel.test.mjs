// Runs the panel's inline script over a stub DOM and a host that validates request input as JSON,
// the way Orca does: `{ seen: undefined }` is "input: Invalid input".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../plugin/panel/index.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*)<\/script>/)[1]

function element() {
  const target = function () {}
  const self = new Proxy(target, {
    get: (_, key) => (key === 'textContent' || key === 'innerHTML' || key === 'value' ? (target[key] ?? '') : key in target ? target[key] : key === Symbol.toPrimitive ? () => '' : key === 'hidden' ? false : self),
    set: (_, key, value) => ((target[key] = value), true),
    apply: () => self
  })
  return self
}

function mountPanel(handlers) {
  const elements = new Map()
  const byId = (id) => (elements.has(id) ? elements.get(id) : (elements.set(id, element()), elements.get(id)))
  const calls = []
  const orca = {
    plugin: {
      on() {},
      async request(name, params) {
        calls.push({ name, params })
        if (params !== undefined && JSON.stringify(params) !== JSON.stringify(JSON.parse(JSON.stringify(params, (_, v) => (v === undefined ? '\u0000undefined' : v))))) {
          throw new Error('input: Invalid input')
        }
        const handler = handlers[name]
        if (!handler) throw new Error('unknown_method')
        return handler(params)
      }
    }
  }
  const context = { orca, document: { getElementById: byId, addEventListener() {}, createElement: element, body: element() }, window: {}, setInterval() {}, setTimeout() {}, clearTimeout() {}, console, Set, Map }
  context.window = context
  vm.runInNewContext(script, context)
  return { calls, byId }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('the first board.get sends params that are valid JSON (no undefined `seen`)', async () => {
  const panel = mountPanel({ 'setup.status': () => ({ configured: true }), 'board.get': () => ({}) })
  await settle()
  const board = panel.calls.find((call) => call.name === 'board.get')
  assert.ok(board, 'the panel asked for the board')
  assert.ok(!Object.values(board.params ?? {}).includes(undefined), 'no undefined values in the request input')
  assert.doesNotMatch(String(panel.byId('updated').textContent), /Invalid input/)
})

test('a failed board load says what failed, not a bare "error: …"', async () => {
  const panel = mountPanel({ 'setup.status': () => ({ configured: true }), 'board.get': () => { throw new Error('worker exploded') } })
  await settle()
  assert.equal(panel.byId('updated').textContent, 'Could not load the board: worker exploded')
})
