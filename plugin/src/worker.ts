// The plugin's own worker: reads board/board.json from the coordinator repo,
// pushes it to every open panel when it changes, and records decision clicks
// into inbox.jsonl so the coordinator agent can drain them with bin/board.mjs.
//
// Orca transpiles this file when it loads (no build step). A save restarts the
// worker and drops its in-memory state, so everything is re-derived in activate().
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Board, BoardSnapshot } from './protocol'

const DEFAULT_BOARD_PATH = '~/Workspace/orca-coordinator/board/board.json'
const DEBOUNCE_MS = 300
const POLL_MS = 4000

let boardPath = ''
let board: Board | null = null
let error = ''
let watcher: fs.FSWatcher | null = null
let poll: ReturnType<typeof setInterval> | null = null
let debounce: ReturnType<typeof setTimeout> | null = null
let lastMtime = 0
/** Resolves once the initial board read has run; every handler awaits it. */
let ready: Promise<void> = Promise.resolve()

function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
}

function readBoard(): void {
  try {
    board = JSON.parse(fs.readFileSync(boardPath, 'utf8')) as Board
    error = ''
  } catch (err) {
    board = null
    const code = (err as NodeJS.ErrnoException).code
    error =
      code === 'ENOENT'
        ? `board file not found: ${boardPath} (set the "Board file" setting, or create it with bin/board.mjs)`
        : `cannot read board: ${(err as Error).message}`
  }
}

function snapshot(): BoardSnapshot {
  return { board, error, boardPath }
}

function stopWatch(): void {
  if (debounce) clearTimeout(debounce)
  debounce = null
  if (poll) clearInterval(poll)
  poll = null
  try {
    watcher?.close()
  } catch {
    // already closed
  }
  watcher = null
}

function scheduleRefresh(orca: OrcaWorkerApi): void {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    readBoard()
    orca.panels.post('board.changed', snapshot())
  }, DEBOUNCE_MS)
  debounce.unref()
}

async function watch(orca: OrcaWorkerApi): Promise<void> {
  stopWatch()
  const configured = await orca.settings.get('boardPath')
  boardPath = expandHome(typeof configured === 'string' && configured ? configured : DEFAULT_BOARD_PATH)
  readBoard()
  try {
    lastMtime = fs.statSync(boardPath).mtimeMs
  } catch {
    lastMtime = 0
  }
  // Watch the folder: writers that atomically replace the file still fire here.
  try {
    const dir = path.dirname(boardPath)
    const name = path.basename(boardPath)
    watcher = fs.watch(dir, (_event, file) => {
      if (!file || file === name) scheduleRefresh(orca)
    })
  } catch {
    // No folder to watch yet; the poll below still picks the board up.
  }
  // Safety net for watchers that miss a change (network shares, some editors).
  poll = setInterval(() => {
    let mtime: number
    try {
      mtime = fs.statSync(boardPath).mtimeMs
    } catch {
      // The board vanished: refresh once so the panel shows why.
      if (board !== null) scheduleRefresh(orca)
      return
    }
    if (mtime !== lastMtime) {
      lastMtime = mtime
      scheduleRefresh(orca)
    }
  }, POLL_MS)
  // Never keep a process alive just for the poll or the watcher: in the real
  // worker Orca owns the lifetime; in tests and checks Node must be able to exit.
  poll.unref()
  watcher?.unref()
  if (debounce) debounce.unref()
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('board.get', async () => {
    await ready
    return snapshot()
  })

  orca.panels.handle('decision.respond', async ({ decisionId, optionId, note }) => {
    await ready
    const decision = board?.decisions?.find((d) => d.id === decisionId)
    const optionLabel = decision?.options?.find((o) => o.id === optionId)?.label ?? optionId
    const at = new Date().toISOString()
    const inbox = path.join(path.dirname(boardPath), 'inbox.jsonl')
    fs.mkdirSync(path.dirname(inbox), { recursive: true })
    fs.appendFileSync(
      inbox,
      JSON.stringify({ at, decisionId, optionId, optionLabel, note: note ?? '' }) + '\n'
    )
    return { ok: true, at, optionLabel }
  })

  orca.settings.onDidChange(({ key }) => {
    if (key === 'boardPath') ready = watch(orca)
  })

  ready = watch(orca)
}

export function deactivate(): void {
  stopWatch()
}
