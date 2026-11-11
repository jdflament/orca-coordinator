import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { parseYaml, toYaml } from '../bin/lib/yaml.mjs'
import { ok, ROOT, sandbox } from './helpers.mjs'

const CLI = 'bin/coordinator.mjs'
const anyOk = (result = {}) => ({ match: [], stdout: ok(result) })
const readConfig = (file) => parseYaml(fs.readFileSync(file, 'utf8'))

// ---- uninstall ----

test('uninstall --purge without a terminal and without --yes refuses and changes nothing (bug 2)', () => {
  const box = sandbox()
  box.fake('orca', [anyOk({ automations: [], plugins: [] })])
  fs.mkdirSync(path.join(box.state, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(box.state, 'state.md'), 'keep me')
  const out = box.run(CLI, ['uninstall', '--purge'])
  assert.notEqual(out.status, 0)
  assert.match(out.err, /--yes/)
  assert.equal(fs.readFileSync(path.join(box.state, 'state.md'), 'utf8'), 'keep me')
  assert.ok(fs.existsSync(path.join(box.state, 'bin')), 'wrappers kept too: the refusal comes before any change')
  assert.ok(fs.existsSync(box.configPath))
  assert.deepEqual(box.calls('orca'), [])
})

test('uninstall --purge --config deletes that config and its state, not the folder around it nor the default config (bug 9)', () => {
  const box = sandbox()
  box.fake('orca', [anyOk({ automations: [], plugins: [] })])
  const otherState = path.join(box.dir, 'state2')
  fs.mkdirSync(otherState, { recursive: true })
  fs.writeFileSync(path.join(otherState, 'state.md'), 'x')
  const custom = path.join(box.dir, 'docs', 'coord.yaml')
  fs.mkdirSync(path.dirname(custom), { recursive: true })
  fs.writeFileSync(custom, toYaml({ person: { name: 'A' }, paths: { state: otherState, workspace: box.dir, orca: path.join(box.dir, 'fake', 'orca') } }))
  fs.writeFileSync(path.join(box.dir, 'docs', 'notes.txt'), 'mine')
  fs.mkdirSync(box.state, { recursive: true })
  const out = box.run(CLI, ['uninstall', '--purge', '--yes', '--config', custom])
  assert.equal(out.status, 0, out.err)
  assert.ok(!fs.existsSync(otherState))
  assert.ok(!fs.existsSync(custom))
  assert.equal(fs.readFileSync(path.join(box.dir, 'docs', 'notes.txt'), 'utf8'), 'mine')
  assert.ok(fs.existsSync(box.configPath), 'the default config is not the one being purged')
  assert.ok(fs.existsSync(box.state))
})

// ---- init ----

const initArgs = ['init', '--yes', '--no-plugin', '--github', 'alex', '--github-org', 'acme']

test('init --state wins over paths.state in an existing config (bug 8)', () => {
  const box = sandbox()
  box.fake('orca', [anyOk({ repos: [], worktrees: [] })])
  box.fake('gh', [{ match: [], stdout: 'alex' }])
  const wanted = path.join(box.dir, 'state-flag')
  const out = box.run(CLI, [...initArgs, '--state', wanted])
  assert.equal(out.status, 0, out.err)
  assert.equal(readConfig(box.configPath).paths.state, wanted)
  assert.ok(fs.existsSync(path.join(wanted, 'state.md')))
})

test('init re-run keeps the keys the config already had, unknown ones included', () => {
  const box = sandbox({ config: { custom: { note: 'hand-written' }, queue: { max: 7 } } })
  box.fake('orca', [anyOk({ repos: [], worktrees: [] })])
  box.fake('gh', [{ match: [], stdout: 'alex' }])
  assert.equal(box.run(CLI, initArgs).status, 0)
  const config = readConfig(box.configPath)
  assert.equal(config.custom.note, 'hand-written')
  assert.equal(config.queue.max, 7)
  assert.equal(config.person.name, 'Alex')
})

test('init --config writes that file and renders rules.local.md from its folder (bug 9)', () => {
  const box = sandbox({ writeConfig: false })
  box.fake('orca', [anyOk({ repos: [], worktrees: [] })])
  box.fake('gh', [{ match: [], stdout: 'alex' }])
  const custom = path.join(box.dir, 'cfg2', 'config.yaml')
  fs.mkdirSync(path.dirname(custom), { recursive: true })
  fs.writeFileSync(path.join(box.dir, 'cfg2', 'rules.local.md'), 'LOCAL RULE MARK\n')
  const out = box.run(CLI, [...initArgs, '--config', custom, '--state', box.state, '--workspace', box.dir])
  assert.equal(out.status, 0, out.err)
  assert.ok(fs.existsSync(custom))
  assert.ok(!fs.existsSync(box.configPath))
  assert.match(fs.readFileSync(path.join(box.state, 'COORDINATOR.md'), 'utf8'), /LOCAL RULE MARK/)
  assert.match(fs.readFileSync(path.join(box.state, 'bin', 'board'), 'utf8'), new RegExp(`ORCA_COORDINATOR_CONFIG='${custom}'`), 'wrappers find the same config')
})

test('init --statusline with no ~/.claude/settings.json creates it (bug 7)', () => {
  const box = sandbox()
  box.fake('orca', [anyOk({ repos: [], worktrees: [] })])
  box.fake('gh', [{ match: [], stdout: 'alex' }])
  const out = box.run(CLI, [...initArgs, '--statusline', '--coordinator-agent', 'claude'])
  assert.equal(out.status, 0, out.err)
  const settings = JSON.parse(fs.readFileSync(path.join(box.home, '.claude', 'settings.json'), 'utf8'))
  assert.match(settings.statusLine.command, /bin\/statusline\.sh$/)
})

test('init --statusline leaves a settings.json it cannot parse untouched and reports it', () => {
  const box = sandbox()
  box.fake('orca', [anyOk({ repos: [], worktrees: [] })])
  box.fake('gh', [{ match: [], stdout: 'alex' }])
  const file = path.join(box.home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ "permissions": { // hand edit\n')
  const out = box.run(CLI, [...initArgs, '--statusline', '--coordinator-agent', 'claude'])
  assert.notEqual(out.status, 0)
  assert.match(out.out, /fail: .*settings\.json/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "permissions": { // hand edit\n')
})

// ---- render ----

test('render: a local playbook override replaces the template, an .append.md is appended', () => {
  const box = sandbox()
  const local = path.join(path.dirname(box.configPath), 'playbooks.local')
  fs.mkdirSync(local, { recursive: true })
  fs.writeFileSync(path.join(local, 'pr-review.md'), 'OVERRIDE BODY for {{person.name}}\n')
  fs.writeFileSync(path.join(local, 'cleanup.append.md'), 'APPENDED LINE\n')
  const out = box.run(CLI, ['render'])
  assert.equal(out.status, 0, out.err)
  const review = fs.readFileSync(path.join(box.state, 'playbooks', 'pr-review.md'), 'utf8')
  assert.match(review, /OVERRIDE BODY for Alex/)
  const templateLine = fs.readFileSync(path.join(ROOT, 'playbooks', 'pr-review.md'), 'utf8').split('\n').find((l) => l.trim() && !l.includes('{{'))
  assert.ok(!review.includes(templateLine), 'the template body is not rendered')
  assert.match(fs.readFileSync(path.join(box.state, 'playbooks', 'cleanup.md'), 'utf8'), /APPENDED LINE\n$/)
})

test('render: an unknown placeholder in a local playbook fails and names the file', () => {
  const box = sandbox()
  const local = path.join(path.dirname(box.configPath), 'playbooks.local')
  fs.mkdirSync(local, { recursive: true })
  fs.writeFileSync(path.join(local, 'mine.md'), 'hello {{nope.key}}\n')
  const out = box.run(CLI, ['render'])
  assert.equal(out.status, 1)
  assert.match(out.err, /mine\.md: unknown placeholder\(s\) nope\.key/)
})

test('render --config uses that config, not the default one (bug 9)', () => {
  const box = sandbox()
  const otherState = path.join(box.dir, 'state2')
  const custom = path.join(box.dir, 'cfg2', 'config.yaml')
  fs.mkdirSync(path.dirname(custom), { recursive: true })
  fs.writeFileSync(custom, toYaml({ person: { name: 'Bea' }, paths: { state: otherState, workspace: box.dir } }))
  const out = box.run(CLI, ['render', '--config', custom])
  assert.equal(out.status, 0, out.err)
  assert.ok(fs.existsSync(path.join(otherState, 'COORDINATOR.md')))
  assert.ok(!fs.existsSync(path.join(box.state, 'COORDINATOR.md')))
})

// ---- repos are git repositories only ----

/** A git repo at dir; with origin: cloned from a bare origin whose default branch is originHead. */
function gitRepo(dir, { originHead } = {}) {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' })
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  if (!originHead) {
    fs.mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q')
    return dir
  }
  const src = `${dir}.src`
  fs.mkdirSync(src, { recursive: true })
  git(src, 'init', '-q', '-b', originHead)
  fs.writeFileSync(path.join(src, 'a'), 'a')
  git(src, 'add', '.')
  git(src, 'commit', '-qm', 'a')
  git(path.dirname(dir), 'clone', '-q', src, dir)
  return dir
}

const repoList = (repos) => ({ match: ['repo', 'list'], stdout: ok({ repos }) })

test('init: only git repositories become repos: the workspace folder and a plain folder Orca calls git are ignored, a nested repo is found with its origin HEAD as base', () => {
  const box = sandbox()
  const ws = path.join(box.dir, 'ws')
  const api = gitRepo(path.join(ws, 'group', 'api'), { originHead: 'develop' })
  const tool = gitRepo(path.join(ws, 'tool'))
  fs.mkdirSync(path.join(ws, 'notes'))
  fs.mkdirSync(path.join(box.dir, 'ws2', 'other'), { recursive: true })
  box.fake('orca', [
    repoList([
      { path: ws, displayName: 'Workspace', kind: 'folder' },
      { path: path.join(ws, 'notes'), displayName: 'notes', kind: 'git' },
      { path: api, displayName: 'api', kind: 'git' },
      { path: tool, displayName: 'tool', kind: 'git' },
      { path: gitRepo(path.join(box.dir, 'ws2', 'other')), displayName: 'other', kind: 'git' }
    ]),
    anyOk({ worktrees: [] })
  ])
  box.fake('gh', [{ match: [], stdout: 'alex' }])
  // The workspace is not in the file: detected from Orca's list, it stays paths.workspace.
  box.writeConfig({ person: { name: 'Alex' }, paths: { state: box.state, orca: path.join(box.dir, 'fake', 'orca') }, github: { org: 'acme' } })
  const out = box.run(CLI, initArgs, { extraEnv: { ORCA_COORDINATOR_CWD: ws } })
  assert.equal(out.status, 0, out.err)
  const config = readConfig(box.configPath)
  assert.equal(config.paths.workspace, ws)
  assert.deepEqual(config.repos.map((r) => [r.name, r.base]), [['api', 'develop'], ['tool', 'main']], 'no folder, no plain folder, nothing outside the workspace (ws2 shares its prefix)')
})

test('init re-run drops a plain folder the config listed in repos, and says so', () => {
  const box = sandbox()
  const ws = path.join(box.dir, 'ws')
  const api = gitRepo(path.join(ws, 'api'))
  box.writeConfig({ person: { name: 'Alex' }, paths: { state: box.state, workspace: ws, orca: path.join(box.dir, 'fake', 'orca') }, github: { org: 'acme' }, repos: [{ name: 'Workspace', path: ws, base: 'main' }, { name: 'api', path: api, base: 'main' }] })
  box.fake('orca', [anyOk({ repos: [], worktrees: [] })])
  box.fake('gh', [{ match: [], stdout: 'alex' }])
  const out = box.run(CLI, initArgs)
  assert.equal(out.status, 0, out.err)
  assert.match(out.err, /"Workspace" .* is not a git repository/)
  assert.deepEqual(readConfig(box.configPath).repos.map((r) => r.name), ['api'])
})

test('config and render: a folder in repos is a warning, not a crash, and is skipped; --skipped-repos lists it; nothing is written', () => {
  const box = sandbox()
  const ws = path.join(box.dir, 'ws')
  const api = gitRepo(path.join(ws, 'api'))
  box.writeConfig({ person: { name: 'Alex' }, paths: { state: box.state, workspace: ws }, repos: [{ name: 'Workspace', path: ws }, { name: 'api', path: api }, { name: 'gone', path: path.join(ws, 'gone') }] })
  const before = fs.readFileSync(box.configPath, 'utf8')
  const json = box.run(CLI, ['config', '--json'])
  assert.equal(json.status, 0, json.err)
  assert.deepEqual(JSON.parse(json.out).repos.map((r) => r.name), ['api'])
  assert.match(json.err, /"Workspace" .* not a git repository/)
  assert.match(json.err, /"gone" .* not a git repository/, 'a missing path too')
  assert.deepEqual(JSON.parse(box.run(CLI, ['config', '--skipped-repos']).out).map((r) => r.name), ['Workspace', 'gone'])
  const rendered = box.run(CLI, ['render'])
  assert.equal(rendered.status, 0, rendered.err)
  assert.match(rendered.err, /"Workspace" .* not a git repository/)
  assert.equal(fs.readFileSync(box.configPath, 'utf8'), before, 'reading never rewrites config.yaml')
})

test('config --merge: a repos entry that is not a git repository is not written', () => {
  const box = sandbox()
  const ws = path.join(box.dir, 'ws')
  const api = gitRepo(path.join(ws, 'api'))
  fs.mkdirSync(path.join(ws, 'plain'))
  const out = box.run(CLI, ['config', '--merge', JSON.stringify({ repos: [{ name: 'plain', path: path.join(ws, 'plain') }, { name: 'api', path: api }] })])
  assert.equal(out.status, 0, out.err)
  assert.match(out.err, /"plain" .* not a git repository/)
  assert.deepEqual(readConfig(box.configPath).repos.map((r) => r.name), ['api'])
})

// ---- config --merge ----

test('config --merge: invalid JSON or an invalid result is rejected and the file is not written', () => {
  const box = sandbox()
  const before = fs.readFileSync(box.configPath, 'utf8')
  const notJson = box.run(CLI, ['config', '--merge', '{queue: 5'])
  assert.notEqual(notJson.status, 0)
  assert.match(notJson.err, /--merge expects JSON/)
  const invalid = box.run(CLI, ['config', '--merge', '{"queue":{"max":0}}'])
  assert.equal(invalid.status, 2)
  assert.match(invalid.err, /queue\.max/)
  assert.equal(fs.readFileSync(box.configPath, 'utf8'), before)
})

test('config --merge: keys the patch does not name, unknown ones included, are kept', () => {
  const box = sandbox({ config: { custom: { note: 'hand-written' } } })
  const out = box.run(CLI, ['config', '--merge', '{"queue":{"max":5}}'])
  assert.equal(out.status, 0, out.err)
  const config = readConfig(box.configPath)
  assert.equal(config.queue.max, 5)
  assert.equal(config.custom.note, 'hand-written')
  assert.equal(config.person.name, 'Alex')
})

// ---- automations ----

const job = (playbook, schedule) => ({ playbook, schedule, precheck: 'none', name: 'Job' })

test('automations install: a changed schedule is pushed to the registered automation (bug 10)', () => {
  const box = sandbox({ config: { automations: { jobs: [job('cleanup', '0 19 * * *')] } } })
  box.fake('orca', [
    { match: ['automations', 'list'], stdout: ok({ automations: [{ id: 'a1', name: 'Job · cleanup', trigger: '0 18 * * *', prompt: '[trigger] cleanup' }] }) },
    anyOk()
  ])
  const out = box.run(CLI, ['automations', 'install'])
  assert.equal(out.status, 0, out.err)
  const edit = box.calls('orca').find((a) => a[0] === 'automations' && a[1] === 'edit')
  assert.ok(edit, 'automations edit was called')
  assert.equal(edit[2], 'a1')
  assert.equal(edit[edit.indexOf('--trigger') + 1], '0 19 * * *')
  assert.ok(!box.calls('orca').some((a) => a[1] === 'create'))
})

test('automations install: a job removed from config is removed from Orca; automations it did not create are left (bug 10)', () => {
  const box = sandbox({ config: { automations: { jobs: [job('cleanup', '0 18 * * *')] } } })
  box.fake('orca', [
    {
      match: ['automations', 'list'],
      stdout: ok({
        automations: [
          { id: 'a1', name: 'Job · cleanup', trigger: '0 18 * * *', prompt: '[trigger] cleanup' },
          { id: 'old', name: 'Gone · eval-weekly', trigger: '0 9 * * 1', prompt: '[trigger] eval-weekly' },
          { id: 'u1', name: 'Standup · notes', trigger: '0 9 * * *', prompt: 'write my standup' }
        ]
      })
    },
    anyOk()
  ])
  assert.equal(box.run(CLI, ['automations', 'install']).status, 0)
  const removed = box.calls('orca').filter((a) => a[1] === 'remove').map((a) => a[2])
  assert.deepEqual(removed, ['old'])
})

// ---- plugin ----

test('plugin load: a failed install leaves no "installed by this package" marker (bug 14)', () => {
  const box = sandbox()
  box.fake('orca', [
    { match: ['plugin', 'list'], stdout: ok({ plugins: [] }) },
    { match: ['plugin', 'inspect'], stdout: ok({ contentHash: 'h1' }) },
    { match: ['plugin', 'install'], stdout: JSON.stringify({ ok: false, error: { message: 'manifest invalid' } }), status: 1 }
  ])
  fs.mkdirSync(box.state, { recursive: true })
  const out = box.run(CLI, ['plugin', 'load'])
  assert.notEqual(out.status, 0)
  assert.match(out.out, /fail: plugin install: manifest invalid/)
  assert.ok(!fs.existsSync(path.join(box.state, 'plugin-folder')))
})
