// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import * as panel from './panel'
import type { Board, BoardSnapshot } from './protocol'
const board = JSON.parse(readFileSync(new URL('./fixtures/busy.json', import.meta.url), 'utf8')) as Board
const busySnapshot: BoardSnapshot = { board, error: '', boardPath: '/fixtures/busy.json' }
const emptySnapshot: BoardSnapshot = {
  board: JSON.parse(readFileSync(new URL('./fixtures/empty.json', import.meta.url), 'utf8')) as Board,
  error: '',
  boardPath: '/fixtures/empty.json'
}

test('shows the board: focus, decisions, repos, tasks, agents', async () => {
  const host = mockHost({
    requests: {
      'board.get': () => busySnapshot,
      'decision.respond': ({ decisionId, optionId }) => ({ ok: true, at: 'now', optionLabel: optionId })
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'Ship the coordinator panel' })?.text, 'Ship the coordinator panel')
  assert.ok(view.find({ label: 'jdflament/orca-coordinator' }), 'repos section renders')

  await view.press({ text: '★ Yes, enable it' })
  assert.equal(view.find({ text: 'Nothing waiting on you.' })?.text, 'Nothing waiting on you.', 'decision settles after the click')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('follows board pushes and live agents', async () => {
  const host = mockHost({ requests: { 'board.get': () => busySnapshot } })
  const view = await mount(panel, { host })

  await view.post('board.changed', emptySnapshot)
  assert.equal(view.find({ text: 'Nothing waiting on you.' })?.text, 'Nothing waiting on you.')

  await view.emit('agent.status.changed', {
    workspaceId: 'ws',
    paneKey: 'pane',
    terminalId: 'term_1',
    title: 'panel worker',
    state: 'working',
    receivedAt: Date.now()
  })
  await view.settled()
  assert.ok(view.find({ label: 'panel worker' }), 'live Orca agents appear')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
