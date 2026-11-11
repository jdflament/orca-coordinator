// Ticketing and chat per repository: a repos[] entry's own block, the top-level default, and a
// repository's own .orca-coordinator.yaml, resolved the same way by the CLI, the rendered
// wrappers, the adapters (through env.sh) and the prechecks.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ok, sandbox } from './helpers.mjs'

const CLI = 'bin/coordinator.mjs'

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' })
  return dir
}

/** Default Linear (team CORE) and Slack; api uses Jira, web the default. */
function perRepoBox(apiBlocks = { ticketing: { kind: 'jira', issueUrl: 'https://jira.test/browse/{id}' } }) {
  const box = sandbox()
  const ws = path.join(box.dir, 'ws')
  const api = gitRepo(path.join(ws, 'api'))
  const web = gitRepo(path.join(ws, 'web'))
  box.writeConfig({
    person: { name: 'Alex' },
    paths: { state: box.state, workspace: ws, orca: path.join(box.dir, 'fake', 'orca') },
    github: { org: 'acme' },
    adapters: {
      ticketing: { kind: 'linear', team: 'CORE', issueUrl: 'https://linear.test/{id}' },
      chat: { kind: 'slack', secretRef: 'env:SLACK_TOKEN', draftOnlyChannels: ['general'] }
    },
    repos: [{ name: 'api', path: api, ...apiBlocks }, { name: 'web', path: web }]
  })
  return { box, ws, api, web }
}

const wrapper = (box, kind, args, cwd, extraEnv = {}) => {
  const result = spawnSync(path.join(box.state, 'bin', kind), args, { encoding: 'utf8', env: { ...box.env, ...extraEnv }, cwd: cwd ?? box.dir })
  return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim() }
}

test('per-repo ticketing: a repo with its own block uses its tool (by --repo or by folder), the others the default, and nothing of the default leaks in', () => {
  const { box, api } = perRepoBox()
  const rendered = box.run(CLI, ['render'])
  assert.equal(rendered.status, 0, rendered.err)
  assert.equal(wrapper(box, 'ticketing', ['--repo', 'api', 'url', 'PROJ-1']).out, 'https://jira.test/browse/PROJ-1')
  assert.equal(wrapper(box, 'ticketing', ['--repo', 'web', 'url', 'CORE-1']).out, 'https://linear.test/CORE-1')
  assert.equal(wrapper(box, 'ticketing', ['url', 'CORE-2']).out, 'https://linear.test/CORE-2', 'outside any repo: the default')
  fs.mkdirSync(path.join(api, 'src'))
  assert.equal(wrapper(box, 'ticketing', ['url', 'PROJ-3'], path.join(api, 'src')).out, 'https://jira.test/browse/PROJ-3', 'inside api: api\'s tool without --repo')

  const resolved = JSON.parse(box.run(CLI, ['adapter', 'ticketing', '--repo', 'api']).out)
  assert.equal(resolved.kind, 'jira')
  assert.equal(resolved.team, '', 'the default\'s Linear team does not leak into a Jira repo')
  assert.ok(resolved.cmd.endsWith('/adapters/ticketing/jira.sh'))

  const unknown = wrapper(box, 'ticketing', ['--repo', 'apii', 'url', 'X-1'])
  assert.notEqual(unknown.status, 0, 'a mistyped repo never falls back to another project\'s tool')
  assert.match(unknown.err, /unknown repo: apii/)

  const panel = JSON.parse(fs.readFileSync(path.join(box.state, 'panel.json'), 'utf8'))
  assert.equal(panel.ticketUrl, 'https://linear.test/{id}')
  assert.deepEqual(panel.ticketUrls, { api: 'https://jira.test/browse/{id}' }, 'only repos that differ from the default')
})

test('per-repo chat: a repo block with the same tool merges over the default (credential kept, its own draft-only channels)', () => {
  const { box } = perRepoBox({ chat: { draftOnlyChannels: ['api-team'] } })
  const resolved = JSON.parse(box.run(CLI, ['adapter', 'chat', '--repo', 'api']).out)
  assert.equal(resolved.kind, 'slack')
  assert.equal(resolved.secretRef, 'env:SLACK_TOKEN')
  assert.deepEqual(resolved.draftOnlyChannels, ['api-team'])
  assert.equal(box.run(CLI, ['render']).status, 0)
  // slack.sh reads the resolved block through env.sh: api-team is draft-only for api only.
  const refused = wrapper(box, 'chat', ['--repo', 'api', 'post', 'api-team', 'hi', '--yes'], undefined, { SLACK_TOKEN: 'xoxb-test' })
  assert.equal(refused.status, 4)
  assert.match(refused.err, /draft-only/)
  assert.deepEqual(box.calls('curl'), [], 'nothing was sent')
})

test('a repository\'s own .orca-coordinator.yaml wins over its repos[] block', () => {
  const { box, api } = perRepoBox({ ticketing: { kind: 'jira', issueUrl: 'https://jira.test/browse/{id}' }, chat: { kind: 'slack' } })
  fs.writeFileSync(path.join(api, '.orca-coordinator.yaml'), 'adapters:\n  ticketing:\n    issueUrl: "https://jira.test/project/{id}"\n  chat:\n    kind: none\n')
  const ticketing = JSON.parse(box.run(CLI, ['adapter', 'ticketing', '--repo', 'api']).out)
  assert.deepEqual([ticketing.kind, ticketing.issueUrl], ['jira', 'https://jira.test/project/{id}'])
  assert.equal(JSON.parse(box.run(CLI, ['adapter', 'chat', '--repo', 'api']).out).kind, 'none')
  assert.equal(JSON.parse(box.run(CLI, ['adapter', 'ticketing', '--repo', 'web']).out).kind, 'linear', 'other repos are not affected')
})

test('config --merge: an unknown per-repo kind, or a repo tool without a ticket URL, is refused and nothing is written', () => {
  const { box, api } = perRepoBox()
  const before = fs.readFileSync(box.configPath, 'utf8')
  const trello = box.run(CLI, ['config', '--merge', JSON.stringify({ repos: [{ name: 'api', path: api, ticketing: { kind: 'trello' } }] })])
  assert.equal(trello.status, 2)
  assert.match(trello.err, /repos\[api\]\.ticketing\.kind must be one of linear\|jira\|github\|none/)
  const noUrl = box.run(CLI, ['config', '--merge', JSON.stringify({ adapters: { ticketing: { kind: 'none' } }, repos: [{ name: 'api', path: api, ticketing: { kind: 'jira' } }] })])
  assert.equal(noUrl.status, 2)
  assert.match(noUrl.err, /repos\[api\]\.ticketing\.issueUrl is empty/)
  const badShape = box.run(CLI, ['config', '--merge', JSON.stringify({ repos: [{ name: 'api', path: api, chat: { kind: 'slack', draftOnlyChannels: 'general' } }] })])
  assert.equal(badShape.status, 2)
  assert.match(badShape.err, /repos\[api\]\.chat\.draftOnlyChannels: expected array/)
  assert.equal(fs.readFileSync(box.configPath, 'utf8'), before)
})

test('prechecks/ticket-triage.sh: lists the tickets of every ticketing setup, the default and each repo\'s own', () => {
  const { box } = perRepoBox({ ticketing: { kind: 'github', issueUrl: 'https://github.com/acme/api/issues/{id}' } })
  box.fake('orca', [{ match: ['linear', 'list'], stdout: ok({ issues: [{ identifier: 'CORE-1', state: { name: 'Todo' } }, { identifier: 'CORE-2', state: { name: 'Done' } }] }) }])
  box.fake('gh', [{ match: ['search', 'issues'], stdout: JSON.stringify([{ number: 7, repository: { nameWithOwner: 'acme/api' }, labels: [{ name: 'Todo' }], state: 'open' }]) }])
  const out = box.run('prechecks/ticket-triage.sh')
  assert.equal(out.status, 0, out.err + out.out + JSON.stringify(box.calls()))
  assert.equal(out.out, 'untriaged: acme/api#7 CORE-1', 'both setups, CORE-2 (Done) left out')

  const failing = perRepoBox({ ticketing: { kind: 'github', issueUrl: 'https://github.com/acme/api/issues/{id}' } }).box
  failing.fake('orca', [{ match: ['linear', 'list'], stdout: ok({ issues: [] }) }])
  failing.fake('gh', [{ match: ['search', 'issues'], stdout: 'boom', status: 1 }])
  assert.equal(failing.run('prechecks/ticket-triage.sh').status, 4, 'a failing tool is an error, not "nothing new"')
})
