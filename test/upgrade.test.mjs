// Upgrade safety (rules/90-upgrades.md): what each RELEASED version left on disk must keep working
// with the current code. test/fixtures/upgrade/<tag>/ holds real snapshots (npm run fixtures:upgrade
// <tag>); every folder there is tested, so a new release's fixture is covered without editing this file.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { BOARD_VERSION, CONFIG_VERSION, backupOnce, migrateBoardFile, migrateConfigFile, runSteps } from '../bin/lib/migrate.mjs'
import { availableOptionalRules, enabledOptionalRules } from '../bin/lib/config.mjs'
import { OPTIONAL_RULES_AT_V2 } from '../bin/lib/migrate.mjs'
import { ROOT, sandbox } from './helpers.mjs'

const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'upgrade')
const TAGS = fs.readdirSync(FIXTURES).filter((name) => /^v\d/.test(name)).sort()
const COORDINATOR = 'bin/coordinator.mjs'
const BOARD = 'bin/board.mjs'

/** A temp home holding the fixture exactly as that release wrote it (placeholders filled in). */
function install(tag) {
  const box = sandbox({ writeConfig: false })
  const stateDir = path.join(box.home, '.local', 'state', 'orca-coordinator')
  const fill = (text) => text.split('__ROOT__/pkg').join(ROOT).split('__ROOT__').join(box.dir).split('__HOME__').join(box.home)
  const copy = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, fill(fs.readFileSync(from, 'utf8')))
  }
  const dir = path.join(FIXTURES, tag)
  copy(path.join(dir, 'config', 'config.yaml'), box.configPath)
  for (const file of fs.readdirSync(path.join(dir, 'state'))) copy(path.join(dir, 'state', file), path.join(stateDir, file))
  fs.mkdirSync(path.join(box.dir, 'ws'), { recursive: true })
  const read = (file) => fs.readFileSync(file, 'utf8')
  return { box, stateDir, boardFile: path.join(stateDir, 'board.json'), read }
}

test('fixtures exist for the released versions', () => {
  assert.ok(TAGS.includes('v1.0.0') && TAGS.includes('v1.0.1'), `found ${TAGS}`)
})

for (const tag of TAGS) {
  test(`upgrade from ${tag}: board verbs read the old board, keep every item, and never rewrite a current-version board`, () => {
    const { box, boardFile, read } = install(tag)
    const original = read(boardFile)
    const shown = box.run(BOARD, ['show', '--json'])
    assert.equal(shown.status, 0, shown.err)
    const before = JSON.parse(original)
    const after = JSON.parse(shown.out)
    for (const key of ['focus', 'instructions', 'decisions', 'workstreams', 'tasks', 'repos', 'agents']) assert.deepEqual(after[key], before[key], key)
    assert.equal(read(boardFile), original, 'reading does not write')
    assert.equal(box.run(BOARD, ['validate']).status, 0)
    // A write keeps what was there and adds to it.
    assert.equal(box.run(BOARD, ['task:add', 'PROJ-9', '--repo', 'api', '--status', 'local']).status, 0)
    const written = JSON.parse(read(boardFile))
    assert.deepEqual(written.tasks.map((t) => t.id), [...before.tasks.map((t) => t.id), 'PROJ-9'])
    assert.equal(written.version, BOARD_VERSION)
    assert.deepEqual(written.instructions, before.instructions)
    assert.equal(fs.existsSync(`${boardFile}.bak-v${BOARD_VERSION}`), false)
  })

  test(`upgrade from ${tag}: config reads, keeps its values and unknown keys, and migrates once with one backup`, () => {
    const { box, read } = install(tag)
    fs.appendFileSync(box.configPath, 'myTeamNotes:\n  keep: true\n')
    const original = read(box.configPath)
    const json = box.run(COORDINATOR, ['config', '--json'])
    assert.equal(json.status, 0, json.err)
    const config = JSON.parse(json.out)
    assert.equal(config.person.name, 'Alex')
    assert.equal(config.schemaVersion, CONFIG_VERSION)
    assert.equal(config.myTeamNotes?.keep, true, 'unknown keys survive the read')
    // rules.optional was implicit (missing = all on); the migration writes it out, so the install keeps every optional rule it had.
    assert.deepEqual(config.rules.optional, OPTIONAL_RULES_AT_V2)
    assert.ok(OPTIONAL_RULES_AT_V2.every((name) => availableOptionalRules().includes(name)))
    assert.deepEqual([...enabledOptionalRules(config)].sort(), availableOptionalRules(), 'same rules on as before the migration')
    const migrated = read(box.configPath)
    assert.match(migrated, new RegExp(`^schemaVersion: ${CONFIG_VERSION}$`, 'm'))
    assert.ok(migrated.includes('myTeamNotes:\n  keep: true'), 'unknown keys survive the rewrite')
    assert.ok(migrated.startsWith('# orca-coordinator config'), 'the leading comment stays first')
    const backup = `${box.configPath}.bak-v0`
    assert.equal(read(backup), original, 'the backup is the original, byte for byte')
    // Idempotent: again (CLI, migrate command, a write) changes nothing and never replaces the backup.
    assert.equal(box.run(COORDINATOR, ['config', '--json']).status, 0)
    const again = box.run(COORDINATOR, ['migrate', '--json'])
    assert.equal(again.status, 0, again.err)
    assert.deepEqual(JSON.parse(again.out).config.migrated, false)
    assert.equal(read(box.configPath), migrated)
    assert.equal(read(backup), original)
    const saved = box.run(COORDINATOR, ['config', '--merge', JSON.stringify({ queue: { max: 4 } })])
    assert.equal(saved.status, 0, saved.err)
    const merged = read(box.configPath)
    assert.ok(merged.includes('myTeamNotes:') && merged.includes('max: 4') && new RegExp(`^schemaVersion: ${CONFIG_VERSION}$`, 'm').test(merged), 'a save keeps unknown keys and the version')
    assert.deepEqual(fs.readdirSync(path.dirname(box.configPath)).filter((f) => f.includes('.bak')), ['config.yaml.bak-v0'], 'one backup only')
  })

  test(`upgrade from ${tag}: migrate command and render work on the old state, and never rewrite the config`, () => {
    const { box, stateDir, read } = install(tag)
    const first = box.run(COORDINATOR, ['migrate'])
    assert.equal(first.status, 0, first.err)
    assert.match(first.out, /config: migrated v0 → v2/)
    assert.match(first.out, /board: up to date/)
    const second = box.run(COORDINATOR, ['migrate'])
    assert.match(second.out, /config: up to date/)
    const before = read(box.configPath)
    const rendered = box.run(COORDINATOR, ['render'])
    assert.equal(rendered.status, 0, rendered.err)
    assert.equal(read(box.configPath), before, 'render never rewrites the config')
    assert.ok(fs.existsSync(path.join(stateDir, 'COORDINATOR.md')))
    assert.equal(fs.existsSync(path.join(stateDir, 'board.json')), true)
    assert.equal(read(path.join(stateDir, 'coordinator-terminal')), 'term_fixture\n', 'the coordinator handle is kept')
  })
}

test('migration v2: an existing rules.optional is kept, a rules block without it gains it, and nothing else changes', () => {
  const box = sandbox({ writeConfig: false })
  const file = path.join(box.dir, 'config.yaml')
  fs.writeFileSync(file, '# mine\nschemaVersion: 1\nperson:\n  name: A\nrules:\n  optional: [drafts]\n')
  assert.equal(migrateConfigFile(file).migrated, true)
  assert.equal(fs.readFileSync(file, 'utf8'), '# mine\nschemaVersion: 2\nperson:\n  name: A\nrules:\n  optional: [drafts]\n', 'a user choice is never replaced')
  assert.equal(fs.readFileSync(`${file}.bak-v1`, 'utf8').includes('schemaVersion: 1'), true)
  const other = path.join(box.dir, 'other.yaml')
  fs.writeFileSync(other, 'schemaVersion: 1\nperson:\n  name: A\nrules:\n  future: true\n')
  assert.equal(migrateConfigFile(other).migrated, true)
  const text = fs.readFileSync(other, 'utf8')
  assert.ok(text.includes('future: true') && text.includes('optional:') && /schemaVersion: 2/.test(text))
  const empty = path.join(box.dir, 'empty.yaml')
  fs.writeFileSync(empty, 'schemaVersion: 1\nrules:\n  optional: []\n')
  assert.equal(migrateConfigFile(empty).migrated, true)
  assert.match(fs.readFileSync(empty, 'utf8'), /optional: \[\]/, '[] (none) stays none')
})

test('migration mechanism: steps run in order from the stored version, once, with a backup before the first rewrite', () => {
  const box = sandbox({ writeConfig: false })
  const file = path.join(box.dir, 'board.json')
  const steps = [
    { to: 3, apply: (b) => ({ ...b, three: true }) },
    { to: 2, apply: (b) => ({ ...b, two: true, renamed: b.old, old: undefined }) }
  ]
  const original = JSON.stringify({ version: 1, old: 'x', unknownKey: { keep: 1 } })
  fs.writeFileSync(file, original)
  const result = migrateBoardFile(file, steps, 3)
  assert.deepEqual([result.migrated, result.from, result.to], [true, 1, 3])
  const migrated = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(migrated, { version: 3, renamed: 'x', two: true, three: true, unknownKey: { keep: 1 } })
  assert.equal(fs.readFileSync(`${file}.bak-v1`, 'utf8'), original)
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(migrateBoardFile(file, steps, 3).migrated, false, 'idempotent')
  assert.equal(fs.readFileSync(file, 'utf8'), text)
  assert.equal(fs.readFileSync(`${file}.bak-v1`, 'utf8'), original, 'the backup is never replaced')
  assert.deepEqual(runSteps({ v: 0 }, steps, 2, 3).data, { v: 0, three: true }, 'only steps above the stored version')
})

test('migration mechanism: newer data is left alone, a broken file or a refused step reports instead of throwing', () => {
  const box = sandbox({ writeConfig: false })
  const board = path.join(box.dir, 'board.json')
  fs.writeFileSync(board, JSON.stringify({ version: 9, future: true }))
  assert.equal(migrateBoardFile(board).migrated, false)
  assert.equal(JSON.parse(fs.readFileSync(board, 'utf8')).version, 9)
  fs.writeFileSync(board, '{not json')
  assert.equal(typeof migrateBoardFile(board).error, 'string')
  const config = path.join(box.dir, 'config.yaml')
  fs.writeFileSync(config, 'schemaVersion: 7\nperson:\n  name: A\n')
  assert.equal(migrateConfigFile(config).migrated, false, 'a newer config is not touched')
  fs.writeFileSync(config, 'person:\n  name: A\n')
  assert.equal(migrateConfigFile(config, [{ to: 1, apply: () => 'schemaVersion: 1\n' }]).migrated, false, 'a step that drops keys is refused')
  assert.equal(fs.readFileSync(config, 'utf8'), 'person:\n  name: A\n')
  assert.equal(fs.existsSync(`${config}.bak-v0`), false, 'no backup for a refused migration')
  backupOnce(config, 0)
  fs.writeFileSync(config, 'changed')
  backupOnce(config, 0)
  assert.equal(fs.readFileSync(`${config}.bak-v0`, 'utf8'), 'person:\n  name: A\n')
})

test('board verbs: a board whose lists are null or the wrong type reads as empty lists and keeps its unknown keys', () => {
  const box = sandbox({ writeConfig: false })
  const file = path.join(box.dir, 'board.json')
  fs.writeFileSync(file, JSON.stringify({ version: 2, updatedAt: '2026-01-01T00:00:00.000Z', decisions: null, tasks: {}, extra: { keep: true } }))
  const env = { COORDINATOR_BOARD: file }
  assert.equal(box.run(BOARD, ['task:add', 'A-1', '--status', 'local'], { extraEnv: env }).status, 0)
  const board = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(board.tasks.map((t) => t.id), ['A-1'])
  assert.deepEqual(board.extra, { keep: true })
})

test('panel: every request goes through the helper that drops undefined values (the host rejects them as "Invalid input")', () => {
  const html = fs.readFileSync(path.join(ROOT, 'plugin', 'panel', 'index.html'), 'utf8')
  const code = /\/\/ request-helper:start\n([\s\S]*?)\/\/ request-helper:end/.exec(html)?.[1]
  assert.ok(code, 'the helper is marked in the panel')
  const sent = []
  const context = { orca: { plugin: { request: (...args) => sent.push(args) } } }
  vm.runInNewContext(`${code}\nthis.request = request`, context)
  context.request('board.get', { seen: undefined })
  context.request('config.save', { patch: { a: undefined, b: { c: undefined, d: 1 }, e: [1, undefined] } })
  context.request('setup.status')
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['board.get', {}], ['config.save', { patch: { b: { d: 1 }, e: [1, null] } }], ['setup.status']])
  const direct = [...html.matchAll(/orca\.plugin\.request\(/g)]
  assert.equal(direct.length, 2, 'only the helper itself calls orca.plugin.request')
})
