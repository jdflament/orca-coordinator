import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ok, sandbox } from './helpers.mjs'

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
