// bin/statusline.sh: the role badge in Claude Code's status line, and its install/doctor in
// coordinator.mjs (init, doctor, `statusline`, uninstall). Orca's orchestration database
// (dispatch_contexts) is the worker signal; tests build a real one.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ok, ROOT, sandbox } from './helpers.mjs'

const SCRIPT = path.join(ROOT, 'bin', 'statusline.sh')
const COORD = 'term_coord-1'
const WORKER = 'term_worker-2'
const SAMPLE = '{"model":{"display_name":"Opus"},"rate_limits":{}}'
const hasSqlite = spawnSync('sqlite3', ['--version']).status === 0
const needsSqlite = { skip: hasSqlite ? false : 'sqlite3 not on PATH' }

function setup({ chain, rows = [[WORKER, COORD]] } = {}) {
  const box = sandbox()
  fs.mkdirSync(box.state, { recursive: true })
  fs.writeFileSync(path.join(box.state, 'coordinator-terminal'), COORD + '\n')
  if (chain !== undefined) fs.writeFileSync(path.join(box.state, 'statusline-chain'), chain + '\n')
  const db = path.join(box.dir, 'orchestration.db')
  if (hasSqlite) {
    const values = rows.map(([a, c]) => `('ctx_${a}_${c}', '${a}', ${c ? `'${c}'` : 'NULL'})`).join(',')
    const sql = `CREATE TABLE dispatch_contexts (id TEXT PRIMARY KEY, assignee_handle TEXT, creator_handle TEXT);${rows.length ? `INSERT INTO dispatch_contexts VALUES ${values};` : ''}`
    assert.equal(spawnSync('sqlite3', [db, sql]).status, 0)
  }
  const render = (handle, extraEnv = {}) => {
    const env = { ...box.env, COORDINATOR_STATE: box.state, ORCA_ORCHESTRATION_DB: db, ...extraEnv }
    if (handle) env.ORCA_TERMINAL_HANDLE = handle
    const r = spawnSync('/bin/bash', [SCRIPT], { input: SAMPLE, encoding: 'utf8', env, timeout: 5000 })
    return { status: r.status, out: r.stdout, err: r.stderr }
  }
  return { box, db, render }
}

test('statusline: the coordinator terminal shows ◆ COORDINATOR and nothing about workers', needsSqlite, () => {
  const { render } = setup()
  const r = render(COORD)
  assert.equal(r.status, 0)
  assert.match(r.out, /◆ COORDINATOR/)
  assert.doesNotMatch(r.out, /WORKER/)
})

test('statusline: a terminal Orca dispatched a worker to shows WORKER', needsSqlite, () => {
  const { render } = setup()
  const r = render(WORKER)
  assert.equal(r.status, 0)
  assert.match(r.out, /WORKER/)
  assert.doesNotMatch(r.out, /COORDINATOR/)
})

test('statusline: a chat started by hand, Orca bookkeeping or a terminal outside Orca shows no badge', needsSqlite, () => {
  const { render } = setup({ rows: [[WORKER, COORD], ['term_self-3', 'term_self-3']] })
  assert.equal(render('term_hand-9').out, '', 'Orca terminal with no dispatch')
  assert.equal(render('term_self-3').out, '', 'Orca bookkeeping row (creator is its own assignee) is not a dispatch')
  assert.equal(render(undefined).out, '', 'terminal outside Orca')
})

test('statusline: a handle that is not a plain id never reaches the SQL query', needsSqlite, () => {
  const { render } = setup()
  assert.equal(render(`x' OR '1'='1`).out, '')
})

test('statusline: no orchestration database or no sqlite3 means no badge, not an error', () => {
  const { box, render } = setup()
  const missing = render(WORKER, { ORCA_ORCHESTRATION_DB: path.join(box.dir, 'absent.db') })
  assert.deepEqual([missing.status, missing.out], [0, ''])
  const bin = path.join(box.dir, 'bare-bin')
  fs.mkdirSync(bin)
  fs.symlinkSync('/bin/cat', path.join(bin, 'cat'))
  const noSqlite = render(WORKER, { PATH: bin })
  assert.deepEqual([noSqlite.status, noSqlite.out], [0, ''])
})

test('statusline: the chained command gets the status JSON and prints before the badge', needsSqlite, () => {
  const { render } = setup({ chain: `sed 's/^/ORCA:/'` })
  const r = render(COORD)
  assert.ok(r.out.startsWith(`ORCA:${SAMPLE}`), r.out)
  assert.match(r.out, /◆ COORDINATOR/)
  assert.equal(render('term_hand-9').out, `ORCA:${SAMPLE}`, 'plain sessions keep the chained line, add nothing')
})

test('statusline: a failing chained command does not hide the badge or leak its error', needsSqlite, () => {
  const { render } = setup({ chain: 'echo boom >&2; exit 3' })
  const r = render(WORKER)
  assert.equal(r.status, 0)
  assert.match(r.out, /WORKER/)
  assert.equal(r.err, '')
})

test('statusline: a chain that points back at the script terminates', needsSqlite, () => {
  const { render } = setup({ chain: `bash ${JSON.stringify(SCRIPT)}` })
  const r = render(COORD)
  assert.equal(r.status, 0, 'no endless recursion (the spawn timeout would kill it)')
  assert.equal(r.out.match(/COORDINATOR/g).length, 1)
})

// ---- install / doctor ----

const initArgs = ['init', '--yes', '--no-plugin', '--github', 'alex', '--github-org', 'acme', '--statusline', '--coordinator-agent', 'claude']

function initBox() {
  const box = sandbox()
  box.fake('orca', [{ match: [], stdout: ok({ repos: [], worktrees: [], automations: [], plugins: [] }) }])
  box.fake('gh', [{ match: [], stdout: 'alex' }])
  return { box, file: path.join(box.home, '.claude', 'settings.json') }
}

test('init --statusline with no ~/.claude/settings.json creates it pointing at the script', () => {
  const { box, file } = initBox()
  const out = box.run('bin/coordinator.mjs', initArgs)
  assert.equal(out.status, 0, out.err)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, SCRIPT)
})

test('init --statusline leaves a settings.json it cannot parse untouched and reports the failure', () => {
  const { box, file } = initBox()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ "permissions": { // hand edit\n')
  const out = box.run('bin/coordinator.mjs', initArgs)
  assert.notEqual(out.status, 0)
  assert.match(out.out, /fail: .*settings\.json/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "permissions": { // hand edit\n')
})

test('init --statusline chains the existing command (Orca\'s) and keeps the other settings; a re-run does not chain itself', () => {
  const { box, file } = initBox()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, statusLine: { type: 'command', command: '/bin/sh ~/.orca/agent-hooks/claude-statusline.sh' } }))
  const out = box.run('bin/coordinator.mjs', initArgs)
  assert.equal(out.status, 0, out.err)
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(settings.statusLine.command, SCRIPT)
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] })
  assert.equal(fs.readFileSync(path.join(box.state, 'statusline-chain'), 'utf8'), '/bin/sh ~/.orca/agent-hooks/claude-statusline.sh\n')
  // Re-run: already ours, the saved chain is not overwritten with our own path.
  assert.equal(box.run('bin/coordinator.mjs', initArgs).status, 0)
  assert.equal(fs.readFileSync(path.join(box.state, 'statusline-chain'), 'utf8'), '/bin/sh ~/.orca/agent-hooks/claude-statusline.sh\n')
})

test('doctor: a statusLine replaced after install is reported with the command that re-chains it', () => {
  const box = sandbox({ config: { agents: { coordinator: { agent: 'claude', statusline: true } } } })
  box.fake('orca', [{ match: [], stdout: ok({ automations: [], plugins: [] }) }])
  const file = path.join(box.home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'something-else' } }))
  const replaced = box.run('bin/coordinator.mjs', ['doctor'])
  assert.match(replaced.out, /✗ status line: .*another command.*orca-coordinator statusline/)
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: SCRIPT } }))
  assert.match(box.run('bin/coordinator.mjs', ['doctor']).out, /✓ status line/)
})

test('statusline command: re-chains a replaced statusLine and touches nothing else init would', () => {
  const box = sandbox({ config: { agents: { coordinator: { agent: 'claude', statusline: true } } } })
  const file = path.join(box.home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'orca-new' } }))
  const out = box.run('bin/coordinator.mjs', ['statusline'])
  assert.equal(out.status, 0, out.err)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, SCRIPT)
  assert.equal(fs.readFileSync(path.join(box.state, 'statusline-chain'), 'utf8'), 'orca-new\n')
  assert.deepEqual(fs.readdirSync(box.state).sort(), ['statusline-chain'], 'no render, wrappers or state files')
  assert.deepEqual(box.calls('orca'), [], 'no plugin or automation calls')
})

test('uninstall puts back the chained statusLine and keeps the other settings', () => {
  const { box, file } = initBox()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, statusLine: { type: 'command', command: 'orca-statusline' } }))
  assert.equal(box.run('bin/coordinator.mjs', initArgs).status, 0)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, SCRIPT)
  const out = box.run('bin/coordinator.mjs', ['uninstall', '--yes'])
  assert.equal(out.status, 0, out.err)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { permissions: { allow: ['Bash(ls)'] }, statusLine: { type: 'command', command: 'orca-statusline' } })
})
