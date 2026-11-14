import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { parseYaml, toYaml } from '../bin/lib/yaml.mjs'
import { defaults, loadConfig, MODEL_ROLES, modelFor, render, templateValues, validate } from '../bin/lib/config.mjs'
import { ROOT, sandbox } from './helpers.mjs'

test('yaml: block and flow maps, lists, quotes and comments parse as written and round-trip through toYaml', () => {
  const text = `person: {name: Alex, github: alex-dev, tone: "plain, 2-4 sentences"}
repos:
  - {name: api, path: ~/code/api, base: main}
  - name: web
    path: ~/code/web
github:
  org: acme   # comment
  reviewTeams: [acme/platform, 'acme/web']
  skipRepos: []
automations:
  jobs:
    - playbook: pr-review
      schedule: "15 9,12 * * 1-5"
empty:
flag: true
n: 3
`
  const value = parseYaml(text)
  assert.deepEqual(value.person, { name: 'Alex', github: 'alex-dev', tone: 'plain, 2-4 sentences' })
  assert.deepEqual(value.repos, [{ name: 'api', path: '~/code/api', base: 'main' }, { name: 'web', path: '~/code/web' }])
  assert.deepEqual(value.github, { org: 'acme', reviewTeams: ['acme/platform', 'acme/web'], skipRepos: [] })
  assert.deepEqual(value.automations.jobs, [{ playbook: 'pr-review', schedule: '15 9,12 * * 1-5' }])
  assert.equal(value.empty, null)
  assert.equal(value.flag, true)
  assert.equal(value.n, 3)
  assert.deepEqual(parseYaml(toYaml(value)), value)
})

test('yaml: a string ending in ":" round-trips as a string, not a one-key map', () => {
  const value = { jobs: [{ playbook: 'x' }, 'foo:'], note: 'bar:' }
  assert.deepEqual(parseYaml(toYaml(value)), value)
})

test('config.example.yaml: it validates and renders every rule, playbook and route script as shipped', () => {
  const box = sandbox({ writeConfig: false })
  const example = path.join(ROOT, 'config.example.yaml')
  const shown = box.run('bin/coordinator.mjs', ['config', '--json', '--config', example])
  assert.equal(shown.status, 0, shown.err)
  const config = JSON.parse(shown.out)
  assert.equal(config.paths.state, path.join(box.home, '.local', 'state', 'orca-coordinator'), '~ expands to the home folder')
  const rendered = box.run('bin/coordinator.mjs', ['render', '--config', example])
  assert.equal(rendered.status, 0, rendered.err)
  for (const job of config.automations.jobs) {
    assert.ok(fs.existsSync(path.join(config.paths.state, 'playbooks', `${job.playbook}.md`)), job.playbook)
    assert.ok(fs.existsSync(path.join(config.paths.state, 'automations', `route-${job.playbook}.sh`)), job.playbook)
  }
  assert.doesNotMatch(fs.readFileSync(path.join(config.paths.state, 'COORDINATOR.md'), 'utf8'), /\{\{/)
})

test('config-shell.mjs: a value with quotes, $(…) and backticks reaches the shell scripts verbatim and never runs', () => {
  const name = `O'Brien "$(touch pwned)" \`touch pwned\` $HOME`
  const box = sandbox({ config: { person: { name } } })
  const script = `eval "$(${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'bin/lib/config-shell.mjs'))})" && printf '%s' "$CFG_person_name"`
  const out = spawnSync('bash', ['-c', script], { cwd: box.dir, env: box.env, encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout, name)
  assert.ok(!fs.existsSync(path.join(box.dir, 'pwned')), 'nothing in the value was executed')
})

test('config: a project .orca-coordinator.yaml overrides keys over the XDG config, keeps the other defaults, and ~ expands', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-home-'))
  const configDir = path.join(home, 'cfg', 'orca-coordinator')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config.yaml'), `person: {name: Alex}\npaths: {workspace: "~/code"}\ngit: {branchPattern: "x/{ticket-lower}"}\n`)
  const project = path.join(home, 'code', 'api')
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(home, 'code', '.orca-coordinator.yaml'), 'git: {branchPattern: "feature/{ticket-lower}"}\nqueue: {max: 5}\n')
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HOME: process.env.HOME }
  process.env.XDG_CONFIG_HOME = path.join(home, 'cfg')
  process.env.HOME = home
  try {
    const { config, sources } = loadConfig({ cwd: project })
    assert.equal(sources.length, 2)
    assert.equal(config.person.name, 'Alex')
    assert.equal(config.paths.workspace, path.join(home, 'code'))
    assert.equal(config.git.branchPattern, 'feature/{ticket-lower}')
    assert.equal(config.queue.max, 5)
    assert.equal(config.queue.staleHours, 24, 'defaults survive a partial override')
  } finally {
    for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

test('rules, playbooks and templates: no file uses a placeholder the config does not define', () => {
  const config = defaults()
  config.paths.workspace = '/tmp/ws'
  const values = { ...templateValues(config), today: '2026-01-05' }
  for (const dir of ['rules', 'playbooks', 'templates']) {
    const root = new URL(`../${dir}/`, import.meta.url).pathname
    for (const file of fs.readdirSync(root)) {
      if (!file.endsWith('.md') || file === 'README.md') continue
      render(fs.readFileSync(path.join(root, file), 'utf8'), values, { file })
    }
  }
})

test('release: package.json and orca-plugin.json carry the same version, and the plugin\'s main and panel files exist', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const plugin = JSON.parse(fs.readFileSync(path.join(root, 'orca-plugin.json'), 'utf8'))
  assert.equal(plugin.version, pkg.version)
  assert.ok(fs.existsSync(path.join(root, plugin.main)), plugin.main)
  for (const panel of plugin.contributes.panels) assert.ok(fs.existsSync(path.join(root, panel.entry)), panel.entry)
})

test('models: levels default to Balanced with no ids; a level id becomes the role\'s model, a model set by hand wins, empty means no --model', () => {
  const config = defaults()
  assert.deepEqual(config.models.roles, { coordinator: 'max', worker: 'standard', reader: 'light' })
  assert.deepEqual(config.models.levels, { light: '', standard: '', max: '' })
  for (const role of MODEL_ROLES) assert.equal(modelFor(config, role), '', 'no id: pass no --model')
  config.models.levels = { light: 'l-1', standard: 's-1', max: 'm-1' }
  assert.deepEqual(MODEL_ROLES.map((role) => modelFor(config, role)), ['m-1', 's-1', 'l-1'])
  config.agents.worker.model = 'by-hand'
  assert.equal(modelFor(config, 'worker'), 'by-hand', 'legacy agents.*.model wins')
  config.models.roles.reader = 'bogus'
  assert.ok(validate(config).some((problem) => problem.includes('models.roles.reader')))
})

test('rules: workers and readers get their own level\'s model, the coordinator\'s model is not the worker\'s, and an empty id omits --model', () => {
  const config = defaults()
  config.models.levels = { light: 'l-1', standard: 's-1', max: 'm-1' }
  const text = fs.readFileSync(new URL('../rules/20-workers.md', import.meta.url), 'utf8')
  const out = render(text, templateValues(config))
  assert.match(out, /workers[^\n]*`s-1` \(level standard\); readers[^\n]*`l-1` \(level light\)/)
  assert.match(out, /Your own model is `m-1`[^\n]*`--resume` keeps it; never switch yourself to the worker model/)
  assert.match(out, /empty id means omit `--model`/)
  const session = render(fs.readFileSync(new URL('../rules/10-session.md', import.meta.url), 'utf8'), templateValues(defaults()))
  assert.match(session, /level in `models.levels`[^\n]*is empty, fill it[^\n]*Never overwrite a non-empty level/)
})

// ---- generic defaults ----

test('defaults and the example config carry no personal names, voice or team labels', () => {
  const d = defaults()
  assert.equal(d.person.language, '')
  assert.equal(d.person.tone, '')
  assert.equal(d.board.oncallLabel, '')
  assert.equal(d.rules, undefined, 'a missing key means all optional rules, for existing installs')
  const text = JSON.stringify(d) + fs.readFileSync(path.join(ROOT, 'config.example.yaml'), 'utf8')
  assert.doesNotMatch(text, /Alex|alex-dev|\bacme\b|\bPAY\b|payments-incidents|benkyoji|plain, 2-4 sentences|Teammates|oncall(Label)?: oncall/)
  const example = parseYaml(fs.readFileSync(path.join(ROOT, 'config.example.yaml'), 'utf8'))
  assert.deepEqual(example.rules, { optional: [] })
  assert.equal(example.board.oncallLabel, '')
})

test('fixtures and panel copy are neutral: DEMO ids, example-org, no "draft" or "tickets" wording', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'plugin', 'src', 'fixtures', 'busy.json'), 'utf8')
  assert.doesNotMatch(fixture, /PROJ-|acme|checkout|support confirms/i)
  assert.match(fixture, /DEMO-1\d\d/)
  const panel = fs.readFileSync(path.join(ROOT, 'plugin', 'panel', 'index.html'), 'utf8')
  // The three settings helper lines are rewritten in the settings-models PR (#7).
  const copy = panel.split('\n').filter((l) => !/field\('(Name|Language|Tone)'/.test(l)).join('\n')
  assert.doesNotMatch(copy, /draft/i)
  assert.doesNotMatch(copy, /adds tickets/)
})
