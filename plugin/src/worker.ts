// The plugin's worker: reads board.json from the coordinator state folder, adds the live
// Orca workers and the coordinator's liveness, and forwards panel clicks to the coordinator
// terminal (or queues them in inbox.jsonl when no coordinator is live). Before the coordinator
// is set up, it offers the setup instead (see setup.ts).
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Board, BoardView, CleanupResult, CoordinatorSettings, LiveWorker, LocalWork } from './protocol'
import { configFile, expandHome, getSetupStatus, listOrcaRepos, readConfig, readSettings, removeSkippedRepo, runSetup, saveSettings, updateIfInstalledHere } from './setup'
import { linkHost } from './links'

const DEFAULT_DIR = '~/.local/state/orca-coordinator'
const FINISHED_STATES = ['succeeded', 'failed', 'stopped']

let settings: { get(key: string): Promise<unknown> } | null = null
let host: OrcaWorkerApi['host'] | null = null

async function stateDir(): Promise<string> {
  const configured = await settings?.get('coordinatorDir')
  return expandHome(typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_DIR)
}

/** The Orca CLI: the setting, else $ORCA_CLI_BIN_DIR, else the app's bundled CLI on macOS, else PATH. */
async function orcaCli(): Promise<string> {
  const configured = await settings?.get('orcaBin')
  if (typeof configured === 'string' && configured.trim()) return expandHome(configured.trim())
  if (process.env.ORCA_CLI_BIN_DIR) return path.join(process.env.ORCA_CLI_BIN_DIR, 'orca')
  return process.platform === 'darwin' ? '/Applications/Orca.app/Contents/Resources/bin/orca' : 'orca'
}

async function runOrca(args: string[], timeout = 10000): Promise<string> {
  const cli = await orcaCli()
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  })
}

async function runOrcaJson(args: string[]): Promise<{ result?: Record<string, unknown> }> {
  return JSON.parse(await runOrca([...args, '--json'])) as { result?: Record<string, unknown> }
}

async function getCoordinatorHandle(): Promise<string> {
  return (await readFile(path.join(await stateDir(), 'coordinator-terminal'), 'utf8')).trim()
}

async function getTerminalTitles(): Promise<Map<string, string>> {
  const response = await runOrcaJson(['terminal', 'list'])
  const terminals = (response.result?.terminals ?? []) as { handle?: string; title?: string }[]
  return new Map(terminals.map((terminal) => [String(terminal.handle), String(terminal.title ?? '')]))
}

async function getTaskTitles(): Promise<Map<string, string>> {
  const response = await runOrcaJson(['orchestration', 'task-list'])
  const tasks = (response.result?.tasks ?? []) as { id?: string; title?: string; spec?: string }[]
  return new Map(tasks.map((task) => [String(task.id), String(task.title ?? task.spec ?? '').split('\n')[0]]))
}

function getWorkerStatus(state: string, outcome: string, needsInput: boolean): LiveWorker['status'] {
  if (needsInput) return 'needs input'
  return state === 'running' || outcome === 'in_progress' ? 'working' : 'idle'
}

type OrcaWorker = Record<string, string | null>

/** Every worker Orca still lists (finished ones included), with a title from its task, else its terminal. */
async function listWorkers(): Promise<{ workers: OrcaWorker[]; titleOf: (worker: OrcaWorker) => string }> {
  const [response, terminalTitles, taskTitles] = await Promise.all([
    runOrcaJson(['orchestration', 'worker-list']),
    getTerminalTitles().catch(() => new Map<string, string>()),
    getTaskTitles().catch(() => new Map<string, string>())
  ])
  const workers = (response.result?.workers ?? []) as OrcaWorker[]
  await writeWorkerTerminals(workers).catch(() => undefined)
  const titleOf = (worker: OrcaWorker): string => taskTitles.get(String(worker.taskId)) || terminalTitles.get(String(worker.terminal)) || String(worker.taskId ?? 'worker')
  return { workers, titleOf }
}

/**
 * The terminals Orca dispatched workers to, one handle per line in <state>/worker-terminals:
 * bin/statusline.sh reads it for the WORKER badge (it never reads Orca's files).
 */
async function writeWorkerTerminals(workers: OrcaWorker[]): Promise<void> {
  const file = path.join(await stateDir(), 'worker-terminals')
  const handles = [...new Set(workers.map((worker) => worker.terminal).filter((handle): handle is string => /^[A-Za-z0-9_-]+$/.test(handle ?? '')))]
  const text = handles.map((handle) => handle + '\n').join('')
  if ((await readFile(file, 'utf8').catch(() => null)) !== text) await writeFile(file, text)
}

function getActiveWorkers({ workers, titleOf }: Awaited<ReturnType<typeof listWorkers>>): LiveWorker[] {
  return workers
    .filter((worker) => !FINISHED_STATES.includes(String(worker.state)))
    .map((worker) => {
      const state = String(worker.state)
      const outcome = String(worker.outcome ?? '')
      const needsInput = /input|blocked|question|escalat/i.test(`${state} ${outcome}`)
      return {
        dispatchId: String(worker.dispatchId),
        title: titleOf(worker),
        status: getWorkerStatus(state, outcome, needsInput),
        terminal: worker.terminal ?? null,
        needsInput
      }
    })
}

// ---- local work derived from the configured repos' git state ----

const GIT_TIMEOUT_MS = 3000
let configCache: { mtimeMs: number; config: CoordinatorSettings | null } | null = null

/** The config, re-read only when config.yaml changes (reading it runs node). */
async function getConfig(): Promise<CoordinatorSettings | null> {
  const mtimeMs = await stat(configFile()).then((s) => s.mtimeMs).catch(() => -1)
  if (mtimeMs < 0) return null
  if (configCache?.mtimeMs !== mtimeMs) configCache = { mtimeMs, config: await readConfig() }
  return configCache.config
}

/** Read-only git, short timeout; rejects on any failure. */
function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout))
    )
  })
}

/** Changed files and commits not pushed (vs the upstream, else vs every remote); null when it is not a readable git repo. */
async function getLocalWork(repo: { name: string; path: string }): Promise<LocalWork | null> {
  try {
    const [status, branch] = await Promise.all([git(repo.path, ['status', '--porcelain']), git(repo.path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => 'HEAD')])
    const unpushed = await git(repo.path, ['rev-list', '--count', '@{upstream}..HEAD'])
      .catch(() => git(repo.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']))
      .then((count) => Number.parseInt(count, 10) || 0)
      .catch(() => 0)
    const changed = status.split('\n').filter((line) => line.trim()).length
    return changed || unpushed ? { repo: repo.name, branch: branch.trim() || 'HEAD', changed, unpushed } : null
  } catch {
    return null
  }
}

/** A board task covers a derived row when it is in the same repo and on that branch (its branch field, else its id in the branch name). */
function isCoveredByTask(board: Board, work: LocalWork): boolean {
  const branch = work.branch.toLowerCase()
  return (board.tasks ?? []).some((task) => task.repo === work.repo && (task.branch ? task.branch.toLowerCase() === branch : branch.includes(String(task.id).toLowerCase())))
}

/** Local git work per configured repo (Orca's workers are in Agents, not repeated in Work). config.repos holds git repositories only: readConfig drops any other entry. */
async function getDerivedWork(board: Board): Promise<{ localWork: LocalWork[] }> {
  const config = await getConfig().catch(() => null)
  if (!config) return { localWork: [] }
  const repos = (config.repos ?? []).filter((repo) => repo.name && repo.path)
  const local = await Promise.all(repos.map((repo) => getLocalWork(repo)))
  return { localWork: local.filter((work): work is LocalWork => work !== null && !isCoveredByTask(board, work)) }
}

/**
 * Live = the terminal is connected, not orphaned, and an agent runs in it (as route.sh checks).
 * A connected terminal without an agent is a bare shell: typed text would run as a command.
 */
async function getIsCoordinatorLive(handle: string): Promise<boolean> {
  const response = await runOrcaJson(['terminal', 'show', '--terminal', handle])
  const terminal = response.result?.terminal as { connected?: boolean; orphaned?: boolean; agentIdentity?: string | null } | undefined
  return terminal?.connected === true && terminal.orphaned !== true && Boolean(terminal.agentIdentity)
}

/**
 * A board agent and a live worker can be the same work: the coordinator recorded it under the
 * dispatch id, or under another id with the worker's title as name. Match by id, then by name;
 * the live row keeps the board's repo and detail, the board agent is not shown again.
 */
function mergeBoardAgents(workers: LiveWorker[], agents: NonNullable<Board['agents']>): { workers: LiveWorker[]; agents: NonNullable<Board['agents']> } {
  const used = new Set<number>()
  const pick = (match: (agent: NonNullable<Board['agents']>[number]) => boolean): NonNullable<Board['agents']>[number] | undefined => {
    const index = agents.findIndex((agent, i) => !used.has(i) && match(agent))
    if (index === -1) return undefined
    used.add(index)
    return agents[index]
  }
  const byId = workers.map((worker) => pick((agent) => Boolean(agent.id) && String(agent.id) === worker.dispatchId))
  const merged = workers.map((worker, i) => {
    const agent = byId[i] ?? pick((agent) => agent.name.trim() !== '' && agent.name.trim() === worker.title.trim())
    return agent ? { ...worker, ...(agent.repo ? { repo: agent.repo } : {}), ...(agent.detail ? { detail: agent.detail } : {}) } : worker
  })
  return { workers: merged, agents: agents.filter((_, i) => !used.has(i)) }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  return readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as T)
    .catch(() => fallback)
}

type PanelJson = { repoColors?: Record<string, string>; oncallLabel?: string }

/** Each item keeps its own url (written by the coordinator); a known host adds an icon and a label. */
function withLinkHosts<T extends { url?: string }>(items: T[] | undefined): T[] | undefined {
  return items?.map((item) => {
    const host = linkHost(item.url)
    return host ? { ...item, linkHost: host } : item
  })
}

const RECONCILE_EVERY_MS = 60000
const RECONCILE_TIMEOUT_MS = 10000
let lastReconcile = 0

/**
 * Settles decisions whose "settles when" is met (`bin/board reconcile`: gh, no model). At most once
 * a minute, short timeout, never awaited by the render; a failure is logged, never shown.
 */
function reconcileDecisions(dir: string): void {
  const nowMs = Date.now()
  if (nowMs - lastReconcile < RECONCILE_EVERY_MS) return
  lastReconcile = nowMs
  execFile(path.join(dir, 'bin', 'board'), ['reconcile'], { timeout: RECONCILE_TIMEOUT_MS }, (error, _stdout, stderr) => {
    if (error || String(stderr).trim()) console.error(`coordinator: reconcile: ${String(stderr).trim() || error?.message}`)
  })
}

/** Marks what is new to this panel session: `seen` is what it already showed; no `seen` (the first load) marks nothing. */
function markNew(view: BoardView, seen: string[] | undefined): void {
  if (!seen) return
  const known = new Set(seen)
  for (const decision of view.decisions ?? []) if (decision.status !== 'answered' && !known.has(`d:${decision.id}`)) decision.isNew = true
  for (const worker of view.workers) if (worker.needsInput && !known.has(`w:${worker.dispatchId}`)) worker.isNew = true
}

async function getBoard(seen?: string[]): Promise<BoardView> {
  const dir = await stateDir()
  reconcileDecisions(dir)
  const board = await readJson<Board>(path.join(dir, 'board.json'), { version: 2 })
  const read = await readJson<PanelJson>(path.join(dir, 'panel.json'), {})
  const panel: PanelJson = read && typeof read === 'object' ? read : {}
  const handle = await getCoordinatorHandle().catch(() => '')
  const [list, coordinatorLive] = await Promise.all([listWorkers().catch(() => null), handle ? getIsCoordinatorLive(handle).catch(() => false) : Promise.resolve(false)])
  const derived = await getDerivedWork(board).catch(() => ({ localWork: [] }))
  const { workers, agents } = mergeBoardAgents(list ? getActiveWorkers(list) : [], board.agents ?? [])
  const view: BoardView = {
    ...board,
    decisions: withLinkHosts(board.decisions),
    workstreams: withLinkHosts(board.workstreams),
    tasks: withLinkHosts(board.tasks),
    repos: withLinkHosts(board.repos),
    agents,
    workers,
    ...derived,
    coordinatorLive,
    repoColors: panel.repoColors ?? {},
    oncallLabel: panel.oncallLabel ?? 'oncall'
  }
  markNew(view, seen)
  return view
}

/** Runs <dir>/bin/cleanup (with -n: a dry run that changes nothing) and reads its summary line. */
function runCleanup(dir: string, dryRun: boolean): Promise<CleanupResult> {
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', [path.join(dir, 'bin', 'cleanup'), ...(dryRun ? ['-n'] : [])], { timeout: 300000 }, (error, stdout) => {
      if (error) return reject(error)
      const lines = String(stdout).trim().split('\n').filter(Boolean)
      const summary = lines.at(-1) ?? ''
      const counts = summary.match(/released (\d+) sessions, removed (\d+) worktrees, kept (\d+)/)
      resolve({
        summary,
        actions: lines.slice(0, -1),
        dryRun,
        ...(counts ? { counts: { released: Number(counts[1]), removed: Number(counts[2]), kept: Number(counts[3]) } } : {})
      })
    })
  })
}

/** "<option> <decision>" is a decision click only when the board has that pending decision with that option. */
function isDecisionClick(board: Board, optionId: string, decisionId: string): boolean {
  const decision = (board.decisions ?? []).find((d) => String(d.id) === decisionId && d.status !== 'answered')
  return (decision?.options ?? []).some((option) => String(typeof option === 'object' && option !== null ? (option.id ?? option.label) : option) === optionId)
}

async function queueInbox(dir: string, text: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const [command, ...rest] = text.trim().split(/\s+/)
  const board = rest.length === 1 ? await readJson<Board>(path.join(dir, 'board.json'), { version: 2 }) : null
  const entry = /^(nudge|stop)$/.test(command)
    ? { at: new Date().toISOString(), kind: 'command', command, target: rest.join(' ') }
    : board && isDecisionClick(board, command, rest[0])
      ? { at: new Date().toISOString(), kind: 'decision', decisionId: rest[0], optionId: command }
      : { at: new Date().toISOString(), kind: 'message', text }
  appendFileSync(path.join(dir, 'inbox.jsonl'), JSON.stringify(entry) + '\n')
}

/** Opens the configured coordinator agent in a terminal of the configured workspace. */
async function startCoordinator(): Promise<{ started: boolean; output: string }> {
  const config = await readConfig()
  if (!config) return { started: false, output: 'The coordinator is not set up yet.' }
  const prompt = 'Load the coordinator skill and start a coordinator session.'
  const args = ['agent', 'launch', '--agent', config.agents.coordinator.agent, '--worktree', `path:${config.paths.workspace}`, '--prompt', prompt, '--surface', 'terminal', '--focus', '--json']
  try {
    await runOrca(args, 60000)
    return { started: true, output: '' }
  } catch (error) {
    return { started: false, output: (error as Error).message }
  }
}

// ---- links to Orca's own views (the panel does not re-show what Orca has) ----

async function openRepoChanges(name: string): Promise<{ opened: boolean; via: 'source-control' | 'cli' }> {
  const repo = ((await getConfig())?.repos ?? []).find((r) => r.name === name && r.path)
  if (!repo) throw Object.assign(new Error(`unknown repo: ${name}`), { code: 'invalid_params' })
  const orcaRepo = (await listOrcaRepos(runOrca, host).catch(() => [])).find((r) => r.id && path.resolve(r.path) === path.resolve(repo.path))
  if (orcaRepo && host) {
    try {
      await host.call('workspace.open', { workspaceId: `${orcaRepo.id}::${orcaRepo.path}` })
      await host.call('commands.run', { action: 'sidebar.sourceControl.toggle' })
      return { opened: true, via: 'source-control' }
    } catch {
      // refused (no workspace:write) or not the desktop app: the CLI diff below
    }
  }
  await runOrca(['file', 'open-changed', '--mode', 'diff', '--worktree', `path:${repo.path}`, '--focus'], 15000)
  return { opened: true, via: 'cli' }
}

async function openWorkspaceBoard(): Promise<{ opened: boolean; error?: string }> {
  try {
    if (!host) throw new Error('no host')
    await host.call('commands.run', { action: 'workspace.openBoard' })
    return { opened: true }
  } catch (error) {
    return { opened: false, error: (error as Error).message }
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  settings = orca.settings
  host = orca.host
  // Orca installed a new version of the plugin: bring the coordinator package up to date with it.
  void updateIfInstalledHere().catch(() => undefined)

  orca.panels.handle('setup.status', () => getSetupStatus(runOrca, host))
  orca.panels.handle('setup.run', (options) => runSetup(options ?? { workspace: '' }))
  orca.panels.handle('setup.start', () => startCoordinator())
  orca.panels.handle('config.read', () => readSettings(runOrca, host))
  orca.panels.handle('config.save', ({ patch }) => saveSettings(patch))
  orca.panels.handle('config.removeRepo', ({ path: target }) => removeSkippedRepo(String(target ?? '')))

  orca.panels.handle('board.get', (input) => getBoard(Array.isArray(input?.seen) ? input.seen.map(String) : undefined))
  orca.panels.handle('work.openChanges', ({ repo }) => openRepoChanges(String(repo ?? '')))
  orca.panels.handle('agents.openBoard', () => openWorkspaceBoard())

  orca.panels.handle('board.send', async ({ text }) => {
    if (typeof text !== 'string' || text.trim() === '') throw Object.assign(new Error('empty text'), { code: 'invalid_params' })
    const dir = await stateDir()
    const handle = await getCoordinatorHandle().catch(() => '')
    const live = handle ? await getIsCoordinatorLive(handle).catch(() => false) : false
    if (!live) {
      await queueInbox(dir, text)
      return { sent: false, queued: true }
    }
    await runOrca(['terminal', 'send', '--terminal', handle, '--text', text])
    await runOrca(['terminal', 'send', '--terminal', handle, '--text', '', '--enter'])
    return { sent: true, queued: false }
  })

  orca.panels.handle('board.cleanup', async (input) => runCleanup(await stateDir(), input?.dryRun === true))

  orca.panels.handle('board.switch', async ({ terminal }) => {
    await runOrca(['terminal', 'switch', '--terminal', terminal || (await getCoordinatorHandle())])
    return { switched: true }
  })
}

export function deactivate(): void {
  lastReconcile = 0
  settings = null
  host = null
}
