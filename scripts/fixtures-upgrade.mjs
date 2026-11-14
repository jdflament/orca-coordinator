#!/usr/bin/env node
// npm run fixtures:upgrade <tag>
// Builds the state snapshot a RELEASED version leaves on disk, for the upgrade tests
// (test/upgrade.test.mjs): checks the tag out in a temp dir, runs that version's own `init` and
// `board` commands with a temp HOME, and copies config.yaml, board.json, panel.json, state.md,
// coordinator-terminal and the inbox files to test/fixtures/upgrade/<tag>/ (config/ and state/).
// Paths are scrubbed to __ROOT__ (the temp dir) and __HOME__ (your home), so no personal data
// lands in the repo. Run it once per release, on the tag, and commit the result.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tag = process.argv[2]
if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error('usage: npm run fixtures:upgrade <tag>   (for example v1.0.1)')
  process.exit(2)
}
const target = path.join(repo, 'test', 'fixtures', 'upgrade', tag)
if (fs.existsSync(target) && !process.argv.includes('--force')) {
  console.error(`${target} exists: fixtures are snapshots of a release; pass --force to rebuild it`)
  process.exit(1)
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-fixture-')))
const home = path.join(root, 'home')
const pkg = path.join(root, 'pkg')
const ws = path.join(root, 'ws')
const git = (args, cwd = repo) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local', 'state') }
delete env.ORCA_COORDINATOR_CONFIG
delete env.COORDINATOR_BOARD
const node = (args, cwd = pkg) => {
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout
}

try {
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(ws, { recursive: true })
  git(['init', '-q', 'api'], ws)
  git(['worktree', 'add', '--detach', pkg, tag])
  node(['bin/coordinator.mjs', 'init', '--yes', '--no-plugin', '--no-skill-link', '--workspace', ws, '--name', 'Alex', '--github', 'alex'])
  const board = (...args) => node(['bin/board.mjs', ...args])
  board('focus', 'Ship the checkout rework')
  board('ws:add', 'PROJ-1', '--title', 'Checkout rework', '--status', 'active', '--progress', '40')
  board('task:add', 'PROJ-2', '--ws', 'PROJ-1', '--repo', 'api', '--status', 'pr', '--pr', '12', '--detail', 'review requested')
  board('repo:add', 'api', '--id', 'PROJ-3', '--kind', 'pr', '--status', 'review')
  board('agent:set', 'worker-1', 'working', '--repo', 'api', '--detail', 'writing tests')
  board('instruction:add', 'Never push without asking')
  board('ask', 'Merge PR 12?', '--repo', 'api', '--options', 'merge:Merge*|hold:Hold')
  board('log', 'fixture built')
  const state = path.join(home, '.local', 'state', 'orca-coordinator')
  fs.writeFileSync(path.join(state, 'coordinator-terminal'), 'term_fixture\n')
  fs.writeFileSync(path.join(state, 'inbox.jsonl'), JSON.stringify({ at: '2026-01-01T00:00:00.000Z', text: 'nudge PROJ-2' }) + '\n')
  fs.writeFileSync(path.join(state, 'inbox.rejected.jsonl'), '')

  const scrub = (text) => text.split(root).join('__ROOT__').split(os.homedir()).join('__HOME__')
  fs.rmSync(target, { recursive: true, force: true })
  const copy = (from, to) => {
    if (!fs.existsSync(from)) return
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, scrub(fs.readFileSync(from, 'utf8')))
  }
  copy(path.join(home, '.config', 'orca-coordinator', 'config.yaml'), path.join(target, 'config', 'config.yaml'))
  for (const file of ['board.json', 'panel.json', 'state.md', 'coordinator-terminal', 'inbox.jsonl', 'inbox.rejected.jsonl']) copy(path.join(state, file), path.join(target, 'state', file))
  console.log(`wrote ${path.relative(repo, target)}`)
} finally {
  spawnSync('git', ['worktree', 'remove', '--force', pkg], { cwd: repo })
  spawnSync('git', ['worktree', 'prune'], { cwd: repo })
  fs.rmSync(root, { recursive: true, force: true })
}
