// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
// The worker reads a real board file: point the mocked setting at a temp copy.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'

test('reads the board, records decision clicks in the inbox, and pushes changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coordinator-'))
  const boardPath = join(dir, 'board.json')
  writeFileSync(
    boardPath,
    JSON.stringify({
      version: 1,
      focus: 'test focus',
      updatedAt: new Date().toISOString(),
      decisions: [
        { id: 'd1', title: 'Ship it?', options: [{ id: 'o1', label: 'Yes' }], status: 'pending' }
      ]
    })
  )

  const host = mockHost({ settings: { boardPath } })
  const worker = await mountWorker(main, { host })

  const first = await worker.request('board.get')
  assert.equal(first.board?.focus, 'test focus')
  assert.equal(first.error, '')

  const click = await worker.request('decision.respond', { decisionId: 'd1', optionId: 'o1' })
  assert.equal(click.ok, true)
  const inbox = readFileSync(join(dir, 'inbox.jsonl'), 'utf8').trim()
  assert.deepEqual(JSON.parse(inbox), {
    at: click.at,
    decisionId: 'd1',
    optionId: 'o1',
    optionLabel: 'Yes',
    note: ''
  })

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
