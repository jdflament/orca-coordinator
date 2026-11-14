// bin/statusline.sh: the role badge in Claude Code's status line, and its install/doctor in
// coordinator.mjs (init, doctor, `statusline`, uninstall). The worker signal is the plugin's
// <state>/worker-terminals file; the script never reads Orca's own files.
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

function setup({ chain, workers = [WORKER] } = {}) {
  const box = sandbox()
  fs.mkdirSync(box.state, { recursive: true })
  fs.writeFileSync(path.join(box.state, 'coordinator-terminal'), COORD + '\n')
  if (chain !== undefined) fs.writeFileSync(path.join(box.state, 'statusline-chain'), chain + '\n')
  if (workers) fs.writeFileSync(path.join(box.state, 'worker-terminals'), workers.map((w) => w + '\n').join(''))
  const render = (handle, extraEnv = {}) => {
    const env = { ...box.env, COORDINATOR_STATE: box.state, ...extraEnv }
    if (handle) env.ORCA_TERMINAL_HANDLE = handle
    const r = spawnSync('/bin/bash', [SCRIPT], { input: SAMPLE, encoding: 'utf8', env, timeout: 5000 })
    return { status: r.status, out: r.stdout, err: r.stderr }
  }
  return { box, render }
}

test('statusline: the coordinator terminal shows ◆ COORDINATOR and nothing about workers', () => {
  const { render } = setup()
  const r = render(COORD)
  assert.equal(r.status, 0)
  assert.match(r.out, /◆ COORDINATOR/)
  assert.doesNotMatch(r.out, /WORKER/)
})

test('statusline: a terminal listed in worker-terminals shows WORKER', () => {
  const { render } = setup()
  const r = render(WORKER)
  assert.equal(r.status, 0)
  assert.match(r.out, /WORKER/)
  assert.doesNotMatch(r.out, /COORDINATOR/)
})

test('statusline: a chat by hand, a handle that only contains a listed one, or a terminal outside Orca shows no badge', () => {
  const { render } = setup()
  assert.equal(render('term_hand-9').out, '', 'Orca terminal not in the file')
  assert.equal(render('term_worker').out, '', 'whole-line match: a prefix of a listed handle is not listed')
  assert.equal(render(undefined).out, '', 'terminal outside Orca')
})

test('statusline: no worker-terminals file means no WORKER badge, not an error; the coordinator badge stays', () => {
  const { render } = setup({ workers: null })
  assert.deepEqual([render(WORKER).status, render(WORKER).out], [0, ''])
  assert.match(render(COORD).out, /◆ COORDINATOR/)
})

test('statusline: never reads Orca\'s database (an Orca terminal with a dispatch row but no file gets nothing)', () => {
  const { box, render } = setup({ workers: null })
  const db = path.join(box.dir, 'orchestration.db')
  fs.writeFileSync(db, 'not a database')
  assert.equal(render(WORKER, { ORCA_ORCHESTRATION_DB: db }).out, '')
  assert.doesNotMatch(fs.readFileSync(SCRIPT, 'utf8'), /sqlite3|orchestration\.db|dispatch_contexts/)
})

test('statusline: the chained command gets the status JSON (no shell, ~ expanded) and prints before the badge', () => {
  const { box, render } = setup({ chain: '~/chain.sh arg' })
  fs.writeFileSync(path.join(box.home, 'chain.sh'), '#!/bin/sh\nprintf "ORCA:%s:" "$1"; cat\n', { mode: 0o755 })
  const r = render(COORD)
  assert.ok(r.out.startsWith(`ORCA:arg:${SAMPLE}`), r.out)
  assert.match(r.out, /◆ COORDINATOR/)
  assert.equal(render('term_hand-9').out, `ORCA:arg:${SAMPLE}`, 'plain sessions keep the chained line, add nothing')
})

test('statusline: a chain that needs shell syntax is not run (no shell string), and the badge still shows', () => {
  const { box, render } = setup()
  const marker = path.join(box.dir, 'marker')
  fs.writeFileSync(path.join(box.state, 'statusline-chain'), `echo pwned > ${marker}; exit 3\n`)
  const r = render(WORKER)
  assert.equal(r.status, 0)
  assert.match(r.out, /WORKER/)
  assert.equal(r.err, '')
  assert.ok(!fs.existsSync(marker), 'nothing ran')
})

test('statusline: a failing chained command does not hide the badge or leak its error', () => {
  const { render } = setup({ chain: '/bin/sh -n /nonexistent-file' })
  const r = render(WORKER)
  assert.equal(r.status, 0)
  assert.match(r.out, /WORKER/)
  assert.equal(r.err, '')
})

test('statusline: a chain that points back at the script terminates', () => {
  const { render } = setup({ chain: `bash ${SCRIPT}` })
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
