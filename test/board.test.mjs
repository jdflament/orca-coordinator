import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { validateAgainst } from '../bin/lib/validate.mjs'
import { sandbox } from './helpers.mjs'

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

// ---- reconcile: decisions settle when their "settles when" holds (gh is the mocked boundary) ----

const PR = (n) => `https://github.com/acme/api/pull/${n}`

function reconcileBox(rules) {
  const box = sandbox()
  box.fake('gh', rules)
  const b = boardIn(box.state)
  const run = (...args) => {
    const r = spawnSync(process.execPath, [BOARD, ...args], { encoding: 'utf8', env: { ...box.env, COORDINATOR_BOARD: b.file, ORCA_COORDINATOR_CONFIG: box.configPath } })
    return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
  }
  run('init')
  return { box, b, run }
}

test('board reconcile: settles the decision whose PR merged, leaves the open PR and the decision without a condition', () => {
  const { box, b, run } = reconcileBox([
    { match: ['pr', 'view', PR(1)], stdout: JSON.stringify({ state: 'MERGED', reviews: [] }) },
    { match: ['pr', 'view', PR(2)], stdout: JSON.stringify({ state: 'OPEN', reviews: [] }) }
  ])
  run('ask', 'PROJ-1', '--url', PR(1), '--action', 'Merge', '--settles-when', 'pr-merged')
  run('ask', 'PROJ-2', '--url', PR(2), '--action', 'Merge', '--settles-when', 'pr-merged')
  run('ask', 'PROJ-3', '--url', PR(1), '--action', 'Decide')
  const out = run('reconcile')
  assert.equal(out.out, 'settled 1')
  const [d1, d2, d3] = b.read().decisions
  assert.equal(d1.status, 'answered')
  assert.equal(d2.status, 'pending')
  assert.equal(d3.status, 'pending', 'no settles-when: never touched')
  assert.equal(box.calls('gh').length, 2, 'gh is asked only for decisions with a condition')
})

test('board reconcile: pr-closed settles on closed, pr-reviewed only on a review by the configured GitHub user (not a pending one)', () => {
  const { run, b } = reconcileBox([
    { match: ['pr', 'view', PR(1)], stdout: JSON.stringify({ state: 'CLOSED', reviews: [] }) },
    { match: ['pr', 'view', PR(2)], stdout: JSON.stringify({ state: 'OPEN', reviews: [{ author: { login: 'bob' }, state: 'APPROVED' }, { author: { login: 'alex' }, state: 'PENDING' }] }) },
    { match: ['pr', 'view', PR(3)], stdout: JSON.stringify({ state: 'OPEN', reviews: [{ author: { login: 'alex' }, state: 'APPROVED' }] }) }
  ])
  run('ask', 'A', '--url', PR(1), '--settles-when', 'pr-closed')
  run('ask', 'B', '--url', PR(2), '--settles-when', 'pr-reviewed')
  run('ask', 'C', '--url', PR(3), '--settles-when', 'pr-reviewed')
  assert.equal(run('reconcile').out, 'settled 1\nsettled 3')
  assert.deepEqual(b.read().decisions.map((d) => d.status), ['answered', 'pending', 'answered'])
})

test('board reconcile: a failing gh changes nothing, writes nothing and exits 0', () => {
  const { run, b } = reconcileBox([{ match: ['pr', 'view'], stdout: '', status: 1 }])
  run('ask', 'PROJ-1', '--url', PR(1), '--settles-when', 'pr-merged')
  const before = fs.readFileSync(b.file, 'utf8')
  const r = run('reconcile')
  assert.equal(r.status, 0)
  assert.match(r.err, /gh failed for decision 1/)
  assert.equal(fs.readFileSync(b.file, 'utf8'), before)
})

test('board ask --settles-when: an unknown condition or a url that is not a GitHub PR is refused and nothing is written', () => {
  const b = boardIn()
  b.run('init')
  const before = fs.readFileSync(b.file, 'utf8')
  assert.match(b.run('ask', 'X', '--url', PR(1), '--settles-when', 'bogus').err, /must be one of pr-merged\|pr-closed\|pr-reviewed/)
  assert.match(b.run('ask', 'X', '--url', 'https://example.test/t/1', '--settles-when', 'pr-merged').err, /GitHub pull request URL/)
  assert.equal(fs.readFileSync(b.file, 'utf8'), before)
  assert.equal(b.run('ask', 'Y', '--url', PR(1), '--settles-when', 'pr-merged').status, 0)
  assert.equal(b.read().decisions[0].settlesWhen, 'pr-merged')
})

// ---- retention: finished items leave the board on their own, open ones never ----

const HOUR = 3600000
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString()

function retentionBox(board, retentionHours) {
  const box = sandbox({ config: retentionHours === undefined ? {} : { board: { retentionHours } } })
  const file = path.join(box.state, 'board.json')
  box.run('bin/board.mjs', ['init'])
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...board }))
  const run = (...args) => box.run('bin/board.mjs', args)
  const archiveDir = path.join(box.state, 'archive')
  const archive = () => (fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).map((f) => fs.readFileSync(path.join(archiveDir, f), 'utf8')).join('\n') : '')
  return { run, archive, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) }
}

const opt = { id: 'done', label: 'Do' }
const decision = (id, status, title, at) => ({ id, title, repo: '', url: '', action: 'Decide', context: '', options: [opt], status, createdAt: ago(900), ...(status === 'answered' ? { answer: 'Do', answeredAt: at } : {}) })
const finishedBoard = () => ({
  tasks: [
    { id: 'OLD-1', ws: '', repo: 'api', status: 'merged', url: '', detail: '', mergedAt: ago(30) },
    { id: 'NEW-2', ws: '', repo: 'api', status: 'merged', url: '', detail: '', mergedAt: ago(1) },
    { id: 'OPEN-3', ws: '', repo: 'api', status: 'pr', url: '', detail: '' }
  ],
  decisions: [decision(1, 'answered', 'old answered', ago(30)), decision(2, 'answered', 'fresh answered', ago(1)), decision(3, 'pending', 'ancient but open')],
  log: [{ at: ago(30), text: 'old entry' }, { at: ago(1), text: 'fresh entry' }]
})

test('board retention (reconcile): old finished items move to the archive, fresh and open ones stay, a second run changes nothing', () => {
  const { run, read, archive } = retentionBox(finishedBoard())
  assert.equal(run('reconcile').status, 0)
  const board = read()
  assert.deepEqual(board.tasks.map((t) => t.id), ['NEW-2', 'OPEN-3'])
  assert.deepEqual(board.decisions.map((d) => d.id), [2, 3], 'an open decision never moves, however old')
  assert.ok(!board.log.some((e) => e.text === 'old entry') && board.log.some((e) => e.text === 'fresh entry'))
  assert.match(archive(), /task OLD-1[^\n]*merged/)
  assert.match(archive(), /decision 1: old answered/)
  assert.match(archive(), /log [^\n]*old entry/)
  const [boardText, archiveText] = [JSON.stringify(board), archive()]
  run('reconcile')
  assert.equal(JSON.stringify(read()), boardText, 'idempotent')
  assert.equal(archive(), archiveText)
})

test('board retention: appends to the month file instead of overwriting, and a finished item with no recorded time is stamped, not dropped', () => {
  const { run, read, archive } = retentionBox({ ...finishedBoard(), decisions: [decision(1, 'answered', 'no time recorded', undefined)] })
  run('reconcile')
  assert.equal(read().decisions.length, 1, 'kept: its age is unknown')
  assert.ok(read().decisions[0].answeredAt, 'stamped now, so it ages out later')
  run('archive')
  run('task:add', 'LATE-4', '--status', 'merged')
  run('task:set', 'LATE-4', '--status', 'merged')
  run('archive')
  const text = archive()
  assert.match(text, /task OLD-1/)
  assert.match(text, /task LATE-4/, 'the second archive appended; the first entries are still there')
  assert.equal((text.match(/^# Done /gm) || []).length, 1, 'one heading: appended, never rewritten')
})

test('board retention: board.retentionHours 0 keeps everything until `archive`, and `archive --older-than` leaves fresh items', () => {
  const { run, read } = retentionBox(finishedBoard(), 0)
  run('reconcile')
  assert.equal(read().tasks.length, 3, '0 turns the automatic move off')
  run('archive', '--older-than', '12')
  assert.deepEqual(read().tasks.map((t) => t.id), ['NEW-2', 'OPEN-3'])
  run('archive')
  assert.deepEqual(read().tasks.map((t) => t.id), ['OPEN-3'], 'plain archive keeps its meaning: every finished item')
})
