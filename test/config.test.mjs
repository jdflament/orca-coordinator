import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { parseYaml, toYaml } from '../bin/lib/yaml.mjs'
import { defaults, loadConfig, render, templateValues, toShellExports, validate } from '../bin/lib/config.mjs'
import { ROOT, sandbox } from './helpers.mjs'

test('yaml: block maps, lists of flow maps, inline lists, quotes, comments, round trip', () => {
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

test('config example: it validates and renders every rule, playbook and route script as shipped', () => {
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

test('config: defaults validate only with a workspace, placeholders render, shell exports quote', () => {
  const config = defaults()
  assert.ok(validate(config).some((p) => p.includes('paths.workspace')))
  config.paths.workspace = '/tmp/ws'
  assert.deepEqual(validate(config), [])
  const values = templateValues(config)
  assert.equal(render('hi {{person.name}}, max {{queue.max}}', values), 'hi you, max 3')
  assert.ok(values['adapters.ticketing.cmd'].endsWith('/adapters/ticketing/none.sh'))
  assert.throws(() => render('{{nope.key}}', values), /unknown placeholder/)
  const shell = toShellExports(config)
  assert.match(shell, /^CFG_queue_max='3'$/m)
  assert.match(shell, /^CFG_paths_workspace='\/tmp\/ws'$/m)
})

test('config: XDG path, project override and ~ expansion', () => {
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

test('rules and playbooks: every template renders with the default keys', () => {
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

test('release: package.json and orca-plugin.json carry the same version, plugin paths exist', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const plugin = JSON.parse(fs.readFileSync(path.join(root, 'orca-plugin.json'), 'utf8'))
  assert.equal(plugin.version, pkg.version)
  assert.ok(fs.existsSync(path.join(root, plugin.main)), plugin.main)
  for (const panel of plugin.contributes.panels) assert.ok(fs.existsSync(path.join(root, panel.entry)), panel.entry)
})
