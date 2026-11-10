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

test('shows the board: instructions, decisions, repos, task history, agents', async () => {
  const sent: unknown[] = []
  let jumps = 0
  const host = mockHost({
    requests: {
      'board.get': () => busySnapshot,
      'decision.respond': () => ({ ok: true, at: 'now', optionLabel: 'Yes, enable it' }),
      'command.send': (input) => {
        sent.push(input)
        return { ok: true, at: 'now' }
      },
      'coordinator.visible': () => ({ ok: true, visible: false }),
      'coordinator.focus': () => {
        jumps += 1
        return { ok: true, terminal: 'term_coordinator', title: 'coordinator' }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'Ship the coordinator panel' })?.text, 'Ship the coordinator panel')
  assert.ok(view.find({ label: 'Keep the panel concise — buttons only, no filler' }), 'standing instructions render')
  assert.ok(!view.find({ label: 'Public, reusable, agent-agnostic repo' }), 'done instructions drop away')
  assert.ok(view.find({ label: 'Active' }) && view.find({ label: 'Queued' }), 'task stats render')
  assert.ok(view.find({ text: '1 working' }), 'agents heading carries the working count')
  assert.ok(view.find({ label: 'jdflament/orca-coordinator' }), 'repos section renders')
  assert.ok(view.find({ label: 'Done (3)' }), 'done tasks collapse behind a count')

  await view.press({ text: '★ Yes, enable it' })
  assert.ok(!view.find({ text: 'Needs you' }), 'decision settles after the click')

  await view.press({ text: 'Jump to coordinator' })
  assert.equal(jumps, 1, 'the jump button asks the worker to focus the coordinator')

  await view.press({ label: 'Nudge t3' })
  await view.press({ label: 'Stop coordinator' })
  assert.deepEqual(sent, [
    { command: 'nudge', target: 't3' },
    { command: 'stop', target: 'coordinator' }
  ])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('follows board pushes, live agents, and hides the jump button on the coordinator tab', async () => {
  const host = mockHost({
    requests: {
      'board.get': () => busySnapshot,
      'coordinator.visible': () => ({ ok: true, visible: true })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(!view.find({ text: 'Jump to coordinator' }), 'no jump button while on the coordinator tab')

  await view.post('board.changed', emptySnapshot)
  assert.ok(!view.find({ text: 'Needs you' }), 'empty board needs nothing')
  assert.ok(!view.find({ label: 'Active' }), 'stats hidden when nothing runs')

  // Same empty board plus one standing instruction — still idle, so it stays hidden.
  const idleWithInstruction: BoardSnapshot = {
    ...emptySnapshot,
    board: {
      ...emptySnapshot.board!,
      instructions: [{ id: 'i9', text: 'Standing rule', to: 'coordinator', status: 'active' }]
    }
  }
  await view.post('board.changed', idleWithInstruction)
  assert.ok(!view.find({ label: 'Standing rule' }), 'instructions hidden when idle')

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
  assert.ok(view.find({ text: '1 working' }), 'working count appears with the agents')
  assert.ok(!view.find({ label: 'Active' }), 'stats stay hidden without open tasks')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
