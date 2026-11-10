// The plugin's own worker: reads board/board.json from the coordinator repo,
// pushes it to every open panel when it changes, and records decision clicks
// into inbox.jsonl so the coordinator agent can drain them with bin/board.mjs.
//
// Orca transpiles this file when it loads (no build step). A save restarts the
// worker and drops its in-memory state, so everything is re-derived in activate().
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Board, BoardSnapshot } from './protocol'

const DEFAULT_BOARD_PATH = '~/Workspace/orca-coordinator/board/board.json'
const DEFAULT_COORDINATOR_TERMINAL = 'coordinator'
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

interface TerminalInfo {
  handle: string
  title?: string
  tabId?: string
}

interface VisualLayout {
  root?: { activeTabId?: string }
}

/** The Orca CLI that ships with the app; the worker may not inherit PATH. */
function orcaCli(): string {
  const dir = process.env.ORCA_CLI_BIN_DIR
  if (dir) return path.join(dir, 'orca')
  return process.platform === 'darwin' ? '/Applications/Orca.app/Contents/Resources/bin/orca' : 'orca'
}

function runOrca(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(orcaCli(), args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

/** One CLI call: the flat terminal list plus each worktree's visual layout. */
async function listTerminals(): Promise<{ terminals: TerminalInfo[]; layouts: VisualLayout[] }> {
  const parsed = JSON.parse(
    await runOrca(['terminal', 'list', '--include-visual-layouts', '--json'])
  ) as {
    result?: { terminals?: TerminalInfo[]; visualLayouts?: VisualLayout[] }
  }
  return { terminals: parsed.result?.terminals ?? [], layouts: parsed.result?.visualLayouts ?? [] }
}

async function switchTerminal(handle: string): Promise<void> {
  const parsed = JSON.parse(await runOrca(['terminal', 'switch', '--terminal', handle, '--json'])) as {
    ok?: boolean
    error?: { message?: string }
  }
  if (parsed.ok === false) throw new Error(parsed.error?.message ?? `could not switch to ${handle}`)
}

/** Exact handle first, then a case-insensitive title substring. */
export function pickTerminal(terminals: TerminalInfo[], preferred: string): TerminalInfo | null {
  const wanted = preferred.trim()
  const byHandle = terminals.find((t) => t.handle === wanted)
  if (byHandle) return byHandle
  const needle = (wanted || DEFAULT_COORDINATOR_TERMINAL).toLowerCase()
  return terminals.find((t) => (t.title ?? '').toLowerCase().includes(needle)) ?? null
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

/** Appends one entry to inbox.jsonl; the coordinator drains it with bin/board.mjs. */
function appendInbox(entry: Record<string, unknown>): { at: string } {
  const at = new Date().toISOString()
  const inbox = path.join(path.dirname(boardPath), 'inbox.jsonl')
  fs.mkdirSync(path.dirname(inbox), { recursive: true })
  fs.appendFileSync(inbox, JSON.stringify({ at, ...entry }) + '\n')
  return { at }
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
    const { at } = appendInbox({ kind: 'decision', decisionId, optionId, optionLabel, note: note ?? '' })
    return { ok: true, at, optionLabel }
  })

  orca.panels.handle('command.send', async ({ command, target }) => {
    await ready
    const { at } = appendInbox({ kind: 'command', command, target })
    return { ok: true, at }
  })

  // Focus the coordinator terminal: a term_ handle is used as-is, otherwise
  // the configured title substring is matched against Orca's terminal list.
  orca.panels.handle('coordinator.focus', async ({ terminal }) => {
    await ready
    try {
      const configured = terminal ?? (await orca.settings.get('coordinatorTerminal'))
      const preferred =
        typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_COORDINATOR_TERMINAL
      const { terminals } = await listTerminals()
      const target = preferred.startsWith('term_')
        ? { handle: preferred, title: terminals.find((t) => t.handle === preferred)?.title }
        : pickTerminal(terminals, preferred)
      if (!target) {
        return {
          ok: false,
          error: `no terminal matching "${preferred}" — set "Coordinator terminal" to its title or term_ handle`
        }
      }
      await switchTerminal(target.handle)
      return { ok: true, terminal: target.handle, title: target.title }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Is the coordinator's terminal the tab the user is looking at right now?
  // The panel hides its jump button while it is. Fails open (false = show the
  // button) whenever anything cannot be resolved.
  orca.panels.handle('coordinator.visible', async () => {
    await ready
    try {
      const configured = await orca.settings.get('coordinatorTerminal')
      const preferred =
        typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_COORDINATOR_TERMINAL
      const { terminals, layouts } = await listTerminals()
      const target = pickTerminal(terminals, preferred)
      if (!target?.tabId) return { ok: true, visible: false }
      // readContext says which workspace is focused; the coordinator only
      // counts as "on screen" when its workspace is the focused one.
      let context: { terminals?: { id: string }[] } | null = null
      try {
        context = await orca.host.call('workspace.readContext')
      } catch {
        context = null
      }
      const focused = context?.terminals ?? []
      const inFocusedWorkspace = focused.length === 0 || focused.some((t) => t.id === target.handle)
      const tabActive = layouts.some((layout) => layout.root?.activeTabId === target.tabId)
      return { ok: true, visible: inFocusedWorkspace && tabActive }
    } catch {
      return { ok: true, visible: false }
    }
  })

  orca.settings.onDidChange(({ key }) => {
    if (key === 'boardPath') ready = watch(orca)
  })

  ready = watch(orca)
}

export function deactivate(): void {
  stopWatch()
}
