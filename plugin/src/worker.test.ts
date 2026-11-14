// Runs src/worker.ts's activate(orca) over a mock host, with a fake Orca CLI on
// ORCA_CLI_BIN_DIR and a temp coordinator state folder.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'
import { listProjects, type Host } from './host'
import { updateIfInstalledHere } from './setup'
import type { ConfigPatch } from './protocol'

const busy = new URL('./fixtures/busy.json', import.meta.url).pathname

// No test reads or writes the real ~/.config or ~/.local: every test runs under a temp home (withHome nests its own).
{
  const isolated = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-isolated-home-')))
  delete process.env.ORCA_COORDINATOR_CONFIG
  Object.assign(process.env, { HOME: isolated, XDG_CONFIG_HOME: join(isolated, '.config'), XDG_STATE_HOME: join(isolated, '.local/state'), XDG_DATA_HOME: join(isolated, '.local/share') })
}

interface FakeRepo {
  id?: string
  path: string
  displayName: string
  kind: 'folder' | 'git'
}

/** live: an agent runs in the coordinator terminal; 'shell': connected, but only a bare shell; false: disconnected. */
type Live = boolean | 'shell'

const DEFAULT_WORKERS = [
  { dispatchId: 'ctx_1', state: 'running', outcome: 'in_progress', terminal: 'term_w1', taskId: 'task_1' },
  { dispatchId: 'ctx_2', state: 'blocked', outcome: 'needs_input', terminal: 'term_w2', taskId: 'task_2' },
  { dispatchId: 'ctx_3', state: 'succeeded', outcome: 'succeeded', terminal: null, taskId: 'task_3' }
]

function fakeOrca(bin: string, options: { live: Live; repos?: FakeRepo[]; workers?: Record<string, unknown>[] }): string {
  const terminal = { handle: 'term_coord', connected: options.live !== false, orphaned: false, ...(options.live === true ? { agentIdentity: 'claude' } : {}) }
  const script = join(bin, 'orca')
  const log = join(bin, 'calls.log')
  writeFileSync(
    script,
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "terminal list") echo '{"ok":true,"result":{"terminals":[{"handle":"term_coord","title":"◆ COORDINATOR"},{"handle":"term_w1","title":"pr-review: api#42"}]}}' ;;
  "terminal show") echo '${JSON.stringify({ ok: true, result: { terminal } })}' ;;
  "orchestration worker-list") echo '${JSON.stringify({ ok: true, result: { workers: options.workers ?? DEFAULT_WORKERS } })}' ;;
  "repo list") echo '${JSON.stringify({ ok: true, result: { repos: options.repos ?? [] } })}' ;;
  "agent launch") echo '{"ok":true,"result":{}}' ;;
  "orchestration task-list") echo '{"ok":true,"result":{"tasks":[{"id":"task_2","title":"ticket-triage: morning"}]}}' ;;
  *) echo '{"ok":true,"result":{}}' ;;
esac
`
  )
  chmodSync(script, 0o755)
  return log
}

function stateFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coordinator-state-'))
  copyFileSync(busy, join(dir, 'board.json'))
  writeFileSync(join(dir, 'coordinator-terminal'), 'term_coord\n')
  writeFileSync(join(dir, 'panel.json'), JSON.stringify({ repoColors: { api: '#123456' }, oncallLabel: 'oncall' }))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'cleanup'), '#!/bin/sh\necho "released ctx_9"\necho "released 1 sessions, removed 0 worktrees, kept 2 (dirty/open)"\n')
  chmodSync(join(dir, 'bin', 'cleanup'), 0o755)
  return dir
}

async function withFakeOrca<T>(live: Live, run: (log: string) => Promise<T>, repos?: FakeRepo[], workers?: Record<string, unknown>[]): Promise<T> {
  const bin = mkdtempSync(join(tmpdir(), 'fake-orca-'))
  const log = fakeOrca(bin, { live, repos, workers })
  const previous = process.env.ORCA_CLI_BIN_DIR
  process.env.ORCA_CLI_BIN_DIR = bin
  try {
    return await run(log)
  } finally {
    if (previous === undefined) delete process.env.ORCA_CLI_BIN_DIR
    else process.env.ORCA_CLI_BIN_DIR = previous
  }
}

test('board.get merges the board with live workers, liveness and panel.json', async () => {
  await withFakeOrca(true, async () => {
    const dir = stateFolder()
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    const view = await worker.request('board.get')
    assert.equal(view.focus, 'DEMO-100 demo feature: merge api #42, then web #310')
    assert.equal(view.decisions?.length, 3)
    assert.equal(view.coordinatorLive, true)
    assert.deepEqual(view.repoColors, { api: '#123456' })
    assert.deepEqual(
      view.workers.map((w) => [w.dispatchId, w.title, w.status]),
      [
        ['ctx_1', 'pr-review: api#42', 'working'],
        ['ctx_2', 'ticket-triage: morning', 'needs input']
      ],
      'finished workers drop, titles come from tasks then terminals'
    )
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  })
})

test('board.get runs `bin/board reconcile` at most once a minute, without waiting for it, and a failing run changes nothing in the view', async () => {
  await withFakeOrca(true, async () => {
    const dir = stateFolder()
    const runs = join(dir, 'reconcile-runs')
    writeFileSync(join(dir, 'bin', 'board'), `#!/bin/sh\necho "$@" >> "${runs}"\necho "gh down" >&2\nexit 1\n`)
    chmodSync(join(dir, 'bin', 'board'), 0o755)
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    const first = await worker.request('board.get')
    await worker.request('board.get')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(readFileSync(runs, 'utf8'), 'reconcile\n', 'two refreshes inside a minute: one run')
    assert.equal(first.decisions?.length, 3, 'a failing reconcile never breaks the render')
    await worker.deactivate()
  })
})

test('board.get marks only Needs you ids the panel has not seen as new (none on the first load)', async () => {
  await withFakeOrca(true, async () => {
    const dir = stateFolder()
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    const first = await worker.request('board.get')
    assert.deepEqual([...(first.decisions ?? []), ...first.workers].filter((item) => item.isNew), [], 'what is there when the panel opens is not new')
    const next = await worker.request('board.get', { seen: ['d:1', 'w:ctx_2'] })
    assert.deepEqual(
      (next.decisions ?? []).filter((d) => d.isNew).map((d) => d.id),
      [2],
      'decision 2 is pending and unseen; the answered decision 3 is not in Needs you'
    )
    assert.deepEqual(next.workers.filter((w) => w.isNew), [], 'a seen worker is not new, a working one is not in Needs you')
    const seenAll = await worker.request('board.get', { seen: ['d:1', 'd:2', 'w:ctx_2'] })
    assert.deepEqual([...(seenAll.decisions ?? []), ...seenAll.workers].filter((item) => item.isNew), [])
    await worker.deactivate()
  })
})

test('board.get: a known link host gets an icon label; an unknown host, a missing url or a non-http url gets none', async () => {
  await withFakeOrca(true, async () => {
    const dir = stateFolder()
    writeFileSync(
      join(dir, 'board.json'),
      JSON.stringify({
        version: 2,
        tasks: [
          { id: 'BEN-1', repo: 'api', status: 'local', url: 'https://linear.app/acme/issue/BEN-1' },
          { id: 'PAY-2', repo: 'api', status: 'local', url: 'https://acme.atlassian.net/browse/PAY-2' },
          { id: 'X-3', repo: 'api', status: 'local', url: 'https://tracker.example.org/X-3' },
          { id: 'Y-4', repo: 'api', status: 'local' }
        ],
        decisions: [{ id: 1, title: 'Merge', action: 'Merge', options: [], status: 'pending', url: 'https://github.com/acme/api/pull/4' }],
        workstreams: [{ id: 'ws', title: 'Notes', status: 'active', url: 'javascript:alert(1)' }]
      })
    )
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    const view = await worker.request('board.get')
    assert.deepEqual(
      view.tasks?.map((t) => [t.id, t.url, t.linkHost?.name]),
      [
        ['BEN-1', 'https://linear.app/acme/issue/BEN-1', 'Linear'],
        ['PAY-2', 'https://acme.atlassian.net/browse/PAY-2', 'Jira'],
        ['X-3', 'https://tracker.example.org/X-3', undefined],
        ['Y-4', undefined, undefined]
      ],
      'every item keeps its own url; an unknown host is a plain link'
    )
    assert.equal(view.decisions?.[0].linkHost?.kind, 'code')
    assert.equal(view.workstreams?.[0].linkHost, undefined, 'a javascript: url is never labelled')
    await worker.deactivate()
  })
})

test('board.get shows a board agent and the live worker doing the same work once: by id, else by name = title', async () => {
  await withFakeOrca(true, async () => {
    const dir = stateFolder()
    const board = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8')) as { agents: Record<string, unknown>[] }
    board.agents = [
      // Same work as live ctx_1 ("pr-review: api#42") but recorded under another id: matched by name.
      { id: 'ctx_a1', name: 'pr-review: api#42', repo: 'api', role: 'worker', state: 'working', detail: 'reviewing' },
      // Same dispatch id as live ctx_2: matched by id even though the names differ.
      { id: 'ctx_2', name: 'triage', repo: 'web', role: 'worker', state: 'working' },
      // No live counterpart: stays a board agent.
      { id: 'ctx_old', name: 'flag cleanup', repo: 'api', role: 'worker', state: 'idle' }
    ]
    writeFileSync(join(dir, 'board.json'), JSON.stringify(board))
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    const view = await worker.request('board.get')
    assert.deepEqual(view.agents?.map((a) => a.name), ['flag cleanup'], 'matched board agents are not shown a second time')
    assert.deepEqual(
      view.workers.map((w) => [w.dispatchId, w.repo, w.detail]),
      [['ctx_1', 'api', 'reviewing'], ['ctx_2', 'web', undefined]],
      'the live row keeps what the board knew (repo, detail)'
    )
    await worker.deactivate()
  })
})

test('board.send types a click into the live coordinator terminal, then Enter, and queues nothing', async () => {
  await withFakeOrca(true, async (log) => {
    const dir = stateFolder()
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    assert.deepEqual(await worker.request('board.send', { text: 'done 1' }), { sent: true, queued: false })
    const calls = readFileSync(log, 'utf8')
    assert.ok(calls.includes('terminal send --terminal term_coord --text done 1'), 'the click reaches the coordinator terminal')
    assert.ok(calls.includes('--enter'), 'followed by Enter')
    assert.ok(!existsSync(join(dir, 'inbox.jsonl')), 'nothing queued while the coordinator is live')
    await worker.deactivate()
  })
})

test('board.send rejects blank text and sends nothing', async () => {
  await withFakeOrca(true, async (log) => {
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: stateFolder() } }) })
    await assert.rejects(worker.request('board.send', { text: '  ' }), /empty text/)
    assert.ok(!existsSync(log) || !readFileSync(log, 'utf8').includes('terminal send'))
    await worker.deactivate()
  })
})


test('board.send never types into a coordinator terminal that runs no agent: it queues instead', async () => {
  // A connected terminal whose agent exited is a bare shell: typed text would run as a command.
  await withFakeOrca('shell', async (log) => {
    const dir = stateFolder()
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    assert.deepEqual(await worker.request('board.send', { text: 'done 1' }), { sent: false, queued: true })
    assert.ok(!readFileSync(log, 'utf8').includes('terminal send'), 'nothing typed into the shell')
    assert.equal(readFileSync(join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').length, 1)
    assert.equal((await worker.request('board.get')).coordinatorLive, false)
    await worker.deactivate()
  })
})

test('board.send offline: queues a pending decision\'s option as a decision, nudge/stop as a command, any other text as a message', async () => {
  await withFakeOrca(false, async () => {
    const dir = stateFolder()
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    for (const text of ['done 1', 'nudge DEMO-102', 'hello world', 'done 3', 'merge 1']) {
      assert.deepEqual(await worker.request('board.send', { text }), { sent: false, queued: true })
    }
    const lines = readFileSync(join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(
      lines.map(({ at: _at, ...entry }) => entry),
      [
        { kind: 'decision', decisionId: '1', optionId: 'done' },
        { kind: 'command', command: 'nudge', target: 'DEMO-102' },
        { kind: 'message', text: 'hello world' },
        { kind: 'message', text: 'done 3' },
        { kind: 'message', text: 'merge 1' }
      ],
      'free text, an answered decision (3) and an unknown option (merge) are not turned into decisions'
    )
    assert.equal((await worker.request('board.get')).coordinatorLive, false)
    await worker.deactivate()
  })
})

// board.cleanup runs the real bin/cleanup.sh through the state folder's bin/cleanup wrapper, with
// a fake orca and gh: a finished worker tab retained, a running one, a finished one in the
// coordinator's own terminal, and one clean worktree whose PR is merged.
const CLEANUP_PACKAGE = new URL('../../', import.meta.url).pathname

function cleanupFixture(): { dir: string; calls: () => string[]; worktree: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-cleanup-')))
  const dir = join(root, 'state')
  const fake = join(root, 'fake')
  const worktreeRoot = join(root, 'wt')
  const worktree = join(worktreeRoot, 'api', 'feat')
  mkdirSync(join(dir, 'bin'), { recursive: true })
  mkdirSync(fake)
  mkdirSync(worktree, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
  git('init', '-q', '-b', 'feat')
  writeFileSync(join(worktree, 'a.txt'), 'a')
  git('add', '.')
  git('commit', '-qm', 'pr work')
  const head = git('rev-parse', 'HEAD')
  const log = join(fake, 'calls.log')
  const workers = [
    { dispatchId: 'ctx_done', state: 'succeeded', terminalState: 'retained', terminal: 'term_done' },
    { dispatchId: 'ctx_live', state: 'running', terminalState: 'retained', terminal: 'term_live' },
    { dispatchId: 'ctx_self', state: 'succeeded', terminalState: 'retained', terminal: 'term_coord' }
  ]
  const worktrees = [{ path: worktree, branch: 'refs/heads/feat', isMainWorktree: false }]
  writeFileSync(
    join(fake, 'orca'),
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "orchestration worker-list") echo '${JSON.stringify({ ok: true, result: { workers } })}' ;;
  "worktree list") echo '${JSON.stringify({ ok: true, result: { worktrees } })}' ;;
  *) echo '{"ok":true,"result":{}}' ;;
esac
`
  )
  writeFileSync(join(fake, 'gh'), `#!/bin/sh\necho "gh $@" >> "${log}"\necho "MERGED ${head}"\n`)
  chmodSync(join(fake, 'orca'), 0o755)
  chmodSync(join(fake, 'gh'), 0o755)
  const config = join(root, 'config.yaml')
  writeFileSync(config, `person:\n  name: Alex\npaths:\n  state: ${dir}\n  workspace: ${root}\n  worktreeRoot: ${worktreeRoot}\n  orca: ${join(fake, 'orca')}\n`)
  writeFileSync(join(dir, 'coordinator-terminal'), 'term_coord\n')
  writeFileSync(
    join(dir, 'bin', 'cleanup'),
    `#!/usr/bin/env bash\nexport COORDINATOR_PACKAGE='${CLEANUP_PACKAGE}' COORDINATOR_STATE='${dir}' ORCA_COORDINATOR_CONFIG='${config}' GH='${join(fake, 'gh')}'\nexec bash '${join(CLEANUP_PACKAGE, 'bin', 'cleanup.sh')}' "$@"\n`
  )
  return { dir, worktree, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) }
}

const isAction = (call: string) => call.startsWith('orchestration worker-release') || call.startsWith('worktree rm')

test('board.cleanup dry run: counts what it would close and remove, and changes nothing', async () => {
  await withFakeOrca(true, async () => {
    const { dir, calls, worktree } = cleanupFixture()
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    const result = await worker.request('board.cleanup', { dryRun: true })
    assert.equal(result.dryRun, true)
    assert.deepEqual(result.counts, { released: 1, removed: 1, kept: 0 })
    assert.deepEqual(result.actions, ['would release ctx_done', 'would remove api/feat'])
    assert.deepEqual(calls().filter(isAction), [], 'a dry run releases no tab and removes no worktree')
    assert.ok(existsSync(worktree))
    await worker.deactivate()
  })
})

test('board.cleanup confirmed: releases the finished worker only (never a running one or the coordinator\'s terminal) and removes the merged worktree', async () => {
  await withFakeOrca(true, async () => {
    const { dir, calls, worktree } = cleanupFixture()
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    const result = await worker.request('board.cleanup', { dryRun: false })
    assert.equal(result.summary, 'released 1 sessions, removed 1 worktrees, kept 0 (dirty/open/unpushed)')
    assert.deepEqual(result.counts, { released: 1, removed: 1, kept: 0 })
    assert.deepEqual(calls().filter(isAction), ['orchestration worker-release --dispatch ctx_done', `worktree rm --worktree path:${worktree} --json`], 'neither the running worker nor the coordinator terminal is released')
    await worker.deactivate()
  })
})

test('board.cleanup: a failing cleanup script rejects instead of reporting a clean run', async () => {
  await withFakeOrca(true, async () => {
    const dir = stateFolder()
    writeFileSync(join(dir, 'bin', 'cleanup'), '#!/bin/sh\necho "orca-coordinator: invalid config" >&2\nexit 3\n')
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    await assert.rejects(worker.request('board.cleanup', { dryRun: true }))
    await worker.deactivate()
  })
})

test('board.switch targets the given terminal, else the coordinator', async () => {
  await withFakeOrca(true, async (log) => {
    const dir = stateFolder()
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    await worker.request('board.switch', { terminal: 'term_w1' })
    await worker.request('board.switch', {})
    const calls = readFileSync(log, 'utf8')
    assert.ok(calls.includes('terminal switch --terminal term_w1'))
    assert.ok(calls.includes('terminal switch --terminal term_coord'))
    await worker.deactivate()
  })
})

/** A temp HOME with XDG folders, so setup and config never touch the real ones. */
async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-home-')))
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'ORCA_COORDINATOR_CONFIG'] as const
  const saved = keys.map((key) => process.env[key])
  delete process.env.ORCA_COORDINATOR_CONFIG
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), XDG_DATA_HOME: join(home, '.local/share') })
  try {
    return await run(home)
  } finally {
    keys.forEach((key, i) => (saved[i] === undefined ? delete process.env[key] : (process.env[key] = saved[i])))
  }
}

const REAL_PACKAGE = realpathSync(new URL('../..', import.meta.url).pathname)

/** A hand-written config.yaml: a header comment, a key the package does not know, and a person field the settings view does not edit. */
function writeConfig(home: string, extra = '', repos?: { name: string; path: string }[], pkg = REAL_PACKAGE): string {
  repos ??= [{ name: 'api', path: existsSync(join(home, 'work/api')) ? join(home, 'work/api') : gitRepo(join(home, 'work/api')) }]
  const file = join(home, '.config/orca-coordinator/config.yaml')
  mkdirSync(join(home, '.config/orca-coordinator'), { recursive: true })
  writeFileSync(
    file,
    `# my coordinator config\n# hand-edited\nschemaVersion: 2\nperson:\n  name: Alex\n  github: alex-dev\npaths:\n  package: ${pkg}\n  state: ${join(home, 'state')}\n  workspace: ${join(home, 'work')}\nrepos:\n${repos.map((r) => `  - name: ${r.name}\n    path: ${r.path}\n    base: develop\n`).join('')}myTeamNotes:\n  keep: true\n${extra}`
  )
  return file
}

/** kinds: what Orca's agents.list reports in the focused workspace (the first kind runs in the coordinator terminal). No kinds = Orca reports nothing. */
async function mount(home: string, kinds: string[] = []) {
  const agents = kinds.map((agent, i) => ({ terminalId: i === 0 ? 'term_coord' : `term_other${i}`, title: null, agent, state: 'working', stateStartedAt: 0 }))
  const dir = join(home, '.local/state/orca-coordinator')
  if (kinds.length) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'coordinator-terminal'), 'term_coord\n')
  }
  return mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir }, results: { 'agents.list': { agents } } }) })
}

test('setup: defaults to the first Orca folder, applies the form answers, then starts the coordinator there', async () => {
  await withHome(async (home) => {
    const workspace = join(home, 'work')
    mkdirSync(workspace)
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Alex Martin\n')
    // A repo is listed before the folder and has a shorter path: the folder still wins.
    mkdirSync(join(workspace, 'notes'))
    const repos: FakeRepo[] = [
      { path: gitRepo(join(home, 'x')), displayName: 'x', kind: 'git' },
      { path: workspace, displayName: 'work', kind: 'folder' },
      { path: gitRepo(join(workspace, 'api')), displayName: 'api', kind: 'git' },
      { path: gitRepo(join(workspace, 'web')), displayName: 'web', kind: 'git' },
      // Orca says git, git says no: a plain folder is never offered as a repo.
      { path: join(workspace, 'notes'), displayName: 'notes', kind: 'git' }
    ]
    await withFakeOrca(false, async (log) => {
      const worker = await mount(home, ['claude'])
      const before = await worker.request('setup.status')
      assert.equal(before.configured, false)
      assert.equal(before.workspaces[0].path, workspace, 'the folder is the default, not the first or shortest repo')
      assert.deepEqual(before.repos.map((r) => r.name), ['x', 'api', 'web'], 'folders, and paths git does not confirm, are not offered as repos to watch')
      assert.equal(before.personName, 'Alex Martin', 'the name is prefilled from git config')

      const result = await worker.request('setup.run', { workspace, name: 'Alex', repos: [join(workspace, 'api')], agents: ['claude'], coordinatorAgent: 'claude', confirmed: true })
      assert.ok(result.ok, result.output)
      const packageHome = join(home, '.local/share/orca-coordinator')
      assert.ok(existsSync(join(packageHome, 'bin', 'coordinator.mjs')), 'package copied to its stable home')
      assert.ok(existsSync(join(home, '.local/state/orca-coordinator/COORDINATOR.md')), 'rules rendered')
      assert.equal(readlinkSync(join(home, '.claude/skills/coordinator')), join(packageHome, 'skill', 'coordinator'))

      const read = await worker.request('config.read')
      assert.deepEqual(read.problems, [])
      assert.equal(read.config?.paths.workspace, workspace)
      assert.equal(read.config?.person.name, 'Alex')
      assert.deepEqual(read.config?.repos.map((r) => r.name), ['api'], 'only the checked repo is watched, not every repo in the folder')
      assert.equal((await worker.request('setup.status')).configured, true)

      assert.deepEqual(await worker.request('setup.start', {}), { started: true, output: '' })
      assert.ok(readFileSync(log, 'utf8').includes(`agent launch --agent claude --worktree path:${workspace}`))
      await worker.deactivate()
    }, repos)
  })
})

test('setup: a form init would reject writes nothing', async () => {
  await withHome(async (home) => {
    const workspace = join(home, 'work')
    mkdirSync(workspace)
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      const missing = await worker.request('setup.run', { workspace: join(home, 'gone'), confirmed: true })
      assert.equal(missing.ok, false)
      assert.ok(!existsSync(join(home, '.config/orca-coordinator')), 'no config written')
      assert.ok(!existsSync(join(home, '.local/share/orca-coordinator')), 'package not copied')
      await worker.deactivate()
    })
  })
})

test('config.read: a missing or invalid config is reported, and an invalid one does not count as set up', async () => {
  await withHome(async (home) => {
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      const none = await worker.request('config.read')
      assert.equal(none.config, null)
      assert.match(none.problems.join('\n'), /no config/)

      writeConfig(home, 'queue:\n  max: 0\n')
      const invalid = await worker.request('config.read')
      assert.equal(invalid.config?.person.name, 'Alex', 'the config is still shown so it can be fixed')
      assert.ok(invalid.problems.some((p) => p.includes('queue.max')), invalid.problems.join('; '))
      assert.equal((await worker.request('setup.status')).configured, false, 'setup is offered again')
      await worker.deactivate()
    })
  })
})

test('config.save: merges into config.yaml keeping unknown keys and the header, then renders', async () => {
  await withHome(async (home) => {
    await withFakeOrca(false, async () => {
      const file = writeConfig(home)
      const worker = await mount(home)
      const before = await worker.request('config.read')
      assert.deepEqual(before.problems, [])
      const result = await worker.request('config.save', {
        patch: {
          person: { name: 'Sam', language: 'fr', tone: 'short' },
          repos: [...before.config!.repos, { name: 'web', path: gitRepo(join(home, 'work/web')), base: 'main' }]
        }
      })
      assert.deepEqual(result.errors, [])
      assert.equal(result.ok, true)

      const yaml = readFileSync(file, 'utf8')
      assert.ok(yaml.startsWith('# my coordinator config\n# hand-edited\n'), 'the header comment is kept')
      assert.match(yaml, /myTeamNotes:\n\s+keep: true/, 'unknown keys are kept')
      assert.match(yaml, /github: alex-dev/, 'fields the view does not edit are kept')
      assert.match(yaml, /path: ~\/work\/web/, 'repo paths are written with ~')
      assert.match(yaml, /base: develop/, 'an existing repo keeps its own fields')

      assert.ok(existsSync(join(home, 'state', 'panel.json')), 'render ran with the saved config')

      const after = await worker.request('config.read')
      assert.equal(after.config?.person.name, 'Sam')
      assert.equal(after.config?.person.language, 'fr')
      assert.deepEqual(after.config?.repos.map((r) => r.name), ['api', 'web'])
      await worker.deactivate()
    })
  })
})

test('config.save: with a stale installed copy of the package (no config --merge), the save still lands in config.yaml', async () => {
  // The bug: the installed copy's CLI printed the config and exited 0 on `config --merge`, so the
  // panel said "saved" while config.yaml never changed.
  await withHome(async (home) => {
    await withFakeOrca(false, async () => {
      const installed = join(home, '.local/share/orca-coordinator')
      mkdirSync(join(installed, 'bin'), { recursive: true })
      writeFileSync(join(installed, 'bin', 'coordinator.mjs'), 'console.log("# old coordinator.mjs: no --merge")\n')
      writeFileSync(join(installed, '.installed-from'), REAL_PACKAGE + '\n')
      const file = writeConfig(home, '', undefined, '~/.local/share/orca-coordinator')
      const worker = await mount(home)
      const result = await worker.request('config.save', { patch: { person: { name: 'Sam', language: 'ja' } } })
      assert.deepEqual(result.errors, [])
      assert.equal(result.ok, true)
      const yaml = readFileSync(file, 'utf8')
      assert.match(yaml, /name: Sam\n/)
      assert.match(yaml, /myTeamNotes:\n\s+keep: true/, 'unknown keys are kept')
      const read = await worker.request('config.read')
      assert.deepEqual([read.config?.person.name, read.config?.person.language], ['Sam', 'ja'], 'the re-read config matches the save')
      assert.equal(readFileSync(join(installed, 'bin', 'coordinator.mjs'), 'utf8'), readFileSync(join(REAL_PACKAGE, 'bin', 'coordinator.mjs'), 'utf8'), 'the stale copy is refreshed before render')
      assert.ok(existsSync(join(home, 'state', 'panel.json')), 'render ran')
      await worker.deactivate()
    })
  })
})

test('config.save: an invalid change is refused, nothing is written and render does not run', async () => {
  await withHome(async (home) => {
    await withFakeOrca(false, async () => {
      const file = writeConfig(home)
      const original = readFileSync(file, 'utf8')
      const worker = await mount(home)
      const result = await worker.request('config.save', { patch: { person: { name: '' } } })
      assert.equal(result.ok, false)
      assert.equal(result.saved, false)
      assert.ok(result.errors.some((e) => e.includes('person.name')), result.errors.join('; '))
      assert.equal(readFileSync(file, 'utf8'), original, 'config.yaml unchanged')
      assert.ok(!existsSync(join(home, 'state', 'panel.json')), 'render did not run')
      await worker.deactivate()
    })
  })
})

/** A git repo for board.get: committed, optionally pushed to a bare remote, then made dirty or ahead. */
function gitRepo(dir: string, options: { branch?: string; remote?: boolean; dirty?: boolean; ahead?: boolean } = {}): string {
  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' })
  mkdirSync(dir, { recursive: true })
  run(dir, 'init', '-q')
  if (options.branch) run(dir, 'checkout', '-q', '-b', options.branch)
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  run(dir, 'add', '.')
  run(dir, 'commit', '-qm', 'first')
  if (options.remote) {
    run(dir, 'init', '-q', '--bare', `${dir}.git`)
    run(dir, 'remote', 'add', 'origin', `${dir}.git`)
    run(dir, 'push', '-q', '-u', 'origin', 'HEAD')
  }
  if (options.ahead) {
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    run(dir, 'add', '.')
    run(dir, 'commit', '-qm', 'second')
  }
  if (options.dirty) {
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
  }
  return dir
}

test('config.save: automations, queue and budget stay byte-for-byte, even when a patch names them, and Orca automations are not touched', async () => {
  await withHome(async (home) => {
    await withFakeOrca(false, async (log) => {
      // Written in the form the config writer emits, so a byte change can only come from the save.
      const block = 'queue:\n  max: 2\n  staleHours: 48\nbudget:\n  stateBytes: 4000\nautomations:\n  enabled: true\n  timezone: Europe/Paris\n  jobs:\n    - playbook: pr-review\n      schedule: 15 9 * * 1-5\n      precheck: pr-review\n      name: My reviews\n      enabled: false\n'
      const file = writeConfig(home, block)
      const worker = await mount(home)
      const patch = { person: { name: 'Sam' }, queue: { max: 9, staleHours: 1 }, budget: { stateBytes: 900 }, automations: { enabled: false, jobs: [] } } as unknown as ConfigPatch
      const result = await worker.request('config.save', { patch })
      assert.deepEqual(result.errors, [])
      const yaml = readFileSync(file, 'utf8')
      assert.match(yaml, /name: Sam\n/, 'the rest of the patch is saved')
      assert.ok(yaml.endsWith(block), 'the queue, budget and automations blocks are unchanged')
      assert.ok(!existsSync(log) || !readFileSync(log, 'utf8').includes('automations'), 'no Orca automation is created or removed')
      await worker.deactivate()
    })
  })
})

test('board.get: Work lists each configured repo\'s uncommitted or unpushed work, not bad repo entries nor what a board task already covers', async () => {
  await withHome(async (home) => {
    const work = join(home, 'work')
    const repos = [
      { name: 'dirty', path: gitRepo(join(work, 'dirty'), { remote: true, dirty: true }) },
      { name: 'clean', path: gitRepo(join(work, 'clean'), { remote: true }) },
      { name: 'ahead', path: gitRepo(join(work, 'ahead'), { remote: true, ahead: true }) },
      { name: 'local-only', path: gitRepo(join(work, 'local-only')) },
      { name: 'covered', path: gitRepo(join(work, 'covered'), { branch: 'me/demo-7', dirty: true }) },
      { name: 'not-a-repo', path: join(work, 'plain') },
      // A folder inside a dirty repo: git status there would report the repo's changes under its name.
      { name: 'inside-dirty', path: join(work, 'dirty', 'docs') },
      { name: 'missing', path: join(work, 'gone') }
    ]
    mkdirSync(join(work, 'plain'))
    mkdirSync(join(work, 'dirty', 'docs'))
    writeConfig(home, '', repos)
    const dir = stateFolder()
    writeFileSync(join(dir, 'board.json'), JSON.stringify({ version: 2, tasks: [{ id: 'DEMO-7', repo: 'covered', status: 'local' }] }))
    const workers = [{ dispatchId: 'ctx_a', state: 'running', outcome: 'in_progress', terminal: 'term_a', taskId: 'task_a' }, { dispatchId: 'ctx_x', state: 'running', terminal: 'term_x', taskId: 'task_x' }]
    await withFakeOrca(false, async () => {
      const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
      const view = await worker.request('board.get')
      assert.deepEqual(view.localWork, [
        { repo: 'dirty', branch: 'main', changed: 2, unpushed: 0 },
        { repo: 'ahead', branch: 'main', changed: 0, unpushed: 1 },
        { repo: 'local-only', branch: 'main', changed: 0, unpushed: 1 }
      ], 'clean, non-git, nested, missing and task-covered repos add no row; no upstream counts commits on no remote')
      assert.deepEqual(view.workers.map((w) => w.dispatchId), ['ctx_a', 'ctx_x'], 'Agents still lists only running workers')
      assert.equal(view.tasks?.length, 1, 'board tasks pass through')
      await worker.deactivate()
    }, [], workers)
  })
})

test('board.get: no config.yaml does not break the board, it only means no local work rows', async () => {
  await withHome(async () => {
    await withFakeOrca(true, async () => {
      const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: stateFolder() } }) })
      const view = await worker.request('board.get')
      assert.equal(view.decisions?.length, 3)
      assert.deepEqual(view.localWork, [])
      await worker.deactivate()
    })
  })
})

test('board.get: a board.json that is not JSON shows an empty board with live workers instead of failing the panel', async () => {
  await withFakeOrca(true, async () => {
    const dir = stateFolder()
    writeFileSync(join(dir, 'board.json'), '{"version": 2, "tasks": [')
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    const view = await worker.request('board.get')
    assert.equal(view.tasks, undefined)
    assert.deepEqual(view.workers.map((w) => w.dispatchId), ['ctx_1', 'ctx_2'])
    assert.equal(view.coordinatorLive, true)
    assert.equal(readFileSync(join(dir, 'board.json'), 'utf8'), '{"version": 2, "tasks": [', 'the panel never rewrites the board')
    await worker.deactivate()
  })
})

test('work.openChanges opens a repo in Orca\'s Source Control, falls back to the CLI diff, and refuses an unknown repo', async () => {
  await withHome(async (home) => {
    const api = gitRepo(join(home, 'work/api'))
    writeConfig(home, '', [{ name: 'api', path: api }])
    const repos: FakeRepo[] = [{ id: 'r-api', path: api, displayName: 'api', kind: 'git' }]
    await withFakeOrca(false, async (log) => {
      const results = { 'workspace.open': { opened: true }, 'commands.run': { ran: true } }
      const host = mockHost({ settings: { coordinatorDir: join(home, 'state') }, capabilities: ['settings:own', 'workspace:write'], results })
      const worker = await mountWorker(main, { host })
      assert.deepEqual(await worker.request('work.openChanges', { repo: 'api' }), { opened: true, via: 'source-control' })
      assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: `r-api::${api}` }], 'the repo\'s own workspace is shown')
      assert.deepEqual(host.callsOf('commands.run'), [{ action: 'sidebar.sourceControl.toggle' }])
      await assert.rejects(worker.request('work.openChanges', { repo: 'nope' }), /unknown repo/)
      await worker.deactivate()

      // Without workspace:write Orca refuses the native path: the CLI opens the diff instead.
      const denied = mockHost({ settings: { coordinatorDir: join(home, 'state') }, capabilities: ['settings:own'] })
      const fallback = await mountWorker(main, { host: denied })
      assert.deepEqual(await fallback.request('work.openChanges', { repo: 'api' }), { opened: true, via: 'cli' })
      assert.ok(readFileSync(log, 'utf8').includes(`file open-changed --mode diff --worktree path:${api} --focus`))
      await fallback.deactivate()
    }, repos)
  })
})

test('agents.openBoard opens Orca\'s Workspace Board, and says so when Orca refuses', async () => {
  await withFakeOrca(true, async () => {
    const host = mockHost({ settings: { coordinatorDir: stateFolder() }, capabilities: ['settings:own', 'workspace:write'], results: { 'commands.run': { ran: true } } })
    const worker = await mountWorker(main, { host })
    assert.deepEqual(await worker.request('agents.openBoard'), { opened: true })
    assert.deepEqual(host.callsOf('commands.run'), [{ action: 'workspace.openBoard' }])
    await worker.deactivate()
    const denied = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: stateFolder() }, capabilities: ['settings:own'] }) })
    assert.equal((await denied.request('agents.openBoard')).opened, false)
    await denied.deactivate()
  })
})

test('config.read: repos entries that are not git repositories (a folder, a folder inside a repo) are offered for removal, not reported as problems', async () => {
  // The bug: init wrote the workspace folder (Orca kind "folder") into repos, so the panel showed it as a repo.
  await withHome(async (home) => {
    const work = join(home, 'work')
    const api = gitRepo(join(work, 'api'))
    mkdirSync(join(api, 'docs'))
    writeConfig(home, '', [{ name: 'work', path: work }, { name: 'api', path: api }, { name: 'docs', path: join(api, 'docs') }])
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      const read = await worker.request('config.read')
      assert.deepEqual(read.config?.repos.map((r) => r.name), ['api'], 'only the git repository is a repo')
      assert.deepEqual(read.skippedRepos.map((r) => r.name), ['work', 'docs'])
      assert.deepEqual(read.problems, [], 'not a problem the user must fix by hand')
      assert.equal((await worker.request('setup.status')).configured, true, 'a warning, not an invalid config')
      await worker.deactivate()
    }, [{ id: 'r-ws', path: work, displayName: 'work', kind: 'folder' }])
  })
})

test('config.save: a repo that is not a git repository is refused and config.yaml is not written', async () => {
  await withHome(async (home) => {
    const work = join(home, 'work')
    const file = writeConfig(home)
    const before = readFileSync(file, 'utf8')
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      const saved = await worker.request('config.save', { patch: { repos: [{ name: 'work', path: work, base: 'main' }] } })
      assert.equal(saved.saved, false)
      assert.match(saved.errors.join('\n'), /not a git repository/)
      assert.equal(readFileSync(file, 'utf8'), before)
      await worker.deactivate()
    })
  })
})

test('config.removeRepo: removes the one ignored folder entry, read back; an entry that is not ignored is refused with no write', async () => {
  await withHome(async (home) => {
    const work = join(home, 'work')
    const api = gitRepo(join(work, 'api'))
    const file = writeConfig(home, '', [{ name: 'Workspace', path: work }, { name: 'api', path: api }])
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      const before = readFileSync(file, 'utf8')
      const refused = await worker.request('config.removeRepo', { path: api })
      assert.equal(refused.saved, false, 'a real git repo is not removed by this action')
      assert.equal(readFileSync(file, 'utf8'), before)

      const removed = await worker.request('config.removeRepo', { path: work })
      assert.deepEqual(removed.errors, [])
      assert.equal(removed.saved, true)
      const read = await worker.request('config.read')
      assert.deepEqual(read.skippedRepos, [])
      assert.deepEqual(read.config?.repos.map((r) => r.name), ['api'])
      const yaml = readFileSync(file, 'utf8')
      assert.ok(!yaml.includes('name: Workspace'), 'gone from config.yaml')
      assert.match(yaml, /myTeamNotes:\n\s+keep: true/, 'unknown keys are kept')
      await worker.deactivate()
    })
  })
})

test('config.save: a form opened before config.yaml changed does not put back a removed repo (the Workspace regression)', async () => {
  // The bug: the settings form sent its whole repo list, loaded before the hand edit, so Save restored the removed entry.
  await withHome(async (home) => {
    const work = join(home, 'work')
    const [api, old, web] = [gitRepo(join(work, 'api')), gitRepo(join(work, 'old')), gitRepo(join(work, 'web'))]
    const file = writeConfig(home, '', [{ name: 'old', path: old }, { name: 'api', path: api }])
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      const stale = await worker.request('config.read')
      // Meanwhile someone removes "old" and adds "web" by hand.
      writeConfig(home, '', [{ name: 'api', path: api }, { name: 'web', path: web }])
      const form = stale.config!.repos
      const result = await worker.request('config.save', { patch: { person: { name: 'Sam' }, repos: [...form, { name: 'extra', path: gitRepo(join(work, 'extra')), base: 'main' }], reposLoaded: form.map((r) => r.path) } })
      assert.deepEqual(result.errors, [])
      const after = await worker.request('config.read')
      assert.deepEqual(after.config?.repos.map((r) => r.name), ['api', 'web', 'extra'], 'the hand edit stands and the form\'s own addition lands')
      assert.equal(after.config?.person.name, 'Sam')
      assert.match(readFileSync(file, 'utf8'), /base: develop/, 'kept entries keep their own fields')
      await worker.deactivate()
    })
  })
})

test('config.save: tool blocks in the patch are ignored, and config.yaml\'s adapter blocks (default and per repo) stay byte-for-byte', async () => {
  await withHome(async (home) => {
    const work = join(home, 'work')
    const [api, web, docs] = [gitRepo(join(work, 'api')), gitRepo(join(work, 'web')), gitRepo(join(work, 'docs'))]
    const file = join(home, '.config/orca-coordinator/config.yaml')
    mkdirSync(join(home, '.config/orca-coordinator'), { recursive: true })
    // Written in the form the config writer emits, so a byte change can only come from the save.
    const adapters = 'adapters:\n  ticketing:\n    kind: linear\n    team: CORE\n    issueUrl: https://linear.test/{id}\n  chat:\n    kind: slack\n    draftOnlyChannels: [general]\n'
    const apiBlock = `  - name: api\n    path: ${api}\n    ticketing:\n      kind: jira\n      team: PAY\n      issueUrl: https://jira.test/{id}\n`
    const webBlock = `  - name: web\n    path: ${web}\n    chat:\n      kind: slack\n      draftOnlyChannels: [web-team]\n`
    writeFileSync(file, `person:\n  name: Alex\npaths:\n  package: ${REAL_PACKAGE}\n  state: ${join(home, 'state')}\n  workspace: ${work}\n${adapters}repos:\n${apiBlock}${webBlock}  - name: docs\n    path: ${docs}\n`)
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      const before = await worker.request('config.read')
      assert.deepEqual(before.problems, [])
      const loaded = before.config!.repos
      // What an older panel could still send: tool blocks on repos and a top-level adapters patch.
      const patch = {
        person: { name: 'Sam' },
        repos: [{ ...loaded[0], ticketing: { kind: 'github' } }, { ...loaded[1], chat: null }, { ...loaded[2], ticketing: { kind: 'trello' } }],
        reposLoaded: loaded.map((r) => r.path),
        adapters: { ticketing: { kind: 'none' }, chat: { kind: 'none' } }
      } as unknown as ConfigPatch
      const result = await worker.request('config.save', { patch })
      assert.deepEqual(result.errors, [])
      const yaml = readFileSync(file, 'utf8')
      assert.match(yaml, /name: Sam\n/, 'the rest of the patch is saved')
      for (const block of [adapters, apiBlock.replace(api, '~/work/api'), webBlock.replace(web, '~/work/web')]) assert.ok(yaml.includes(block), `kept byte-for-byte:\n${block}\n---\n${yaml}`)
      assert.ok(!/trello|github/.test(yaml), 'no tool block from the form')
      await worker.deactivate()
    })
  })
})

// ---- host API or CLI (host.ts) ----

const cliProjects = async (args: string[]): Promise<string> => {
  assert.deepEqual(args, ['repo', 'list', '--json'])
  return JSON.stringify({ result: { repos: [{ id: 'cli', path: '/cli/repo', displayName: 'cli-repo', kind: 'git' }] } })
}

function fakeHost(methods: Record<string, () => unknown>): Host & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    has: (method) => method in methods,
    call: async (method) => {
      calls.push(method)
      return methods[method]()
    }
  }
}

test('listProjects: the host API answers when Orca offers project.list; the CLI answers when it does not', async () => {
  const api = fakeHost({ 'project.list': () => ({ projects: [{ id: 'api', path: '/api/repo', name: 'api-repo', kind: 'git', hostId: 'local' }], truncated: false }) })
  assert.deepEqual(await listProjects(api, async () => assert.fail('the CLI must not run')), [{ id: 'api', path: '/api/repo', displayName: 'api-repo', kind: 'git' }], 'host rows are mapped to the CLI row shape')
  assert.deepEqual(api.calls, ['project.list'])

  const old = fakeHost({})
  assert.deepEqual((await listProjects(old, cliProjects)).map((p) => p.id), ['cli'], 'Orca 1.4.257: no project.list, the CLI path')
  assert.deepEqual(old.calls, [])
  assert.deepEqual((await listProjects(null, cliProjects)).map((p) => p.id), ['cli'], 'no host at all')
})

test('listProjects: a failing host API is a clear error naming the method, not a silent CLI answer', async () => {
  const failing = fakeHost({ 'project.list': () => { throw new Error('capability_denied') } })
  await assert.rejects(listProjects(failing, async () => assert.fail('no silent fallback')), /project\.list failed: capability_denied/)
  const odd = fakeHost({ 'project.list': () => ({}) })
  await assert.rejects(listProjects(odd, cliProjects), /project\.list returned no projects list/)
})

test('setup.status on a host without project.list (Orca 1.4.257) lists repos through the CLI', async () => {
  await withHome(async (home) => {
    const repo = gitRepo(join(home, 'api'))
    await withFakeOrca(false, async (log) => {
      const host = mockHost({ settings: { coordinatorDir: join(home, 'state') } })
      const worker = await mountWorker(main, { host })
      assert.deepEqual((await worker.request('setup.status')).repos.map((r) => r.name), ['api'])
      assert.ok(readFileSync(log, 'utf8').includes('repo list --json'), 'the CLI answered')
      assert.deepEqual(host.callsOf('project.list'), [], 'the host API was not called')
      await worker.deactivate()
    }, [{ path: repo, displayName: 'api', kind: 'git' }])
  })
})

test('board.get writes worker-terminals for the status line: each worker terminal once, no bookkeeping, nothing unsafe', async () => {
  await withFakeOrca(true, async () => {
    const dir = stateFolder()
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    await worker.request('board.get')
    assert.equal(readFileSync(join(dir, 'worker-terminals'), 'utf8'), 'term_w1\nterm_w2\n')
    await worker.deactivate()
  }, undefined, [
    { dispatchId: 'a', state: 'running', terminal: 'term_w1', taskId: 't1' },
    { dispatchId: 'b', state: 'blocked', terminal: 'term_w2', taskId: 't2' },
    { dispatchId: 'c', state: 'running', terminal: 'term_w1', taskId: 't3' },
    { dispatchId: 'd', state: 'running', terminal: 'bad handle; rm', taskId: 't4' },
    { dispatchId: 'e', state: 'succeeded', terminal: null, taskId: 't5' }
  ])
})

// board.remove / board.restore: the real bin/board.mjs edits board.json; no other file changes.
const BOARD_CLI = new URL('../../bin/board.mjs', import.meta.url).pathname

function removableState(): string {
  const dir = stateFolder()
  writeFileSync(join(dir, 'bin', 'board'), `#!/bin/sh\nCOORDINATOR_BOARD='${join(dir, 'board.json')}' exec '${process.execPath}' '${BOARD_CLI}' "$@"\n`)
  chmodSync(join(dir, 'bin', 'board'), 0o755)
  return dir
}

const readBoard = (dir: string) => JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'))

test('board.remove: a task, a workstream and an idle agent leave board.json; Undo puts each back with its fields', async () => {
  await withFakeOrca(true, async () => {
    const dir = removableState()
    execFileSync(join(dir, 'bin', 'board'), ['agent:set', 'old-review', 'idle', '--repo', 'api', '--detail', 'done earlier'])
    const before = readBoard(dir)
    const task = before.tasks[0]
    const ws = before.workstreams[0]
    const agent = before.agents.find((a: { name: string; state: string }) => a.name !== 'coordinator' && a.state !== 'working')
    assert.ok(task && ws && agent, 'fixture has one of each')
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    const removals = [
      await worker.request('board.remove', { kind: 'task', id: task.id }),
      await worker.request('board.remove', { kind: 'workstream', id: ws.id }),
      await worker.request('board.remove', { kind: 'agent', id: agent.name })
    ]
    const after = readBoard(dir)
    assert.ok(!after.tasks.some((t: { id: string }) => t.id === task.id))
    assert.ok(!after.workstreams.some((w: { id: string }) => w.id === ws.id))
    assert.ok(!after.agents.some((a: { name: string }) => a.name === agent.name))
    for (const removal of removals) assert.deepEqual(await worker.request('board.restore', { removal }), { restored: true })
    const restored = readBoard(dir)
    const pick = (item: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => item[k] !== undefined && item[k] !== '').map((k) => [k, item[k]]))
    assert.deepEqual(pick(restored.tasks.find((t: { id: string }) => t.id === task.id), ['id', 'status', 'repo', 'detail', 'url']), pick(task, ['id', 'status', 'repo', 'detail', 'url']))
    assert.equal(restored.workstreams.find((w: { id: string }) => w.id === ws.id).title, ws.title)
    assert.equal(restored.agents.find((a: { name: string }) => a.name === agent.name).state, agent.state)
    await worker.deactivate()
  })
})

test('board.remove refuses the coordinator, a working agent and unknown items, and leaves board.json untouched', async () => {
  await withFakeOrca(true, async () => {
    const dir = removableState()
    const working = readBoard(dir).agents.find((a: { state: string }) => a.state === 'working')
    const bytes = readFileSync(join(dir, 'board.json'), 'utf8')
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    await assert.rejects(worker.request('board.remove', { kind: 'agent', id: 'coordinator' }), /coordinator/)
    if (working) await assert.rejects(worker.request('board.remove', { kind: 'agent', id: working.name }), /working/)
    await assert.rejects(worker.request('board.remove', { kind: 'task', id: 'NOPE-1' }), /no task/)
    await assert.rejects(worker.request('board.remove', { kind: 'worker', id: 'ctx_1' } as never), /required/)
    assert.equal(readFileSync(join(dir, 'board.json'), 'utf8'), bytes)
    await worker.deactivate()
  })
})

/** A home where Claude Code and OpenCode are installed (their config folders exist) and the user has a settings.json. */
function agentHome(home: string): { settings: string; before: string } {
  mkdirSync(join(home, '.claude/skills'), { recursive: true })
  mkdirSync(join(home, '.config/opencode/skills'), { recursive: true })
  const settings = join(home, '.claude/settings.json')
  const before = '{\n  "theme": "dark",\n  "statusLine": { "type": "command", "command": "my-line" }\n}\n'
  writeFileSync(settings, before)
  return { settings, before }
}

test('setup: without the confirmation nothing is written, not even this plugin\'s own files or any agent folder', async () => {
  await withHome(async (home) => {
    const workspace = join(home, 'work')
    mkdirSync(workspace)
    const { settings, before } = agentHome(home)
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      for (const unconfirmed of [{}, { confirmed: false }, { confirmed: 'yes' as unknown as boolean }]) {
        const result = await worker.request('setup.run', { workspace, agents: ['claude', 'opencode'], statusLine: true, ...unconfirmed })
        assert.equal(result.ok, false)
      }
      assert.ok(!existsSync(join(home, '.claude/skills/coordinator')) && !existsSync(join(home, '.config/opencode/skills/coordinator')), 'no skill link')
      assert.equal(readFileSync(settings, 'utf8'), before, 'settings.json untouched')
      assert.ok(!existsSync(join(home, '.config/orca-coordinator')) && !existsSync(join(home, '.local/share/orca-coordinator')), 'no own files either')
      await worker.deactivate()
    })
  })
})

test('setup: the screen lists only the agents Orca reports, and a confirmed setup links exactly the picked ones and leaves settings.json alone unless asked', async () => {
  await withHome(async (home) => {
    const workspace = join(home, 'work')
    mkdirSync(workspace)
    const { settings, before } = agentHome(home)
    await withFakeOrca(false, async () => {
      const worker = await mount(home, ['opencode', 'unlisted-kind'])
      const status = await worker.request('setup.status')
      assert.deepEqual(status.agents.map((a) => a.id), ['opencode', 'unlisted-kind'], 'exactly the kinds Orca reports, even though another agent\'s folder exists here')
      assert.ok(status.agents.every((a) => a.selected === (a.id === 'opencode')), 'only the kind of the coordinator terminal is preselected')
      assert.equal(status.coordinatorAgent, 'opencode')
      assert.equal(status.agents[0].path, '~/.config/opencode/skills/coordinator')
      assert.equal(status.agents[1].path, '', 'a kind with no known skills folder gets no link')
      assert.equal(status.statusLine.available, false, 'no status line file known for this agent')

      const result = await worker.request('setup.run', { workspace, agents: ['opencode'], coordinatorAgent: 'opencode', confirmed: true })
      assert.ok(result.ok, result.output)
      const skill = join(home, '.local/share/orca-coordinator/skill/coordinator')
      assert.equal(readlinkSync(join(home, '.config/opencode/skills/coordinator')), skill)
      assert.ok(!existsSync(join(home, '.claude/skills/coordinator')), 'not reported by Orca, not picked: its folder exists but gets no link')
      assert.equal(readFileSync(settings, 'utf8'), before, 'the status line is only edited when asked for')
      assert.equal((await worker.request('config.read')).config?.agents.coordinator.agent, 'opencode')
      await worker.deactivate()
    })
  })
})

test('setup with no Orca data names no agent: nothing listed, nothing preselected, no status line, no link, no coordinator agent in config', async () => {
  await withHome(async (home) => {
    const workspace = join(home, 'work')
    mkdirSync(workspace)
    agentHome(home)
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      const status = await worker.request('setup.status')
      assert.deepEqual([status.agents, status.coordinatorAgent, status.statusLine.available], [[], '', false])
      assert.ok(!/claude|opencode|codex|gemini/i.test(JSON.stringify(status)), 'the rendered setup data carries no agent name')
      const result = await worker.request('setup.run', { workspace, confirmed: true })
      assert.ok(result.ok, result.output)
      assert.ok(!existsSync(join(home, '.claude/skills/coordinator')) && !existsSync(join(home, '.config/opencode/skills/coordinator')))
      const config = (await worker.request('config.read')).config
      assert.deepEqual([config?.agents.coordinator.agent, config?.agents.worker.agent], ['', ''], 'no default agent')
      await worker.deactivate()
    })
  })
})

test('Start coordinator: the agent comes from what Orca reports or what the user picked; with neither, the user starts it from Orca\'s launcher', async () => {
  await withHome(async (home) => {
    const workspace = join(home, 'work')
    mkdirSync(workspace)
    await withFakeOrca(false, async (log) => {
      assert.ok((await (await mount(home)).request('setup.run', { workspace, confirmed: true })).ok)
      const launches = () => readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('agent launch'))

      const none = await (await mount(home)).request('setup.start', {})
      assert.equal(none.started, false)
      assert.match(none.output, /Orca's own agent launcher/)
      assert.deepEqual(launches(), [], 'nothing launched without an agent')

      const several = await (await mount(home, ['kind-a', 'kind-b'])).request('setup.start', {})
      assert.deepEqual([several.started, several.choices], [false, ['kind-a', 'kind-b']], 'asks which of the reported kinds')
      assert.deepEqual(launches(), [])

      assert.equal((await (await mount(home, ['kind-a', 'kind-b'])).request('setup.start', { agent: 'kind-b' })).started, true)
      assert.equal((await (await mount(home, ['kind-c'])).request('setup.start', {})).started, true, 'a single reported kind needs no question')
      assert.deepEqual(launches().map((line) => line.match(/--agent (\S+)/)?.[1]), ['kind-b', 'kind-c'])
      assert.ok(launches().every((line) => !line.includes('--model')), 'no model unless the user configured one')
    })
  })
})

test('no agent or model name appears in the plugin UI code paths', () => {
  const files = ['panel/index.html', 'src/setup.ts', 'src/worker.ts', 'src/protocol.ts', 'src/host.ts', 'src/links.ts']
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const hit = /claude|opencode|codex|gemini|anthropic|gpt-|sonnet|opus|haiku/i.exec(source)
    assert.equal(hit, null, `${file} names "${hit?.[0]}"`)
  }
})

test('setup: the status line badge edits settings.json only when ticked, keeping the other settings and a backup', async () => {
  await withHome(async (home) => {
    const workspace = join(home, 'work')
    mkdirSync(workspace)
    const { settings } = agentHome(home)
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      assert.ok((await worker.request('setup.run', { workspace, agents: [], coordinatorAgent: 'claude', statusLine: true, confirmed: true })).ok)
      const after = JSON.parse(readFileSync(settings, 'utf8'))
      assert.equal(after.theme, 'dark')
      assert.ok(String(after.statusLine.command).endsWith('statusline.sh'))
      assert.ok(!existsSync(join(home, '.claude/skills/coordinator')), 'no agent ticked: no link')
      await worker.deactivate()
    })
  })
})

test('plugin update refreshes the plugin\'s own files only: stale agent links and settings.json stay as they are, the panel offers "Update links"', async () => {
  await withHome(async (home) => {
    const workspace = join(home, 'work')
    mkdirSync(workspace)
    const { settings, before } = agentHome(home)
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      assert.ok((await worker.request('setup.run', { workspace, agents: ['claude'], confirmed: true })).ok)
      const packageHome = join(home, '.local/share/orca-coordinator')
      // An older install left the Claude link pointing at its own folder; the plugin was updated (marker gone, home outdated).
      const old = join(home, 'old/skill/coordinator')
      mkdirSync(old, { recursive: true })
      rmSync(join(home, '.claude/skills/coordinator'))
      symlinkSync(old, join(home, '.claude/skills/coordinator'))
      writeFileSync(join(packageHome, 'bin/coordinator.mjs'), '// outdated\n')
      rmSync(join(packageHome, '.installed-from'))

      assert.equal((await updateIfInstalledHere()).updated, true)
      assert.notEqual(readFileSync(join(packageHome, 'bin/coordinator.mjs'), 'utf8'), '// outdated\n', 'own files refreshed')
      assert.equal(readlinkSync(join(home, '.claude/skills/coordinator')), old, 'the stale link was not touched by the update')
      assert.ok(!existsSync(join(home, '.config/opencode/skills/coordinator')), 'no new link in another agent')
      assert.equal(readFileSync(settings, 'utf8'), before, 'settings.json untouched')

      assert.deepEqual((await worker.request('board.get')).staleLinks, ['~/.claude/skills/coordinator'])
      assert.deepEqual(await worker.request('setup.updateLinks'), { updated: ['~/.claude/skills/coordinator'] })
      assert.equal(readlinkSync(join(home, '.claude/skills/coordinator')), join(packageHome, 'skill/coordinator'))
      assert.deepEqual((await worker.request('board.get')).staleLinks, [])
      assert.ok(!existsSync(join(home, '.config/opencode/skills/coordinator')), 'Update links never creates a link')
      await worker.deactivate()
    })
  })
})

test('board.get canStart: Start coordinator shows only when set up and not running', async () => {
  await withHome(async (home) => {
    // Not set up: no config.yaml.
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      assert.equal((await worker.request('board.get')).canStart, false, 'not set up')
      await worker.deactivate()
    })
    writeConfig(home)
    await withFakeOrca(false, async () => {
      const worker = await mount(home)
      assert.equal((await worker.request('board.get')).canStart, true, 'set up, stopped')
      await worker.deactivate()
    })
    mkdirSync(join(home, '.local/state/orca-coordinator'), { recursive: true })
    writeFileSync(join(home, '.local/state/orca-coordinator/coordinator-terminal'), 'term_coord\n')
    await withFakeOrca(true, async () => {
      const worker = await mount(home)
      assert.equal((await worker.request('board.get')).canStart, false, 'running')
      await worker.deactivate()
    })
  })
})

/** The coordinator's launches in the fake Orca's log, as argument lines. */
const launchLines = (log: string) => readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('agent launch'))

test('config.read: roles default to Balanced (Max / Standard / Light), levels have no ids, and no model name comes from the plugin', async () => {
  await withHome(async (home) => {
    await withFakeOrca(false, async () => {
      writeConfig(home)
      const worker = await mount(home)
      const read = await worker.request('config.read')
      assert.deepEqual(read.config?.models?.roles, { coordinator: 'max', worker: 'standard', reader: 'light' })
      assert.deepEqual(read.config?.models?.levels, { light: '', standard: '', max: '' })
      assert.equal('models' in read, false, 'no model list is offered: the plugin knows no model')
      assert.deepEqual(read.problems, [])
      await worker.deactivate()
    })
  })
})

test('config.save: only the level per role is written; ids per level and legacy models are not editable here', async () => {
  await withHome(async (home) => {
    await withFakeOrca(false, async () => {
      const file = writeConfig(home, 'models:\n  levels: {light: l-1, standard: "", max: m-1}\n')
      const worker = await mount(home)
      const saved = await worker.request('config.save', { patch: { models: { roles: { coordinator: 'standard', worker: 'light', reader: 'bogus' }, levels: { max: 'invented' } } } as never })
      assert.deepEqual(saved.errors, [])
      const read = (await worker.request('config.read')).config
      assert.deepEqual(read?.models?.roles, { coordinator: 'standard', worker: 'light', reader: 'light' }, 'an unknown level is dropped')
      assert.deepEqual(read?.models?.levels, { light: 'l-1', standard: '', max: 'm-1' }, 'the plugin never writes or invents ids')
      assert.match(readFileSync(file, 'utf8'), /myTeamNotes:\n\s+keep: true/)
      await worker.deactivate()
    })
  })
})

test('setup.start: a level without an id passes no --model; an id passes it; a legacy agents.coordinator.model wins', async () => {
  await withHome(async (home) => {
    await withFakeOrca(false, async (log) => {
      writeConfig(home)
      const worker = await mount(home)
      await worker.request('setup.start', { agent: 'claude' })
      assert.ok(!launchLines(log)[0].includes('--model'), 'Max has no id: Orca\'s default')
      writeConfig(home, 'models:\n  levels: {light: "", standard: std-9, max: max-9}\n')
      await worker.request('setup.start', { agent: 'claude' })
      assert.match(launchLines(log)[1], /--model max-9 --worktree/)
      assert.ok(!launchLines(log)[1].includes('std-9'))
      writeConfig(home, 'models:\n  levels: {light: "", standard: std-9, max: max-9}\nagents:\n  coordinator: {agent: claude, model: by-hand-1}\n')
      await worker.request('setup.start', { agent: 'claude' })
      assert.match(launchLines(log)[2], /--model by-hand-1 --worktree/, 'a model set by hand keeps working and wins')
      await worker.deactivate()
    })
  })
})

// board.closeSession: an idle or finished-but-open worker is released through Orca; nothing else is.
const SESSIONS = [
  { dispatchId: 'ctx_run', state: 'running', outcome: 'in_progress', terminal: 'term_w1', taskId: 'task_1' },
  { dispatchId: 'ctx_done', state: 'succeeded', outcome: 'succeeded', terminalState: 'retained', terminal: 'term_w2', taskId: 'task_2' },
  { dispatchId: 'ctx_self', state: 'succeeded', outcome: 'succeeded', terminalState: 'retained', terminal: 'term_coord', taskId: 'task_3' }
]
const releases = (log: string) => readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('orchestration worker-release'))

test('board.closeSession: releases a finished-but-open session once; board.get lists it as idle before and not after', async () => {
  await withFakeOrca(true, async (log) => {
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: stateFolder() } }) })
    const before = (await worker.request('board.get')) as { workers: { dispatchId: string; status: string }[] }
    assert.deepEqual(before.workers.map((w) => [w.dispatchId, w.status]), [['ctx_run', 'working'], ['ctx_done', 'idle']], 'the coordinator terminal is never listed')
    assert.deepEqual(await worker.request('board.closeSession', { dispatchId: 'ctx_done' }), { closed: true })
    assert.deepEqual(releases(log), ['orchestration worker-release --dispatch ctx_done'])
    await worker.deactivate()
  }, undefined, SESSIONS)
})

test('board.closeSession refuses a working worker, the coordinator terminal and unknown ids: no release', async () => {
  await withFakeOrca(true, async (log) => {
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: stateFolder() } }) })
    await assert.rejects(worker.request('board.closeSession', { dispatchId: 'ctx_run' }), /working/)
    await assert.rejects(worker.request('board.closeSession', { dispatchId: 'ctx_self' }), /coordinator/)
    await assert.rejects(worker.request('board.closeSession', { dispatchId: 'ctx_nope' }), /no worker session/)
    assert.deepEqual(releases(log), [])
    await worker.deactivate()
  }, undefined, SESSIONS)
})

test('board.closeSession: when Orca fails to release, the request rejects and the session stays listed', async () => {
  await withFakeOrca(true, async (log) => {
    const bin = process.env.ORCA_CLI_BIN_DIR as string
    const script = readFileSync(join(bin, 'orca'), 'utf8').replace('case "$1 $2" in', 'case "$1 $2" in\n  "orchestration worker-release") echo "release failed" >&2; exit 1 ;;')
    writeFileSync(join(bin, 'orca'), script)
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: stateFolder() } }) })
    await assert.rejects(worker.request('board.closeSession', { dispatchId: 'ctx_done' }), /release failed|Command failed/)
    const view = (await worker.request('board.get')) as { workers: { dispatchId: string }[] }
    assert.ok(view.workers.some((w) => w.dispatchId === 'ctx_done'), 'row kept')
    assert.equal(releases(log).length, 1, 'tried once, no retry')
    await worker.deactivate()
  }, undefined, SESSIONS)
})

test('settings panel: generic helper lines (no drafts, PRs, tickets or chat), profiles set the three roles, a changed role reads Custom, no model name in the panel', () => {
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  for (const line of ['What the coordinator calls you.', 'The language the coordinator uses with you.', 'How the coordinator writes to you, e.g. brief or detailed.', 'Light is cheapest, Max is smartest and costs most.']) {
    assert.ok(html.includes(line), line)
  }
  const settings = html.slice(html.indexOf('// Intelligence levels per role'), html.indexOf('// Repos: the configured ones'))
  assert.ok(!/draft|\bPR\b|ticket|chat/i.test(html.slice(html.indexOf("field('Name'"), html.indexOf("field('Name'") + 400)), 'helper lines are generic')
  assert.match(settings, /save'.*coordinator: 'standard', worker: 'light', reader: 'light'/)
  assert.match(settings, /balanced'.*coordinator: 'max', worker: 'standard', reader: 'light'/)
  assert.match(settings, /best'.*coordinator: 'max', worker: 'max', reader: 'standard'/)
  assert.match(settings, /profile\.value = profileOf\(\)/, 'changing a role re-derives the profile, Custom when none matches')
  assert.ok(!/gpt|sonnet|opus|haiku|claude/i.test(settings), 'no model name in the settings code')
})

// ---- upgrade safety (rules/90-upgrades.md): the state each released version left on disk ----

const UPGRADE_FIXTURES = new URL('../../test/fixtures/upgrade/', import.meta.url).pathname

/** The fixture of a released version, copied into the temp home as that release wrote it. Returns the state folder. */
function installFixture(home: string, tag: string): string {
  const fill = (text: string) => text.split('__ROOT__/pkg').join(REAL_PACKAGE).split('__ROOT__').join(home).split('__HOME__').join(home)
  const copy = (from: string, to: string) => {
    mkdirSync(join(to, '..'), { recursive: true })
    writeFileSync(to, fill(readFileSync(from, 'utf8')))
  }
  const dir = join(UPGRADE_FIXTURES, tag)
  copy(join(dir, 'config/config.yaml'), join(home, '.config/orca-coordinator/config.yaml'))
  const state = join(home, '.local/state/orca-coordinator')
  for (const file of ['board.json', 'panel.json', 'state.md', 'coordinator-terminal', 'inbox.jsonl']) copy(join(dir, 'state', file), join(state, file))
  return state
}

for (const tag of ['v1.0.0', 'v1.0.1']) {
  test(`upgrade from ${tag}: board.get, setup.status, config.read and config.save work on the old state and keep its data`, async () => {
    await withHome(async (home) => {
      await withFakeOrca(true, async () => {
        const state = installFixture(home, tag)
        const config = join(home, '.config/orca-coordinator/config.yaml')
        const worker = await mount(home)
        const board = JSON.parse(readFileSync(join(state, 'board.json'), 'utf8'))
        const view = await worker.request('board.get')
        assert.equal(view.focus, board.focus)
        assert.deepEqual(view.tasks?.map((t) => t.id), board.tasks.map((t: { id: string }) => t.id))
        assert.deepEqual(view.decisions?.map((d) => d.id), board.decisions.map((d: { id: number }) => d.id))
        assert.equal((await worker.request('setup.status')).configured, true)
        const read = await worker.request('config.read')
        assert.deepEqual(read.problems, [])
        assert.equal(read.config?.person.name, 'Alex')
        // Save after the migration: unknown keys and the migrated version stay; one backup of the original.
        assert.ok((await worker.request('config.save', { patch: { person: { name: 'Sam' } } })).saved)
        const saved = readFileSync(config, 'utf8')
        assert.match(saved, /^schemaVersion: 2$/m)
        assert.match(saved, /optional: \[planning-tracker, five-line-plan, drafts\]/)
        assert.match(saved, /name: Sam/)
        assert.deepEqual(readdirSync(join(config, '..')).filter((f) => f.includes('.bak')), ['config.yaml.bak-v0'])
        assert.match(readFileSync(`${config}.bak-v0`, 'utf8'), /name: Alex/)
        assert.equal(readFileSync(join(state, 'coordinator-terminal'), 'utf8'), 'term_fixture\n')
        assert.deepEqual(worker.refusals, [])
        await worker.deactivate()
      })
    })
  })

  test(`upgrade from ${tag}: the plugin update runs the migrations, twice is the same, and never runs setup or rewrites the config otherwise`, async () => {
    await withHome(async (home) => {
      const state = installFixture(home, tag)
      const config = join(home, '.config/orca-coordinator/config.yaml')
      const original = readFileSync(config, 'utf8')
      await updateIfInstalledHere()
      const migrated = readFileSync(config, 'utf8')
      assert.equal(migrated, original.replace(/^(#.*\n)+/, (header) => `${header}schemaVersion: 2\n`) + 'rules:\n  optional: [planning-tracker, five-line-plan, drafts]\n', 'only the version line and the explicit rules were added')
      assert.equal(readFileSync(`${config}.bak-v0`, 'utf8'), original)
      await updateIfInstalledHere()
      assert.equal(readFileSync(config, 'utf8'), migrated, 'idempotent')
      assert.equal(readFileSync(`${config}.bak-v0`, 'utf8'), original, 'backup written once')
      assert.ok(!existsSync(join(home, '.claude')), 'setup did not run: no agent folder')
      assert.equal(readFileSync(join(state, 'coordinator-terminal'), 'utf8'), 'term_fixture\n')
    })
  })
}

test('board.get: a board.json with the wrong types, or that is not an object, still answers; unknown fields pass through', async () => {
  await withFakeOrca(true, async () => {
    const dir = stateFolder()
    const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: dir } }) })
    writeFileSync(join(dir, 'board.json'), JSON.stringify({ version: 2, focus: 7, decisions: 'nope', tasks: [null, { id: 'A-1' }, 3], futureField: { a: 1 } }))
    const view = (await worker.request('board.get')) as unknown as Record<string, unknown> & { tasks?: { id: string }[] }
    assert.deepEqual(view.tasks, [{ id: 'A-1' }])
    assert.equal(view.decisions, undefined)
    assert.equal(view.focus, undefined)
    assert.deepEqual(view.futureField, { a: 1 })
    for (const junk of ['[]', 'null', '"text"', '{broken']) {
      writeFileSync(join(dir, 'board.json'), junk)
      assert.equal((await worker.request('board.get')).coordinatorLive, true, junk)
    }
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  })
})
