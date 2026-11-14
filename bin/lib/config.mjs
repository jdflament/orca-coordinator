// Loads config.yaml (XDG path or $ORCA_COORDINATOR_CONFIG, plus an optional
// per-project .orca-coordinator.yaml), fills defaults, validates, and renders
// `{{dotted.key}}` placeholders in playbooks and rules.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ADAPTERS } from './adapters.mjs'
import { validateAgainst } from './validate.mjs'
import { parseYaml, toYaml } from './yaml.mjs'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function expandHome(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return os.homedir()
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
}

export function defaultConfigPath() {
  if (process.env.ORCA_COORDINATOR_CONFIG) return expandHome(process.env.ORCA_COORDINATOR_CONFIG)
  const xdg = process.env.XDG_CONFIG_HOME ? expandHome(process.env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config')
  return path.join(xdg, 'orca-coordinator', 'config.yaml')
}

export function defaultStatePath() {
  const xdg = process.env.XDG_STATE_HOME ? expandHome(process.env.XDG_STATE_HOME) : path.join(os.homedir(), '.local', 'state')
  return path.join(xdg, 'orca-coordinator')
}

export function defaultOrcaBin() {
  if (process.env.ORCA_CLI_BIN_DIR) return path.join(process.env.ORCA_CLI_BIN_DIR, 'orca')
  const mac = '/Applications/Orca.app/Contents/Resources/bin/orca'
  if (process.platform === 'darwin' && fs.existsSync(mac)) return mac
  return 'orca'
}

const DEFAULT_AUTOMATIONS = [
  { playbook: 'pr-comments', schedule: '0 9-19 * * 1-5', precheck: 'pr-comments', name: 'My PRs: draft replies and fixes to review comments' },
  { playbook: 'pr-review', schedule: '15 9,12,15,18 * * 1-5', precheck: 'pr-review', name: "Teammates' PRs: draft my review" },
  { playbook: 'ticket-triage', schedule: '30 9 * * 1-5', precheck: 'ticket-triage', name: 'Tickets: triage new ones and plan' },
  { playbook: 'cleanup', schedule: '0 18 * * *', precheck: 'none', name: 'Cleanup: close idle sessions, remove merged worktrees' },
  { playbook: 'eval-weekly', schedule: '0 9 * * 1', precheck: 'eval-weekly', name: 'Coordinator: weekly self-evaluation' },
  { playbook: 'playbook-regression', schedule: '0 10 * * 1-5', precheck: 'playbook-regression', name: 'Coordinator: playbook regression check' }
]

export function defaults() {
  return {
    person: { name: 'you', github: '', language: 'en', tone: 'plain, 2-4 sentences', uiTermsLanguage: 'en', voiceFile: null },
    paths: {
      package: PACKAGE_ROOT,
      state: defaultStatePath(),
      workspace: '',
      worktreeRoot: '',
      orca: defaultOrcaBin()
    },
    agents: {
      coordinator: { agent: '', statusline: false },
      worker: { agent: '', model: null, extraArgs: '', permissionsFile: null },
      automation: { provider: '' }
    },
    git: { branchPattern: '{github}/{ticket-lower}', prTitlePattern: '{ticket}: {title}', protectedBranches: ['main', 'master', 'develop'] },
    repos: [],
    github: { org: '', reviewTeams: [], skipRepos: [], botReviewer: '', requestBotReview: false },
    adapters: {
      ticketing: { kind: 'none', team: '', todoStates: ['Backlog', 'Todo', 'Triage'], childLabel: '', issueUrl: '' },
      chat: { kind: 'none', via: 'mcp:slack', mentionIds: [], reviewChannels: [], draftOnlyChannels: [] },
      flags: { kind: 'none', uiUrl: '', secretRef: '', baseUrl: '', project: 'default' }
    },
    sensitive: ['commit', 'push', 'pr-open', 'pr-merge', 'pr-comment', 'ticket-write', 'chat-post', 'db', 'deploy', 'prod', 'delete-branch', 'settings-allow-deny'],
    queue: { max: 3, staleHours: 24 },
    budget: { stateBytes: 2500, reportHead: 2500, workerRetries: 1, maxWorkersPerTrigger: 3 },
    automations: { enabled: false, timezone: 'UTC', graceMinutes: 720, jobs: DEFAULT_AUTOMATIONS.map((j) => ({ ...j })) },
    board: { oncallLabel: 'oncall', repoColors: {} }
  }
}

export function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra === undefined ? base : extra
  if (base !== null && typeof base === 'object' && extra !== null && typeof extra === 'object') {
    const out = { ...base }
    for (const key of Object.keys(extra)) out[key] = key in base ? deepMerge(base[key], extra[key]) : extra[key]
    return out
  }
  return extra === undefined ? base : extra
}

export function readYamlFile(file) {
  return parseYaml(fs.readFileSync(file, 'utf8'))
}

function findProjectConfig(from = process.cwd()) {
  let dir = path.resolve(from)
  for (;;) {
    const candidate = path.join(dir, '.orca-coordinator.yaml')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function loadConfig({ configPath = defaultConfigPath(), cwd = process.cwd(), strict = true } = {}) {
  let config = defaults()
  const sources = []
  if (fs.existsSync(configPath)) {
    config = deepMerge(config, readYamlFile(configPath) || {})
    sources.push(configPath)
  } else if (strict) {
    throw new Error(`no config at ${configPath}: run "orca-coordinator init" (or set ORCA_COORDINATOR_CONFIG)`)
  }
  const project = findProjectConfig(cwd)
  if (project) {
    config = deepMerge(config, readYamlFile(project) || {})
    sources.push(project)
  }
  config = normalize(config)
  const problems = validate(config)
  if (strict && problems.length) throw new Error(`config invalid:\n  - ${problems.join('\n  - ')}`)
  // A repos entry that is not a git repository is a warning, not an error: consumers skip it.
  const skippedRepos = config.repos.filter((repo) => !isGitRepo(repo.path))
  const warnings = skippedRepos.map(notGitWarning)
  config.repos = config.repos.filter((repo) => !skippedRepos.includes(repo))
  return { config, sources, problems, warnings, skippedRepos, configPath }
}

/** dir is the top level of a git work tree (not a plain folder, not a folder inside a repo). */
export function isGitRepo(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree', '--show-toplevel'], { encoding: 'utf8', timeout: 15000 })
  const [inside, top] = result.status === 0 ? result.stdout.trim().split('\n') : []
  if (inside !== 'true' || !top) return false
  try {
    return fs.realpathSync(top) === fs.realpathSync(dir)
  } catch {
    return false
  }
}

/** The repo's default branch, from origin's HEAD; main when origin has none. */
export function detectBase(dir) {
  const result = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { encoding: 'utf8', timeout: 15000 })
  const ref = result.status === 0 ? result.stdout.trim() : ''
  return ref.startsWith('origin/') && ref.length > 'origin/'.length ? ref.slice('origin/'.length) : 'main'
}

/** In plain words: this repositories entry is not a git repository, so it is ignored. */
export function notGitWarning(repo) {
  return `"${repo?.name || repo?.path || '?'}" (${repo?.path || 'no path'}) is not a git repository, so the coordinator ignores it`
}

/** One warning per repos entry that is not a git repository (it is skipped, never a crash). */
export function repoWarnings(config) {
  return (config.repos || []).filter((repo) => !isGitRepo(repo.path)).map(notGitWarning)
}

function normalize(config) {
  for (const key of ['package', 'state', 'workspace', 'worktreeRoot', 'orca']) {
    if (typeof config.paths[key] === 'string') config.paths[key] = expandHome(config.paths[key])
  }
  if (config.agents.worker.permissionsFile) config.agents.worker.permissionsFile = expandHome(config.agents.worker.permissionsFile)
  if (config.person.voiceFile) config.person.voiceFile = expandHome(config.person.voiceFile)
  config.repos = (config.repos || []).map((r) => ({ ...r, path: expandHome(r.path || '') }))
  return config
}

export const TICKETING_KINDS = ['linear', 'jira', 'github', 'none']
export const CHAT_KINDS = ['slack', 'none']
export const FLAGS_KINDS = ['unleash', 'none']

export function validate(config) {
  const problems = []
  if (!config.person.name) problems.push('person.name is empty')
  if (!config.paths.workspace) problems.push('paths.workspace is empty (the Orca workspace folder the coordinator runs in)')
  if (!config.paths.state) problems.push('paths.state is empty')
  if (!TICKETING_KINDS.includes(config.adapters.ticketing.kind)) problems.push(`adapters.ticketing.kind must be one of ${TICKETING_KINDS.join('|')}`)
  if (!CHAT_KINDS.includes(config.adapters.chat.kind)) problems.push(`adapters.chat.kind must be one of ${CHAT_KINDS.join('|')}`)
  if (!FLAGS_KINDS.includes(config.adapters.flags.kind)) problems.push(`adapters.flags.kind must be one of ${FLAGS_KINDS.join('|')}`)
  if (typeof config.queue.max !== 'number' || config.queue.max < 1) problems.push('queue.max must be a number ≥ 1')
  if (typeof config.budget.stateBytes !== 'number' || config.budget.stateBytes < 500) problems.push('budget.stateBytes must be a number ≥ 500')
  for (const job of config.automations.jobs || []) {
    if (!job.playbook) problems.push('automations.jobs[]: playbook is required')
    if (!job.schedule) problems.push(`automations.jobs[${job.playbook}]: schedule is required`)
  }
  for (const repo of config.repos) if (!repo.name) problems.push('repos[]: name is required')
  problems.push(...validateRepoAdapters(config))
  return problems
}

const CONFIG_SCHEMA = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'schema', 'config.schema.json'), 'utf8'))
const KINDS = { ticketing: TICKETING_KINDS, chat: CHAT_KINDS }

/** A repo's own ticketing / chat blocks (advanced, for the shell prechecks): shape (schema/config.schema.json) and known kind. */
function validateRepoAdapters(config) {
  const problems = []
  const label = (i) => `repos[${config.repos[i]?.name || i}]`
  for (const problem of validateAgainst(CONFIG_SCHEMA, { repos: config.repos })) {
    // Kinds are reported below, by name; the rest as the schema words it.
    if (/\.(ticketing|chat)\.kind: must be one of/.test(problem)) continue
    if (/^\$\.repos\[\d+\]\.(name|path): required$/.test(problem)) continue
    problems.push(problem.replace(/^\$\.repos\[(\d+)\]/, (_, i) => label(Number(i))))
  }
  config.repos.forEach((repo, i) => {
    for (const kind of REPO_ADAPTERS) {
      const block = repo[kind]
      if (block === undefined || block === null) continue
      if (typeof block !== 'object' || Array.isArray(block)) continue
      if (block.kind !== undefined && !KINDS[kind].includes(block.kind)) {
        problems.push(`${label(i)}.${kind}.kind must be one of ${KINDS[kind].join('|')}`)
      }
    }
  })
  return problems
}

function derived(config) {
  const pkg = config.paths.package
  const state = config.paths.state
  const configDir = path.dirname(defaultConfigPath())
  const adapter = (kind, name) => path.join(pkg, 'adapters', kind, `${name}.sh`)
  return {
    configPath: defaultConfigPath(),
    paths: {
      bin: path.join(state, 'bin'),
      playbooks: path.join(state, 'playbooks'),
      reports: path.join(state, 'reports'),
      archive: path.join(state, 'archive'),
      automations: path.join(state, 'automations'),
      automationState: path.join(state, 'automations', 'state'),
      stateFile: path.join(state, 'state.md'),
      board: path.join(state, 'board.json'),
      lessons: path.join(state, 'lessons.md'),
      metrics: path.join(state, 'metrics.tsv'),
      rulesFile: path.join(state, 'COORDINATOR.md'),
      terminalFile: path.join(state, 'coordinator-terminal'),
      rulesLocal: path.join(configDir, 'rules.local.md'),
      playbooksLocal: path.join(configDir, 'playbooks.local')
    },
    adapters: {
      // cmd: the default tool's script; run: <state>/bin/<kind> [--repo <name>], which resolves the repo's own tool.
      ticketing: { cmd: adapter('ticketing', config.adapters.ticketing.kind), run: path.join(state, 'bin', 'ticketing') },
      chat: { cmd: adapter('chat', config.adapters.chat.kind), run: path.join(state, 'bin', 'chat') },
      flags: { cmd: adapter('flags', config.adapters.flags.kind) }
    },
    git: { branchExample: config.git.branchPattern.replace('{github}', config.person.github || 'me').replace('{ticket-lower}', 'proj-123') }
  }
}

function flatten(value, prefix = '', out = {}) {
  if (Array.isArray(value)) {
    out[prefix] = value.map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''))).join(', ')
    out[`${prefix}.json`] = JSON.stringify(value)
    value.forEach((v, i) => flatten(v, `${prefix}.${i}`, out))
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) flatten(value[key], prefix ? `${prefix}.${key}` : key, out)
  } else {
    out[prefix] = value === null || value === undefined ? '' : String(value)
  }
  return out
}

export function templateValues(config) {
  return flatten(deepMerge(config, derived(config)))
}

export function render(text, values, { strict = true, file = 'template' } = {}) {
  const missing = new Set()
  const out = text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, key) => {
    if (key in values) return values[key]
    missing.add(key)
    return whole
  })
  if (strict && missing.size) throw new Error(`${file}: unknown placeholder(s) ${[...missing].join(', ')}`)
  return out
}

export function toShellExports(config) {
  const values = templateValues(config)
  return Object.entries(values)
    .map(([key, value]) => `CFG_${key.replace(/[^a-zA-Z0-9]+/g, '_')}=${shellQuote(value)}`)
    .join('\n') + '\n'
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export { toYaml }
