// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
// The worker reads a real board file: point the mocked setting at a temp copy.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

  const command = await worker.request('command.send', { command: 'nudge', target: 't3' })
  assert.equal(command.ok, true)

  const lines = readFileSync(join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.deepEqual(
    { ...lines[0], at: click.at },
    { at: click.at, kind: 'decision', decisionId: 'd1', optionId: 'o1', optionLabel: 'Yes', note: '' }
  )
  assert.deepEqual({ ...lines[1], at: command.at }, { at: command.at, kind: 'command', command: 'nudge', target: 't3' })

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('picks the coordinator terminal by handle or title', () => {
  const terminals = [
    { handle: 'term_readme', title: 'OC | Clean GitHub profile README' },
    { handle: 'term_coordinator', title: 'OC | Orca coordinator agent setup' }
  ]

  assert.equal(main.pickTerminal(terminals, 'coordinator')?.handle, 'term_coordinator')
  assert.equal(main.pickTerminal(terminals, 'term_readme')?.handle, 'term_readme')
  assert.equal(main.pickTerminal(terminals, '')?.handle, 'term_coordinator', 'empty setting falls back to "coordinator"')
  assert.equal(main.pickTerminal([{ handle: 'term_other', title: 'shell' }], 'missing'), null)
})

test('knows whether the coordinator tab is the one on screen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coordinator-cli-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const script = join(bin, 'orca')
  const boardPath = join(dir, 'board.json')
  writeFileSync(boardPath, JSON.stringify({ version: 1 }))

  // A fake Orca CLI: prints one terminal (the coordinator, tab B) and a layout
  // whose active tab we rewrite between the two requests.
  const writeCli = (activeTabId: string): void => {
    writeFileSync(
      script,
      `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({
        ok: true,
        result: {
          terminals: [{ handle: 'term_coord', title: 'OC | Coordinator', tabId: 'tabB' }],
          visualLayouts: [{ root: { activeTabId } }]
        }
      })}\nJSON\n`
    )
    chmodSync(script, 0o755)
  }

  const previous = process.env.ORCA_CLI_BIN_DIR
  process.env.ORCA_CLI_BIN_DIR = bin
  try {
    const host = mockHost({
      settings: { boardPath, coordinatorTerminal: 'Coordinator' },
      results: {
        'workspace.readContext': {
          branch: 'main',
          displayName: 'ws',
          terminals: [{ id: 'term_coord', title: 'OC | Coordinator' }]
        }
      }
    })
    const worker = await mountWorker(main, { host })

    writeCli('tabB')
    assert.deepEqual(await worker.request('coordinator.visible'), { ok: true, visible: true }, 'on the coordinator tab')

    writeCli('tabA')
    assert.deepEqual(await worker.request('coordinator.visible'), { ok: true, visible: false }, 'another tab is on screen')

    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    if (previous === undefined) delete process.env.ORCA_CLI_BIN_DIR
    else process.env.ORCA_CLI_BIN_DIR = previous
  }
})
