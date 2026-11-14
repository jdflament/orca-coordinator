import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

// The panel's DOM-free helpers (between <pure> markers) are run as shipped, no copy.
const html = fs.readFileSync(new URL('../plugin/panel/index.html', import.meta.url), 'utf8')
const pure = html.match(/\/\/ <pure>[\s\S]*?\/\/ <\/pure>/)?.[0]
assert.ok(pure, 'panel has a <pure> block')
const { planWork, groupByRepo, canOpen, featureOpen, featureCounts, loadFolds, saveFolds } = vm.runInNewContext(`${pure}\n;({ planWork, groupByRepo, canOpen, featureOpen, featureCounts, loadFolds, saveFolds })`)
const plain = (value) => JSON.parse(JSON.stringify(value))

const task = (id, repo, ws = 'W1', extra = {}) => ({ id, ws, repo, status: 'working', ...extra })

test('planWork: many items of one workstream in one repo make one group and no row carries a repo tag', () => {
  const board = { workstreams: [{ id: 'W1' }], tasks: ['A', 'B', 'C'].map((id) => task(id, 'api')) }
  const plan = plain(planWork(board))
  assert.equal(plan.length, 1)
  assert.equal(plan[0].repo, 'api')
  assert.deepEqual(plan[0].streams[0].items.map((i) => i.tag), [false, false, false])
})

test('planWork: a workstream spanning repos sits in its main repo and tags only the rows from another repo', () => {
  const board = { workstreams: [{ id: 'W1' }], tasks: [task('A', 'api'), task('B', 'web'), task('C', 'api')], repos: [{ id: 'P', name: '#9', repo: 'web', ws: 'W1', status: 'hold' }] }
  const plan = plain(planWork(board))
  assert.deepEqual(plan.map((g) => g.repo), ['api'])
  assert.deepEqual(plan[0].streams[0].items.map((i) => [i.item.id, i.tag]), [['A', false], ['B', true], ['C', false], ['P', true]])
})

test('planWork: local changes join their repo group, a repo with only local changes still gets one, workstreams without a repo come first without header', () => {
  const board = {
    workstreams: [{ id: 'W1' }, { id: 'EMPTY' }],
    tasks: [task('A', 'api')],
    localWork: [{ repo: 'api', branch: 'x', changed: 2 }, { repo: 'web', branch: 'main', changed: 1 }]
  }
  const plan = plain(planWork(board))
  assert.deepEqual(plan.map((g) => g.repo), ['', 'api', 'web'])
  assert.equal(plan[1].local.changed, 2)
  assert.equal(plan[2].streams.length, 0)
})

test('groupByRepo: one header per repo with enough entries, a lone repo stays inline with its tag, no repo = no tag', () => {
  const groups = plain(groupByRepo([{ repo: 'api' }, { repo: 'web' }, { repo: 'api' }, {}], 2))
  assert.deepEqual(groups.map((g) => [g.repo, g.entries.length, g.tag ?? null]), [['api', 2, null], ['', 1, true], ['', 1, false]])
})

test('canOpen: only a non-empty url string is clickable', () => {
  assert.equal(canOpen('https://example.test/x'), true)
  for (const url of ['', undefined, null, 42]) assert.equal(canOpen(url), false)
})

test('panel: only elements that do something get the pointer (.go); links and rows without url or action stay plain', () => {
  assert.match(html, /a\.go:hover \{ text-decoration: underline/)
  assert.doesNotMatch(html, /\n\s*a:hover \{/, 'no hover underline on every anchor')
  assert.doesNotMatch(html, /\.row:hover, \.wk:hover, \.wrow:hover/, 'no hover background on every row')
  assert.match(html, /if \(!canOpen\(url\)\) return node/, 'link() without a url returns plain text')
})

const entry = (status) => ({ item: { status }, tag: false })
const memoryStorage = (initial) => {
  const data = new Map(initial === undefined ? [] : [['coordinator.features', initial]])
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
}

test('featureOpen: closed by default, open when an item is blocked or needs input', () => {
  assert.equal(featureOpen({}, 'W1', [entry('working'), entry('pr')]), false)
  assert.equal(featureOpen({}, 'W1', [entry('working'), entry('blocked')]), true)
  assert.equal(featureOpen({}, 'W1', [entry('needs-input')]), true)
  assert.equal(featureOpen({}, 'W1', []), false)
})

test('featureOpen: the viewer\'s remembered choice wins over the default, both ways', () => {
  assert.equal(featureOpen({ W1: false }, 'W1', [entry('blocked')]), false)
  assert.equal(featureOpen({ W1: true }, 'W1', [entry('working')]), true)
  assert.equal(featureOpen({ W1: 'yes' }, 'W1', [entry('working')]), false, 'a non-boolean value is ignored')
})

test('folds are saved and read back per feature, other keys kept', () => {
  const storage = memoryStorage()
  saveFolds(storage, { W1: true, W2: false })
  assert.deepEqual(plain(loadFolds(storage)), { W1: true, W2: false })
})

test('folds: no storage, throwing storage or garbage in it still work (nothing remembered)', () => {
  assert.deepEqual(plain(loadFolds(null)), {})
  const throwing = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('full') } }
  assert.deepEqual(plain(loadFolds(throwing)), {})
  assert.doesNotThrow(() => saveFolds(throwing, { W1: true }))
  assert.doesNotThrow(() => saveFolds(null, { W1: true }))
  for (const garbage of ['not json', '[1,2]', '"x"', 'null']) assert.deepEqual(plain(loadFolds(memoryStorage(garbage))), {})
})

test('featureCounts: open, blocked and needs-input; done items are not open', () => {
  assert.equal(featureCounts([entry('working'), entry('blocked'), entry('merged'), entry('pr'), entry('needs-input')]), '4 open · 1 blocked · 1 needs input')
  assert.equal(featureCounts([entry('merged'), entry('done')]), '')
})
