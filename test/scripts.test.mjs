import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ok, ROOT, sandbox } from './helpers.mjs'

const terminals = (list) => ({ match: ['terminal', 'list'], stdout: ok({ terminals: list }) })

function routeBox(rules) {
  const box = sandbox()
  fs.mkdirSync(box.state, { recursive: true })
  fs.writeFileSync(path.join(box.state, 'coordinator-terminal'), 'term_1')
  box.fake('orca', rules)
  return box
}

// ---- route.sh ----

test('route.sh: a live coordinator gets the trigger and the run is skipped (exit 2)', () => {
  const box = routeBox([terminals([{ handle: 'term_1', connected: true, agentIdentity: 'claude' }]), { match: ['terminal', 'send'], stdout: ok({}) }])
  assert.equal(box.run('bin/route.sh', ['cleanup', 'none']).status, 2)
  const send = box.calls('orca').find((a) => a[1] === 'send')
  assert.equal(send[send.indexOf('--text') + 1], '[trigger] cleanup')
})

test('route.sh: a state.md over budget.stateBytes adds "prune it first" to the trigger', () => {
  const box = routeBox([terminals([{ handle: 'term_1', connected: true, agentIdentity: 'claude' }]), { match: ['terminal', 'send'], stdout: ok({}) }])
  fs.writeFileSync(path.join(box.state, 'state.md'), 'x'.repeat(3000))
  assert.equal(box.run('bin/route.sh', ['pr-review', 'none']).status, 2)
  const send = box.calls('orca').find((a) => a[1] === 'send')
  assert.equal(send[send.indexOf('--text') + 1], '[trigger] pr-review (state.md is 3000 bytes, over budget: prune it first)')
})

test('route.sh: no live coordinator lets the automation run (exit 0), nothing sent', () => {
  const box = routeBox([terminals([{ handle: 'term_1', connected: true, agentIdentity: null }])])
  assert.equal(box.run('bin/route.sh', ['cleanup', 'none']).status, 0)
  assert.ok(!box.calls('orca').some((a) => a[1] === 'send'))
})

test('route.sh: a failed precheck skips the run (exit 1) before asking Orca anything', () => {
  const box = routeBox([])
  fs.mkdirSync(path.join(box.state, 'automations'), { recursive: true })
  const pre = path.join(box.state, 'automations', 'precheck-nothing.sh')
  fs.writeFileSync(pre, '#!/bin/sh\nexit 1\n')
  fs.chmodSync(pre, 0o755)
  assert.equal(box.run('bin/route.sh', ['cleanup', 'nothing']).status, 1)
  assert.deepEqual(box.calls('orca'), [])
})

test('route.sh: when Orca cannot list terminals the run is skipped, not started as a second coordinator (bug 12)', () => {
  const box = routeBox([{ match: ['terminal', 'list'], stdout: '', status: 1 }])
  const out = box.run('bin/route.sh', ['cleanup', 'none'])
  assert.equal(out.status, 1)
  assert.match(out.err, /terminal list/)
})

// ---- metrics.sh ----

test('metrics.sh: a day without corrections appends one valid 11-column row (bug 11)', () => {
  const box = sandbox()
  fs.mkdirSync(box.state, { recursive: true })
  fs.writeFileSync(path.join(box.state, 'lessons.md'), '# Lessons\n- 2020-01-01 old miss\n')
  box.fake('orca', [{ match: ['worker-list'], stdout: ok({ workers: [] }) }])
  const out = box.run('bin/metrics.sh')
  assert.equal(out.status, 0, out.err)
  const rows = fs.readFileSync(path.join(box.state, 'metrics.tsv'), 'utf8').trimEnd().split('\n')
  assert.equal(rows.length, 2, 'header + one row')
  const cells = rows[1].split('\t')
  assert.equal(cells.length, 11)
  for (const cell of cells.slice(1)) assert.match(cell, /^\d+$/, `numeric cell in ${JSON.stringify(rows[1])}`)
  assert.equal(cells[1], '0')
})

// ---- cleanup.sh ----

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

// The merged-and-removed and dry-run cases run through the panel's board.cleanup (plugin/src/worker.test.ts).
test('cleanup.sh: a clean worktree with commits its merged PR does not have is kept (bug 16)', () => {
  const box = sandbox()
  const worktreeRoot = path.join(box.dir, 'wt')
  box.writeConfig({ person: { name: 'Alex' }, paths: { state: box.state, workspace: box.dir, worktreeRoot, orca: path.join(box.dir, 'fake', 'orca') } })
  const repo = path.join(worktreeRoot, 'api', 'feat')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'feat')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'pr work')
  const prHead = git(repo, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'follow-up never pushed')
  box.fake('orca', [
    { match: ['worker-list'], stdout: ok({ workers: [] }) },
    { match: ['worktree', 'list'], stdout: ok({ worktrees: [{ path: repo, branch: 'refs/heads/feat', isMainWorktree: false }] }) },
    { match: [], stdout: ok({}) }
  ])
  box.fake('gh', [{ match: ['pr', 'list'], stdout: JSON.stringify([{ state: 'MERGED', headRefOid: prHead }]) }])
  const out = box.run('bin/cleanup.sh')
  assert.equal(out.status, 0, out.err)
  assert.ok(!box.calls('orca').some((a) => a[0] === 'worktree' && a[1] === 'rm'))
  assert.match(out.out, /removed 0 worktrees, kept 1/)
})

// Orca decides which worktrees exist; with no paths.worktreeRoot every non-main one is a candidate.
function worktreeFixture({ worktreeRoot } = {}) {
  const box = sandbox()
  box.writeConfig({ person: { name: 'Alex' }, paths: { state: box.state, workspace: box.dir, orca: path.join(box.dir, 'fake', 'orca'), ...(worktreeRoot ? { worktreeRoot } : {}) } })
  const main = path.join(box.dir, 'repo')
  fs.mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(main, 'a.txt'), 'a')
  git(main, 'add', '.')
  git(main, 'commit', '-qm', 'base')
  const base = git(main, 'rev-parse', 'HEAD')
  const trees = {}
  const add = (name, { extraCommit = false } = {}) => {
    const dir = path.join(box.dir, 'wt', name)
    git(main, 'worktree', 'add', '-q', '-b', name, dir)
    if (extraCommit) {
      fs.writeFileSync(path.join(dir, `${name}.txt`), name)
      git(dir, 'add', '.')
      git(dir, 'commit', '-qm', `${name} work`)
    }
    trees[name] = { dir, head: git(dir, 'rev-parse', 'HEAD') }
    return trees[name]
  }
  const prs = {}
  const configure = ({ workers = [], terminals = [] } = {}) => {
    const worktrees = [{ path: main, branch: 'refs/heads/main', isMainWorktree: true }, ...Object.entries(trees).map(([name, t]) => ({ path: t.dir, branch: `refs/heads/${name}`, isMainWorktree: false }))]
    box.fake('orca', [
      { match: ['worker-list'], stdout: ok({ workers }) },
      { match: ['terminal', 'list'], stdout: ok({ terminals }) },
      { match: ['worktree', 'list'], stdout: ok({ worktrees }) },
      { match: [], stdout: ok({}) }
    ])
    box.fake('gh', [...Object.entries(prs).map(([name, pr]) => ({ match: ['pr', 'list', name], stdout: JSON.stringify(pr) })), { match: ['pr', 'list'], stdout: '[]' }])
  }
  const removed = () => box.calls('orca').filter((a) => a[0] === 'worktree' && a[1] === 'rm').map((a) => a[a.indexOf('--worktree') + 1])
  return { box, main, base, add, prs, configure, removed, trees }
}

test('cleanup.sh without worktreeRoot: removes done worktrees through orca, keeps everything unsafe, says why', () => {
  const f = worktreeFixture()
  const ff = f.add('ff-merged')
  const squash = f.add('squash', { extraCommit: true })
  const closed = f.add('closed', { extraCommit: true })
  const dirty = f.add('dirty')
  fs.writeFileSync(path.join(dirty.dir, 'wip.txt'), 'x')
  const unpushed = f.add('unpushed', { extraCommit: true })
  const live = f.add('live')
  const terminal = f.add('terminal')
  const open = f.add('open', { extraCommit: true })
  const nopr = f.add('nopr', { extraCommit: true })
  f.prs.squash = [{ state: 'MERGED', number: 7, headRefOid: squash.head }]
  f.prs.closed = [{ state: 'CLOSED', number: 8, headRefOid: closed.head }]
  f.prs.unpushed = [{ state: 'MERGED', number: 9, headRefOid: f.base }]
  f.prs.open = [{ state: 'OPEN', number: 10, headRefOid: open.head }]
  f.configure({
    workers: [{ dispatchId: 'ctx_live', state: 'ready', liveness: 'live', terminalState: 'active', terminal: 'term_w', workspace: `repo-id::${live.dir}` }],
    terminals: [{ handle: 'term_open', worktreePath: terminal.dir }]
  })

  const dry = f.box.run('bin/cleanup.sh', ['-n'])
  assert.equal(dry.status, 0, dry.err)
  assert.deepEqual(f.removed(), [], 'a dry run removes nothing')
  assert.ok(!/not configured/.test(dry.err))
  for (const line of [
    'worktrees: would remove wt/ff-merged (merged)',
    'worktrees: would remove wt/squash (merged #7)',
    'worktrees: would remove wt/closed (closed #8)',
    'worktrees: kept wt/dirty: dirty',
    'worktrees: kept wt/unpushed: unpushed',
    'worktrees: kept wt/live: live (worker or open terminal)',
    'worktrees: kept wt/terminal: live (worker or open terminal)',
    'worktrees: kept wt/open: open PR #10',
    'worktrees: kept wt/nopr: no merged or closed PR'
  ]) assert.ok(dry.out.split('\n').includes(line), `${line}\n${dry.out}`)
  assert.match(dry.out, /removed 3 worktrees, kept 6/)

  const real = f.box.run('bin/cleanup.sh')
  assert.equal(real.status, 0, real.err)
  assert.deepEqual(f.removed().sort(), [ff, squash, closed].map((t) => `path:${t.dir}`).sort())
  assert.ok(!f.removed().includes(`path:${f.main}`), 'the main checkout is never removed')
  assert.ok(!f.box.calls('orca').flat().some((a) => a === '--force' || a === '--delete-branch'))
})

test('cleanup.sh: paths.worktreeRoot only narrows the candidates', () => {
  const f = worktreeFixture({ worktreeRoot: undefined })
  const inside = f.add('inside')
  const outside = f.add('outside')
  f.box.writeConfig({ person: { name: 'Alex' }, paths: { state: f.box.state, workspace: f.box.dir, orca: path.join(f.box.dir, 'fake', 'orca'), worktreeRoot: path.dirname(inside.dir) + '/in' } })
  const moved = path.join(path.dirname(inside.dir), 'in', 'inside')
  fs.mkdirSync(path.dirname(moved), { recursive: true })
  git(f.main, 'worktree', 'move', inside.dir, moved)
  inside.dir = moved
  f.configure()
  const out = f.box.run('bin/cleanup.sh')
  assert.equal(out.status, 0, out.err)
  assert.deepEqual(f.removed(), [`path:${moved}`])
  assert.ok(!out.out.includes('outside'))
  void outside
})

test('cleanup.sh: stale git worktree entries are pruned (dry run only lists them)', () => {
  const f = worktreeFixture()
  const gone = f.add('gone')
  fs.rmSync(gone.dir, { recursive: true })
  delete f.trees.gone
  f.configure()
  const dry = f.box.run('bin/cleanup.sh', ['-n'])
  assert.match(dry.out, /worktrees: would prune stale worktree entry: .*gone/)
  assert.match(git(f.main, 'worktree', 'list'), /gone/)
  const real = f.box.run('bin/cleanup.sh')
  assert.match(real.out, /worktrees: pruned stale worktree entry: .*gone/)
  assert.ok(!/gone/.test(git(f.main, 'worktree', 'list')))
})

test('cleanup.sh: releases settled workers whose terminal is retained, never a live one', () => {
  const f = worktreeFixture()
  f.configure({
    workers: [
      { dispatchId: 'ctx_done', state: 'succeeded', liveness: 'exited', terminalState: 'retained', terminal: 'term_done' },
      { dispatchId: 'ctx_live', state: 'ready', liveness: 'live', terminalState: 'retained', terminal: 'term_live' },
      { dispatchId: 'ctx_old', state: 'succeeded', liveness: 'exited', terminalState: 'released', terminal: 'term_old' }
    ]
  })
  const out = f.box.run('bin/cleanup.sh')
  assert.equal(out.status, 0, out.err)
  const released = f.box.calls('orca').filter((a) => a[1] === 'worker-release').map((a) => a[a.indexOf('--dispatch') + 1])
  assert.deepEqual(released, ['ctx_done'])
  assert.match(out.out, /released 1 sessions/)
})

test('cleanup.sh: merged tasks and answered decisions are archived, open ones stay', () => {
  const f = worktreeFixture()
  f.configure()
  const board = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'board.mjs'), ...args], { encoding: 'utf8', env: { ...f.box.env, COORDINATOR_STATE: f.box.state, ORCA_COORDINATOR_CONFIG: f.box.configPath } })
  board('init')
  board('task:add', 'T-1', '--status', 'merged', '--pr', '5')
  board('task:add', 'T-2', '--status', 'pr')
  board('ask', 'Ship it?')
  board('ask', 'Rename?')
  board('answer', '1', 'done')
  const dry = f.box.run('bin/cleanup.sh', ['-n'])
  assert.match(dry.out, /board: would archive task T-1 \(merged #5\)/)
  assert.match(dry.out, /board: would archive decision 1/)
  assert.match(dry.out, /archived 2 board items/)
  assert.equal(JSON.parse(board('show', '--json').stdout).tasks.length, 2, 'a dry run changes nothing')
  const real = f.box.run('bin/cleanup.sh')
  assert.equal(real.status, 0, real.err)
  const after = JSON.parse(board('show', '--json').stdout)
  assert.deepEqual(after.tasks.map((t) => t.id), ['T-2'])
  assert.deepEqual(after.decisions.map((d) => d.title), ['Rename?'])
  const archive = fs.readdirSync(path.join(f.box.state, 'archive')).filter((n) => /^done-\d{4}-\d{2}\.md$/.test(n))
  assert.equal(archive.length, 1)
  const text = fs.readFileSync(path.join(f.box.state, 'archive', archive[0]), 'utf8')
  assert.match(text, /task T-1/)
  assert.match(text, /decision 1: Ship it\?/)
})

// ---- adapters ----

const slackBox = (secretRef) => {
  const box = sandbox({ config: { adapters: { chat: { kind: 'slack', secretRef } } } })
  box.fake('curl', [{ match: [], stdout: JSON.stringify({ messages: { matches: [] } }) }])
  return box
}

test('slack.sh: secretRef env:NAME sends that variable as the token (bug 3)', () => {
  const box = slackBox('env:SLACK_TEST_TOKEN')
  const out = box.run('adapters/chat/slack.sh', ['search', 'hello'], { extraEnv: { SLACK_TEST_TOKEN: 'xoxb-123' } })
  assert.equal(out.status, 0, out.err)
  assert.ok(box.calls('curl')[0].includes('Authorization: Bearer xoxb-123'))
})

test('slack.sh: a missing credential exits non-zero and calls nothing (bug 15)', () => {
  const box = slackBox('env:SLACK_TEST_TOKEN')
  const out = box.run('adapters/chat/slack.sh', ['search', 'hello'])
  assert.equal(out.status, 3)
  assert.match(out.err, /no chat credential/)
  assert.deepEqual(box.calls('curl'), [])
})

test('unleash.sh toggle: a state other than on|off is refused, not sent as off', () => {
  const box = sandbox({ config: { adapters: { flags: { kind: 'unleash', baseUrl: 'https://flags.test', secretRef: 'env:FLAG_TOKEN' } } } })
  box.fake('curl', [{ match: [], stdout: '{}' }])
  const out = box.run('adapters/flags/unleash.sh', ['toggle', 'new-checkout', 'production', 'ON', '--yes'], { extraEnv: { FLAG_TOKEN: 't' } })
  assert.equal(out.status, 1)
  assert.match(out.err, /on\|off/)
  assert.deepEqual(box.calls('curl'), [])
})

// ---- prechecks ----

function prReviewBox(seen) {
  const box = sandbox({ config: { github: { org: 'acme', reviewTeams: [], skipRepos: [] } } })
  const stateDir = path.join(box.state, 'automations', 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'pr-reviewed.txt'), seen)
  box.fake('gh', [
    { match: ['search', '--review-requested=@me'], stdout: JSON.stringify([{ number: 42, repository: { name: 'api' }, author: { login: 'bob' } }]) },
    { match: ['search'], stdout: '[]' },
    { match: ['pr', 'view'], stdout: JSON.stringify({ headRefOid: 'sha2', isDraft: false }) }
  ])
  return box
}

test('prechecks/pr-review.sh: a PR whose head was already reviewed does not trigger', () => {
  assert.equal(prReviewBox('api#42@sha2\n').run('prechecks/pr-review.sh').status, 1)
})

test('prechecks/pr-review.sh: new commits on a reviewed PR trigger a new review', () => {
  const out = prReviewBox('api#42@sha1\n').run('prechecks/pr-review.sh')
  assert.equal(out.status, 0)
  assert.equal(out.out, 'to review: api#42@sha2')
})

function evalBox(lastRunDaysAgo) {
  const box = sandbox()
  const stateDir = path.join(box.state, 'automations', 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(box.state, 'lessons.md'), '- 2026-01-01 a\n- 2026-01-02 b\n')
  const epoch = Math.floor(Date.now() / 1000) - lastRunDaysAgo * 86400
  fs.writeFileSync(path.join(stateDir, 'eval-weekly-last.txt'), `1 ${epoch}\n`)
  return { box, file: path.join(stateDir, 'eval-weekly-last.txt') }
}

test('prechecks/eval-weekly.sh: new lessons wait until the last run is 6 days old', () => {
  const { box, file } = evalBox(2)
  const before = fs.readFileSync(file, 'utf8')
  assert.equal(box.run('prechecks/eval-weekly.sh').status, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a skipped run does not move the gate')
})

test('prechecks/eval-weekly.sh: new lessons and a 7-day-old run trigger and record the run', () => {
  const { box, file } = evalBox(7)
  const out = box.run('prechecks/eval-weekly.sh')
  assert.equal(out.status, 0)
  assert.equal(out.out, 'new lessons: 1')
  assert.match(fs.readFileSync(file, 'utf8'), /^2 \d+\n$/)
})

// ---- bin/scan.sh ----

function scanBox({ onBoard = [] } = {}) {
  const box = sandbox()
  fs.mkdirSync(box.state, { recursive: true })
  fs.writeFileSync(path.join(box.state, 'board.json'), JSON.stringify({ decisions: [], tasks: onBoard.map((url) => ({ url })) }))
  const pr = (number, repo, login) => ({ number, repository: { name: repo }, url: `https://github.com/acme/${repo}/pull/${number}`, title: `PR ${number}`, author: { login }, commentsCount: 2 })
  box.fake('gh', [
    { match: ['api'], stdout: JSON.stringify(['v1.0.1', 'v1.2.0', 'v1.10.0'].map((name) => ({ name }))) },
    { match: ['search', '--review-requested=@me'], stdout: JSON.stringify([pr(7, 'api', 'bob'), pr(8, 'api', 'bob'), pr(9, 'api', 'alex')]) },
    { match: ['search', '--author=@me'], stdout: JSON.stringify([pr(3, 'web', 'alex')]) }
  ])
  box.fake('orca', [{ match: ['automations', 'list'], stdout: ok({ automations: [
    { id: 'a1', name: 'Job · pr-review', enabled: true, prompt: '[trigger] pr-review' },
    { id: 'a2', name: 'My own PR review', enabled: false, prompt: 'review my prs' }
  ] }) }])
  return box
}

test('scan.sh: lists review-requested PRs of others and skips those already on the board', () => {
  const out = scanBox({ onBoard: ['https://github.com/acme/api/pull/8'] }).run('bin/scan.sh')
  assert.equal(out.status, 0, out.err)
  const lines = out.out.split('\n')
  assert.deepEqual(lines.filter((l) => l.startsWith('review\t')).map((l) => l.split('\t')[1]), ['api#7'])
  assert.deepEqual(lines.filter((l) => l.startsWith('mine\t')).map((l) => l.split('\t')[1]), ['web#3'])
})

test('scan.sh: a PR on the board as a task is not listed as one of mine again', () => {
  const out = scanBox({ onBoard: ['https://github.com/acme/web/pull/3'] }).run('bin/scan.sh')
  assert.ok(!out.out.includes('mine\t'))
})

test('scan.sh: separates the coordinator\'s automations from others and compares versions numerically', () => {
  const out = scanBox().run('bin/scan.sh').out.split('\n')
  assert.ok(out.includes('automation\ta1\tenabled\tours:pr-review\tJob · pr-review'))
  assert.ok(out.includes('automation\ta2\tdisabled\tother\tMy own PR review'))
  assert.match(out.find((l) => l.startsWith('version\t')), /^version\t[\d.]+\t1\.10\.0\toutdated$/)
})

test('scan.sh: a failed gh or orca is reported as unavailable, not as an empty result', () => {
  const box = sandbox()
  fs.mkdirSync(box.state, { recursive: true })
  box.fake('gh', [{ match: [], stdout: '', status: 1 }])
  box.fake('orca', [{ match: [], stdout: '', status: 1 }])
  const out = box.run('bin/scan.sh')
  assert.equal(out.status, 0, out.err)
  for (const kind of ['automation', 'review', 'mine']) assert.ok(out.out.split('\n').includes(`${kind}\tunavailable`), kind)
  assert.match(out.out, /^version\t[\d.]+\tunknown\tcurrent$/m)
})
