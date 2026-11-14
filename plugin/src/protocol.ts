// The panel <-> worker contract: board.json (schema/board.schema.json) plus what the
// worker adds from Orca (live workers, coordinator liveness) and from panel.json.

/** A link's known host, only to pick an icon and a label; absent for any other host (a plain link). */
export interface LinkHost {
  name: string
  kind: 'ticket' | 'code' | 'chat' | 'doc'
}

interface BoardOption {
  id: string
  label: string
  recommended?: boolean
}

interface BoardDecision {
  id: number | string
  title: string
  repo?: string
  url?: string
  action: string
  context?: string
  options: BoardOption[]
  status: 'pending' | 'answered' | string
  answer?: string
  oncall?: boolean
  /** Added by board.get from url. */
  linkHost?: LinkHost
}

interface BoardWorkstream {
  id: string
  title: string
  url?: string
  status: string
  progress?: number | null
  notes?: string
  oncall?: boolean
  /** Added by board.get from url. */
  linkHost?: LinkHost
}

interface BoardTask {
  id: string
  ws?: string
  repo?: string
  branch?: string
  status: 'local' | 'pr' | 'hold' | 'blocked' | 'merged' | string
  pr?: number
  url?: string
  detail?: string
  oncall?: boolean
  /** Added by board.get from url. */
  linkHost?: LinkHost
}

interface BoardRepo {
  id: string
  name: string
  kind: string
  repo?: string
  status: string
  detail?: string
  url?: string
  oncall?: boolean
  /** Added by board.get from url. */
  linkHost?: LinkHost
}

interface BoardAgent {
  id?: string
  name: string
  repo?: string
  role?: string
  state: 'idle' | 'working' | 'waiting' | 'stopped' | string
  detail?: string
}

interface BoardInstruction {
  id: string
  text: string
  status: 'active' | 'done' | string
}

export interface Board {
  version: number
  focus?: string
  updatedAt?: string
  instructions?: BoardInstruction[]
  decisions?: BoardDecision[]
  workstreams?: BoardWorkstream[]
  tasks?: BoardTask[]
  repos?: BoardRepo[]
  agents?: BoardAgent[]
  log?: { at: string; text: string }[]
}

/** A live orchestration worker, read from Orca. */
export interface LiveWorker {
  dispatchId: string
  title: string
  status: 'working' | 'idle' | 'needs input'
  terminal: string | null
  needsInput: boolean
  /** From the board agent that is the same work (see board.get), when there is one. */
  repo?: string
  detail?: string
}

/** Uncommitted or unpushed work in a configured repo, read from git (not from board.json). */
export interface LocalWork {
  repo: string
  branch: string
  changed: number
  unpushed: number
}

/** What `board.get` answers: the board plus live data and panel.json settings. */
export interface BoardView extends Board {
  /** Live workers; a board agent for the same work (same id, else name = title) is merged in and left out of agents. */
  workers: LiveWorker[]
  /** Derived per configured repo; a row a board task already covers (same repo and branch) is left out. */
  localWork: LocalWork[]
  coordinatorLive: boolean
  /** Set up and not running: the only state in which the panel shows "Start coordinator". */
  canStart: boolean
  /** Skill links that point at another copy of the package: the panel offers "Update links". */
  staleLinks: string[]
  repoColors: Record<string, string>
  oncallLabel: string
}

/** An Orca workspace the coordinator can be set up in. */
export interface SetupWorkspace {
  path: string
  name: string
}

/** An Orca repo or folder (`orca repo list`). */
export interface SetupRepo {
  /** Orca's repo id (empty when Orca gives none). */
  id: string
  path: string
  name: string
  folder: boolean
}

/** What `setup.status` answers: whether a valid config exists, and the setup form's choices. */
export interface SetupStatus {
  configured: boolean
  version: string
  node: boolean
  /** The default (first folder, else shortest path) comes first. */
  workspaces: SetupWorkspace[]
  /** Repos (not folders) the coordinator can watch. */
  repos: SetupRepo[]
  /** git config user.name, to prefill the name. */
  personName: string
  /** The agent kinds Orca reports (agents.list); only the coordinator's own is selected. Empty when Orca reports none. */
  agents: SetupAgent[]
  coordinatorAgent: string
  /** The settings file the optional status line badge edits, for the coordinator's agent (empty path: not offered). */
  statusLine: { path: string; available: boolean }
  /** The plugin's own folders setup writes (shown with the paths it links or edits). */
  ownPaths: string[]
}

/** An agent kind Orca reports: path is the exact link setup would create ('' = no skills folder known, nothing to link). */
export interface SetupAgent {
  id: string
  name: string
  path: string
  selected: boolean
}

/** The setup form. Fields left out keep init's detection; repos: [] watches none. */
export interface SetupOptions {
  workspace: string
  name?: string
  repos?: string[]
  /** Agent ids whose skills folder gets the link; none given = none linked. */
  agents?: string[]
  /** The agent kind (from Orca's report) the coordinator runs as; sent to init as the coordinator agent. */
  coordinatorAgent?: string
  /** Edit statusLine in the settings file status shows (the ◆ COORDINATOR badge). */
  statusLine?: boolean
  /** The user pressed the button on the screen that showed the paths; without it nothing is written. */
  confirmed?: boolean
}

export interface ConfigRepo {
  name: string
  path: string
  base?: string
  /** ticketing / chat blocks (advanced, config.yaml-only, for shell prechecks and adapters/*.sh) pass through untouched. */
  [key: string]: unknown
}

/** The part of the merged config (`coordinator.mjs config --json`) the panel reads and edits. */
export interface CoordinatorSettings {
  person: { name: string; language: string; tone: string; [key: string]: unknown }
  paths: { package: string; workspace: string; state: string; [key: string]: unknown }
  agents: {
    coordinator: { agent: string; model?: string | null; [key: string]: unknown }
    worker: { agent: string; model?: string | null; [key: string]: unknown }
    reader?: { model?: string | null }
    [key: string]: unknown
  }
  repos: ConfigRepo[]
  /** Everything else (adapters, queue, budget, automations…) is config.yaml-only: the panel never reads or edits it. */
  [key: string]: unknown
}

/** The models one agent offers (`<agent> models`), null when it cannot say: the panel then shows a free-text field. tiers: best / medium / lowest of that list. */
export interface ModelChoice {
  models: string[] | null
  tiers: { best: string; medium: string; lowest: string } | null
}

/** What `config.read` answers. config is null when there is no config or it cannot be read. */
export interface ConfigRead {
  path: string
  config: CoordinatorSettings | null
  /** Validation problems (empty when valid). */
  problems: string[]
  /** Orca's git repositories (never its plain folders). */
  repos: SetupRepo[]
  /** config.yaml repos entries that are not git repositories: ignored, offered for removal. */
  skippedRepos: ConfigRepo[]
  /** Models of the coordinator's agent and of the workers' agent (readers use the workers'). */
  models: { coordinator: ModelChoice; worker: ModelChoice }
}

/** What `config.save` takes: merged into config.yaml; objects merge, repos replace. Other keys (adapters, automations, queue, budget) and a repo's ticketing / chat are ignored. */
export interface ConfigPatch {
  person?: { name?: string; language?: string; tone?: string }
  repos?: ConfigRepo[]
  agents?: { coordinator?: { model?: string | null }; worker?: { model?: string | null }; reader?: { model?: string | null } }
  /**
   * The repo paths the form showed as watched when it was opened. Given, the save applies only
   * the form's additions and removals to config.yaml's current repos, so a form opened before
   * someone else edited the file cannot put back an entry they removed.
   */
  reposLoaded?: string[]
}

export type BoardRemoveKind = 'task' | 'workstream' | 'agent'

/** What a removal took off the board; the panel keeps it for a few seconds so Undo can put it back. */
export interface BoardRemoval {
  kind: BoardRemoveKind
  item: Record<string, unknown>
}

/** counts: parsed from the summary line ("would …" in a dry run); absent when it does not match. */
export interface CleanupResult {
  summary: string
  actions: string[]
  dryRun: boolean
  counts?: { released: number; removed: number; kept: number }
}

/** saved: config.yaml was written; ok: and render succeeded. */
export interface ConfigSave {
  ok: boolean
  saved: boolean
  errors: string[]
  output?: string[]
}

declare module 'orca' {
  interface PluginRequests {
    'board.get': { output: BoardView }
    /** Types text + Enter into the coordinator terminal, or queues it in inbox.jsonl when offline. */
    'board.send': { input: { text: string }; output: { sent: boolean; queued: boolean } }
    /** Runs <coordinatorDir>/bin/cleanup (dryRun: with -n, changing nothing) and returns its summary line and actions. */
    /** Removes a task (id), workstream (id) or agent (name) through bin/board. Rejects the coordinator and an agent that is working. */
    'board.remove': { input: { kind: BoardRemoveKind; id: string }; output: BoardRemoval }
    /** Closes an idle or finished-but-open worker session (orca orchestration worker-release). Rejects a working worker, one needing input and the coordinator; cannot be undone. */
    'board.closeSession': { input: { dispatchId: string }; output: { closed: boolean } }
    /** Undo: adds a removed item back through bin/board. */
    'board.restore': { input: { removal: BoardRemoval }; output: { restored: boolean } }
    'board.cleanup': { input: { dryRun?: boolean }; output: CleanupResult }
    /**
     * Shows a configured repo's changes natively: its workspace + Source Control (needs
     * workspace:write), else `orca file open-changed --mode diff`. Rejects an unknown repo.
     */
    'work.openChanges': { input: { repo: string }; output: { opened: boolean; via: 'source-control' | 'cli' } }
    /** Opens Orca's Workspace Board (commands.run workspace.openBoard). */
    'agents.openBoard': { output: { opened: boolean; error?: string } }
    /** Brings a terminal to the front (the coordinator's when none is given). */
    'board.switch': { input: { terminal?: string }; output: { switched: boolean } }
    'setup.status': { output: SetupStatus }
    /** Needs confirmed: true. Copies the package to its stable home and runs init with the answers: links only the chosen agents. */
    'setup.run': { input: SetupOptions; output: { ok: boolean; output: string } }
    /** Starts the coordinator agent in the configured workspace, in a terminal, focused. */
    /** agent: the kind the user picked from what Orca reports; choices: asked back when Orca reports several and none was picked. */
    'setup.start': { input: { agent?: string }; output: { started: boolean; output: string; choices?: string[] } }
    /** Re-points existing skill links that are stale; creates no new link and edits no settings. */
    'setup.updateLinks': { output: { updated: string[] } }
    /** The user's config.yaml, merged with defaults, plus its problems and the choices. */
    'config.read': { output: ConfigRead }
    /** Removes one repos entry that is not a git repository from config.yaml (read back to check), then renders. */
    'config.removeRepo': { input: { path: string }; output: ConfigSave }
    /** Merges person/repos into config.yaml through `coordinator.mjs config --merge` (validated), then runs render. Never automations. */
    'config.save': { input: { patch: ConfigPatch }; output: ConfigSave }
  }
}

export {}
