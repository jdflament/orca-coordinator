// Runs src/worker.ts's activate(orca) over a mock host, with a fake Orca CLI on
// ORCA_CLI_BIN_DIR and a temp coordinator state folder.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'
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
    assert.equal(view.focus, 'PROJ-100 checkout redesign: merge api #42, then web #310')
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
    for (const text of ['done 1', 'nudge PROJ-102', 'hello world', 'done 3', 'merge 1']) {
      assert.deepEqual(await worker.request('board.send', { text }), { sent: false, queued: true })
    }
    const lines = readFileSync(join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(
      lines.map(({ at: _at, ...entry }) => entry),
      [
        { kind: 'decision', decisionId: '1', optionId: 'done' },
        { kind: 'command', command: 'nudge', target: 'PROJ-102' },
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
    `# my coordinator config\n# hand-edited\nperson:\n  name: Alex\n  github: alex-dev\npaths:\n  package: ${pkg}\n  state: ${join(home, 'state')}\n  workspace: ${join(home, 'work')}\nrepos:\n${repos.map((r) => `  - name: ${r.name}\n    path: ${r.path}\n    base: develop\n`).join('')}myTeamNotes:\n  keep: true\n${extra}`
  )
  return file
}

async function mount(home: string) {
  return mountWorker(main, { host: mockHost({ settings: { coordinatorDir: join(home, '.local/state/orca-coordinator') } }) })
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
      const worker = await mount(home)
      const before = await worker.request('setup.status')
      assert.equal(before.configured, false)
      assert.equal(before.workspaces[0].path, workspace, 'the folder is the default, not the first or shortest repo')
      assert.deepEqual(before.repos.map((r) => r.name), ['x', 'api', 'web'], 'folders, and paths git does not confirm, are not offered as repos to watch')
      assert.equal(before.personName, 'Alex Martin', 'the name is prefilled from git config')

      const result = await worker.request('setup.run', { workspace, name: 'Alex', repos: [join(workspace, 'api')] })
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

      assert.deepEqual(await worker.request('setup.start'), { started: true, output: '' })
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
      const missing = await worker.request('setup.run', { workspace: join(home, 'gone') })
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
      { name: 'covered', path: gitRepo(join(work, 'covered'), { branch: 'alex/proj-7', dirty: true }) },
      { name: 'not-a-repo', path: join(work, 'plain') },
      // A folder inside a dirty repo: git status there would report the repo's changes under its name.
      { name: 'inside-dirty', path: join(work, 'dirty', 'docs') },
      { name: 'missing', path: join(work, 'gone') }
    ]
    mkdirSync(join(work, 'plain'))
    mkdirSync(join(work, 'dirty', 'docs'))
    writeConfig(home, '', repos)
    const dir = stateFolder()
    writeFileSync(join(dir, 'board.json'), JSON.stringify({ version: 2, tasks: [{ id: 'PROJ-7', repo: 'covered', status: 'local' }] }))
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

test('panel.font hands over Orca\'s own Geist file in chunks under the panel message cap, and nothing when Orca has none', async () => {
  const fonts = mkdtempSync(join(tmpdir(), 'orca-fonts-'))
  const previous = process.env.ORCA_COORDINATOR_FONT_DIR
  process.env.ORCA_COORDINATOR_FONT_DIR = fonts
  try {
    await withFakeOrca(true, async () => {
      const worker = await mountWorker(main, { host: mockHost({ settings: { coordinatorDir: stateFolder() } }) })
      assert.deepEqual(await worker.request('panel.font', { part: 0 }), { family: '', data: '', parts: 0 }, 'no font file: the panel keeps its fallback')

      const bytes = Buffer.alloc(70000, 7)
      bytes.write('wOF2', 0, 'latin1')
      writeFileSync(join(fonts, 'Geist-Variable-abc123.woff2'), bytes)
      const first = await worker.request('panel.font', { part: 0 })
      assert.equal(first.family, 'Geist')
      assert.ok(first.parts >= 2, 'a 70 KB font does not fit one 64 KB panel message')
      const chunks = [first.data]
      for (let part = 1; part < first.parts; part++) chunks.push((await worker.request('panel.font', { part })).data)
      assert.ok(chunks.every((chunk) => JSON.stringify(chunk).length < 60000), 'each chunk fits a panel message')
      assert.ok(Buffer.from(chunks.join(''), 'base64').equals(bytes), 'the chunks rebuild the exact file')

      writeFileSync(join(fonts, 'Geist-Variable-abc123.woff2'), Buffer.alloc(400000, 1))
      assert.equal((await worker.request('panel.font', { part: 0 })).parts, 0, 'not a WOFF2 file, or too large: fall back')
      await worker.deactivate()
    })
  } finally {
    if (previous === undefined) delete process.env.ORCA_COORDINATOR_FONT_DIR
    else process.env.ORCA_COORDINATOR_FONT_DIR = previous
  }
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
