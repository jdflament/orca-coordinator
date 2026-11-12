import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { validateAgainst } from '../bin/lib/validate.mjs'

const BOARD = new URL('../bin/board.mjs', import.meta.url).pathname
const SCHEMA = JSON.parse(fs.readFileSync(new URL('../schema/board.schema.json', import.meta.url), 'utf8'))

function boardIn(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'))) {
  const file = path.join(dir, 'board.json')
  const inbox = path.join(dir, 'inbox.jsonl')
  const run = (args, { preload } = {}) => {
    const node = preload ? ['--import', preload] : []
    const result = spawnSync(process.execPath, [...node, BOARD, ...args], { encoding: 'utf8', env: { ...process.env, COORDINATOR_BOARD: file } })
    return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim() }
  }
  return { dir, file, inbox, run: (...args) => run(args), runWith: run, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) }
}

const click = (entry) => JSON.stringify({ at: '2026-11-11T10:00:00Z', ...entry }) + '\n'

test('board ask: default options are done/skip/explain with the action recommended (the panel answers by these ids)', () => {
  const b = boardIn()
  b.run('init')
  assert.equal(b.run('ask', 'PROJ-101', '--action', 'Merge', '--oncall').out, '1')
  const d = b.read().decisions[0]
  assert.deepEqual(d.options, [
    { id: 'done', label: 'Merge', recommended: true },
    { id: 'skip', label: 'Skip' },
    { id: 'explain', label: 'Explain' }
  ])
  assert.equal(d.oncall, true)
})

test('board task:set: an unknown status is refused and the board is not written', () => {
  const b = boardIn()
  b.run('init')
  b.run('task:add', 'PROJ-101', '--status', 'pr')
  const before = fs.readFileSync(b.file, 'utf8')
  const bad = b.run('task:set', 'PROJ-101', '--status', 'bogus')
  assert.equal(bad.status, 1)
  assert.match(bad.err, /must be one of local\|pr\|hold\|blocked\|merged/)
  assert.equal(fs.readFileSync(b.file, 'utf8'), before)
})

test('board verbs: what they write validates against the schema (--pr stored as a number)', () => {
  const b = boardIn()
  b.run('init')
  b.run('ws:add', 'PROJ-100', '--title', 'Checkout', '--status', 'active')
  b.run('task:add', 'PROJ-101', '--ws', 'PROJ-100', '--status', 'pr', '--pr', '42', '--url', 'https://github.com/acme/api/pull/42')
  b.run('repo:add', 'api', '--id', 'PROJ-101')
  b.run('agent:set', 'pr-review: api#42', 'working', '--id', 'ctx_1')
  b.run('instruction:add', 'no merges on Friday')
  b.run('ask', 'PROJ-101')
  const board = b.read()
  assert.equal(board.tasks[0].pr, 42)
  assert.deepEqual(validateAgainst(SCHEMA, board), [])
  assert.equal(b.run('validate').status, 0)
})

test('board answer + clean: the answer records the label, clean drops answered decisions only', () => {
  const b = boardIn()
  b.run('init')
  b.run('ask', 'A', '--action', 'Merge')
  b.run('ask', 'B')
  assert.equal(b.run('answer', '1', 'done').out, '1 → Merge')
  assert.equal(b.run('clean').out, 'decision 1')
  assert.deepEqual(b.read().decisions.map((d) => d.title), ['B'])
})

test('board show: workstream progress counts merged tasks', () => {
  const b = boardIn()
  b.run('init')
  b.run('ws:add', 'W', '--title', 'Checkout redesign', '--status', 'active')
  b.run('task:add', 'T1', '--ws', 'W', '--status', 'merged')
  b.run('task:add', 'T2', '--ws', 'W', '--status', 'pr')
  assert.match(b.run('show').out, /Checkout redesign.*active \(50%\)/)
})

test('board: a hand-edited invalid file is reported by validate and refused on write', () => {
  const b = boardIn()
  fs.writeFileSync(b.file, JSON.stringify({ version: 2, updatedAt: 'x', decisions: [], workstreams: [], tasks: [{ id: 'T-1', status: 'done' }], repos: [], agents: [], log: [] }))
  const check = b.run('validate')
  assert.equal(check.status, 1)
  assert.match(check.out, /tasks\[0\]\.status: must be one of/)
  const write = b.run('log', 'hello')
  assert.equal(write.status, 1)
  assert.match(write.err, /refusing to write an invalid board/)
})

test('board: a board.json that is not JSON is refused, never replaced by an empty board (bug 1)', () => {
  const b = boardIn()
  b.run('init')
  b.run('task:add', 'PROJ-1')
  const corrupt = fs.readFileSync(b.file, 'utf8').slice(0, -20)
  fs.writeFileSync(b.file, corrupt)
  const write = b.run('log', 'hello')
  assert.equal(write.status, 1)
  assert.match(write.err, /cannot read .*board\.json/)
  assert.equal(fs.readFileSync(b.file, 'utf8'), corrupt)
  assert.equal(b.run('show').status, 1)
})

test('board: a missing board.json still starts empty', () => {
  const b = boardIn()
  assert.equal(b.run('log', 'first').status, 0)
  assert.equal(b.read().log[0].text, 'first')
})

test('board inbox: panel clicks are applied (decision answer and command)', () => {
  const b = boardIn()
  b.run('init')
  b.run('ask', 'PROJ-7', '--action', 'Merge')
  fs.writeFileSync(b.inbox, click({ kind: 'decision', decisionId: '1', optionId: 'skip' }) + click({ kind: 'command', command: 'nudge', target: 'PROJ-9' }))
  assert.equal(JSON.parse(b.run('inbox').out).applied, 2)
  const board = b.read()
  assert.equal(board.decisions[0].answer, 'skip')
  assert.ok(board.log.some((e) => e.text === 'user command: nudge PROJ-9'))
  assert.deepEqual(fs.readdirSync(b.dir).filter((f) => f.startsWith('inbox')), [], 'drained entries are not applied twice')
})

test('board inbox: one bad line does not drop the others; it is kept aside, not lost (bug 5)', () => {
  const b = boardIn()
  b.run('init')
  b.run('ask', 'PROJ-7')
  fs.writeFileSync(b.inbox, '{"kind":"decision","decisionId":"1",\n' + click({ kind: 'decision', decisionId: '1', optionId: 'done' }))
  const out = b.run('inbox')
  assert.equal(out.status, 0)
  const drained = JSON.parse(out.out)
  assert.equal(drained.applied, 1)
  assert.equal(drained.rejected, 1)
  assert.equal(b.read().decisions[0].status, 'answered')
  assert.equal(fs.readFileSync(path.join(b.dir, 'inbox.rejected.jsonl'), 'utf8'), '{"kind":"decision","decisionId":"1",\n')
})

test('board inbox: a click the panel appends while the inbox is drained is kept for the next drain (bug 13)', () => {
  const b = boardIn()
  b.run('init')
  b.run('ask', 'A')
  b.run('ask', 'B')
  fs.writeFileSync(b.inbox, click({ kind: 'decision', decisionId: '1', optionId: 'done' }))
  // Simulate the panel writing a click right after the board read the inbox.
  const preload = path.join(b.dir, 'race.mjs')
  fs.writeFileSync(preload, `import fs from 'node:fs'
const read = fs.readFileSync
let fired = false
fs.readFileSync = function (file, ...rest) {
  const out = read.call(fs, file, ...rest)
  if (!fired && String(file).includes('inbox')) { fired = true; fs.appendFileSync(${JSON.stringify(b.inbox)}, ${JSON.stringify(click({ kind: 'decision', decisionId: '2', optionId: 'skip' }))}) }
  return out
}
`)
  assert.equal(JSON.parse(b.runWith(['inbox'], { preload }).out).applied, 1)
  assert.equal(JSON.parse(b.run('inbox').out).applied, 1, 'the late click is drained next time')
  assert.deepEqual(b.read().decisions.map((d) => d.status), ['answered', 'answered'])
})

test('board inbox: when the board cannot be written, the clicks stay in the inbox', () => {
  const b = boardIn()
  b.run('init')
  b.run('ask', 'A')
  const board = b.read()
  board.tasks.push({ id: 'T', status: 'bogus' })
  fs.writeFileSync(b.file, JSON.stringify(board))
  const line = click({ kind: 'decision', decisionId: '1', optionId: 'done' })
  fs.writeFileSync(b.inbox, line)
  assert.equal(b.run('inbox').status, 1)
  const left = fs.readdirSync(b.dir).filter((f) => f.startsWith('inbox') && !f.includes('rejected')).map((f) => fs.readFileSync(path.join(b.dir, f), 'utf8')).join('')
  assert.equal(left, line)
  board.tasks = []
  fs.writeFileSync(b.file, JSON.stringify(board))
  assert.equal(JSON.parse(b.run('inbox').out).applied, 1, 'the next drain applies them')
})
