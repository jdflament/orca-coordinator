// Setting the coordinator up from inside Orca. The plugin is the whole orca-coordinator
// package; Orca keeps each installed version in its own folder, so the package is copied to a
// stable home (the skill link, wrappers and automations point there) and init runs from it.
// Runs on the user's own node, not Orca's: init writes that path into the wrappers.
import { execFile } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConfigPatch, ModelChoice, ConfigRepo, ConfigRead, ConfigSave, CoordinatorSettings, SetupAgent, SetupOptions, SetupRepo, SetupStatus, SetupWorkspace } from './protocol'
import { listProjects, listReportedAgents, type Host } from './host'

/** This plugin's root: src/ → plugin/ → the package. */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE_MARKER = '.installed-from'
const NO_NODE = 'Node.js 20.6 or newer is needed on your PATH (https://nodejs.org).'

export function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
}

function xdg(variable: string, fallback: string): string {
  const value = process.env[variable]
  return value && value.trim() ? value : path.join(os.homedir(), fallback)
}

export function homeDir(): string {
  return process.env.ORCA_COORDINATOR_HOME || path.join(xdg('XDG_DATA_HOME', '.local/share'), 'orca-coordinator')
}

export function configFile(): string {
  return process.env.ORCA_COORDINATOR_CONFIG || path.join(xdg('XDG_CONFIG_HOME', '.config'), 'orca-coordinator', 'config.yaml')
}

function versionOf(dir: string): string {
  try {
    return String(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

/** The env for child processes: the user's node, not Orca's Electron-as-node. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function run(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<{ ok: boolean; output: string; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env: options.env ?? childEnv(), timeout: options.timeout ?? 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout ?? '')
      const err = String(stderr ?? '')
      resolve({ ok: !error, output: `${out}${err}`.trim() || (error ? error.message : ''), stdout: out, stderr: err })
    })
  })
}

/** dir is the top level of a git work tree: a plain folder, or a folder inside a repo, is not. */
export async function isGitRepo(dir: string): Promise<boolean> {
  if (!dir || !existsSync(dir)) return false
  const result = await run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree', '--show-toplevel'], { timeout: 15000 })
  const [inside, top] = result.ok ? result.stdout.trim().split('\n') : []
  if (inside !== 'true' || !top) return false
  try {
    return realpathSync(top) === realpathSync(dir)
  } catch {
    return false
  }
}

/** The entries that are git repositories, in order. */
export async function onlyGitRepos<T extends { path: string }>(entries: T[]): Promise<T[]> {
  const keep = await Promise.all(entries.map((entry) => isGitRepo(entry.path)))
  return entries.filter((_, i) => keep[i])
}

/** The user's node when it is ≥ 20.6, else ''. */
export async function findNode(): Promise<string> {
  const result = await run('node', ['-e', 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=6)?0:1)'])
  if (!result.ok) return ''
  return (await run('node', ['-p', 'process.execPath'])).output
}

/** The stable home holds this exact plugin version already. */
function isSynced(): boolean {
  try {
    return readFileSync(path.join(homeDir(), SOURCE_MARKER), 'utf8').trim() === PACKAGE_DIR
  } catch {
    return false
  }
}

/** The stable home's CLI differs from this plugin's: copied from an older state of the same folder. */
function isHomeStale(): boolean {
  try {
    return readFileSync(path.join(homeDir(), 'bin', 'coordinator.mjs'), 'utf8') !== readFileSync(path.join(PACKAGE_DIR, 'bin', 'coordinator.mjs'), 'utf8')
  } catch {
    return true
  }
}

/** Copy the package to the stable home, swapping the folder so a failed copy leaves the old one. force: even when the marker says it is synced. */
export function syncPackage(force = false): void {
  if ((!force && isSynced()) || path.resolve(homeDir()) === PACKAGE_DIR) return
  const home = homeDir()
  const next = `${home}.next`
  rmSync(next, { recursive: true, force: true })
  cpSync(PACKAGE_DIR, next, { recursive: true, filter: (src) => !/[\\/](\.git|\.orca|node_modules)$/.test(src) })
  writeFileSync(path.join(next, SOURCE_MARKER), PACKAGE_DIR + '\n')
  rmSync(`${home}.old`, { recursive: true, force: true })
  if (existsSync(home)) renameSync(home, `${home}.old`)
  renameSync(next, home)
  rmSync(`${home}.old`, { recursive: true, force: true })
}

const lines = (output: string): string[] => output.split('\n').map((line) => line.trim()).filter(Boolean)

/** The CLI's problem lines, without its "config invalid:" header and its "- " / "orca-coordinator: " prefixes. */
const problemLines = (output: string): string[] =>
  lines(output)
    .filter((line) => !/^(orca-coordinator: )?config invalid:$/.test(line))
    .map((line) => line.replace(/^- /, '').replace(/^orca-coordinator: /, ''))

/** `coordinator.mjs config --json` with the user's node; strict also validates. warnings: entries the CLI skipped (a repo that is not a git repository). */
async function loadConfigJson(node: string, strict: boolean): Promise<{ config: CoordinatorSettings | null; problems: string[]; warnings: string[] }> {
  const result = await run(node, [path.join(PACKAGE_DIR, 'bin', 'coordinator.mjs'), 'config', '--json', ...(strict ? [] : ['--lenient'])])
  const warnings = lines(result.stderr).filter((line) => line.startsWith('warning: ')).map((line) => line.slice('warning: '.length))
  if (!result.ok) return { config: null, warnings, problems: problemLines(result.output).filter((line) => !line.startsWith('warning: ')) }
  try {
    const config = JSON.parse(result.stdout) as CoordinatorSettings
    // Defence in depth: whatever the CLI version, only git repositories are repos.
    if (Array.isArray(config.repos)) config.repos = await onlyGitRepos(config.repos.filter((repo) => repo && repo.path))
    return { config, problems: [], warnings }
  } catch {
    return { config: null, problems: ['config --json printed something that is not JSON'], warnings }
  }
}

/** The merged config, as the package's own CLI reads it; null when there is none. */
export async function readConfig(): Promise<CoordinatorSettings | null> {
  if (!existsSync(configFile())) return null
  const node = await findNode()
  if (!node) return null
  return (await loadConfigJson(node, false)).config
}

/** A config file exists and the package's own validation accepts it. */
async function isConfigValid(node: string): Promise<boolean> {
  return Boolean(node) && existsSync(configFile()) && (await loadConfigJson(node, true)).config !== null
}

async function gitUserName(): Promise<string> {
  const result = await run('git', ['config', '--global', 'user.name'], { timeout: 5000 })
  return result.ok ? result.output.split('\n')[0].trim() : ''
}

async function init(node: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return run(node, [path.join(homeDir(), 'bin', 'coordinator.mjs'), 'init', '--yes', '--no-plugin', ...args], { timeout: 180000 })
}

type Orca = (args: string[]) => Promise<string>

/** Orca's repos and folders (host API `project.list`, else `orca repo list`). */
export async function listOrcaRepos(orca: Orca, host: Host | null = null): Promise<SetupRepo[]> {
  return (await listProjects(host, orca))
    .filter((repo) => repo.path)
    .map((repo) => ({ id: String(repo.id ?? ''), path: String(repo.path), name: repo.displayName || path.basename(String(repo.path)), folder: repo.kind !== undefined && repo.kind !== 'git' }))
}

/** Orca's git repositories (kind "git"), each confirmed by git: never a plain folder. */
export async function listGitRepos(orca: Orca, host: Host | null = null): Promise<SetupRepo[]> {
  return onlyGitRepos((await listOrcaRepos(orca, host)).filter((repo) => !repo.folder))
}

/** Where the coordinator can live: the default first (the first folder, else the shortest path), then the rest by path length. */
export function listWorkspaces(repos: SetupRepo[]): SetupWorkspace[] {
  const home = os.homedir()
  const fallback = repos.find((repo) => repo.folder) ?? [...repos].sort((a, b) => a.path.length - b.path.length)[0]
  return [...repos]
    .sort((a, b) => Number(b === fallback) - Number(a === fallback) || Number(b.folder) - Number(a.folder) || a.path.length - b.path.length)
    .map((repo) => ({ path: repo.path, name: repo.path.startsWith(home + '/') ? '~' + repo.path.slice(home.length) : repo.path }))
}

// ---- the other agents' config: only written after the user confirmed the exact paths ----

/** Where init may write per agent id: asked of the CLI, so no agent or path is named in this UI. */
type AgentFiles = { skill: Record<string, string>; statusLine: Record<string, string> }
let agentFilesCache: { node: string; files: AgentFiles } | null = null

async function agentFiles(): Promise<AgentFiles> {
  const none: AgentFiles = { skill: {}, statusLine: {} }
  const node = await findNode()
  if (!node) return none
  if (agentFilesCache?.node === node) return agentFilesCache.files
  const result = await run(node, [path.join(PACKAGE_DIR, 'bin', 'coordinator.mjs'), 'agent-files'])
  try {
    const files = { ...none, ...(JSON.parse(result.stdout) as Partial<AgentFiles>) }
    agentFilesCache = { node, files }
    return files
  } catch {
    return none
  }
}

const tilde = (value: string): string => (value.startsWith(os.homedir() + '/') ? '~' + value.slice(os.homedir().length) : value)

/**
 * The agents come from Orca (`agents.list`): the kinds it reports running in the focused workspace,
 * the coordinator's own terminal first and the only one preselected (when it is the only kind, that one).
 * A kind with no known skills folder is listed with an empty path: nothing can be linked for it.
 */
export async function reportedAgents(host: Host | null, coordinatorHandle: string): Promise<{ agents: SetupAgent[]; coordinatorAgent: string }> {
  const rows = await listReportedAgents(host)
  const own = rows.find((row) => coordinatorHandle && row.terminalId === coordinatorHandle)?.kind ?? ''
  const kinds = [...new Set([...(own ? [own] : []), ...rows.map((row) => row.kind)])]
  const coordinatorAgent = own || (kinds.length === 1 ? kinds[0] : '')
  const files = await agentFiles()
  return { agents: kinds.map((id) => ({ id, name: id, path: files.skill[id] ?? '', selected: id === coordinatorAgent })), coordinatorAgent }
}

/** Skill links that point at another copy of this package's skill (or nowhere): the ones an update leaves for the user to refresh. */
export async function staleSkillLinks(): Promise<string[]> {
  const current = path.join(homeDir(), 'skill', 'coordinator')
  return Object.values((await agentFiles()).skill).filter((shown) => {
    try {
      const target = readlinkSync(expandHome(shown))
      return target !== current && target.endsWith(path.join('skill', 'coordinator'))
    } catch {
      return false
    }
  })
}

/** Points the stale links at this package's skill: only links that already exist and are ours, nothing new. */
export async function updateLinks(): Promise<{ updated: string[] }> {
  const target = path.join(homeDir(), 'skill', 'coordinator')
  const updated = await staleSkillLinks()
  for (const shown of updated) {
    const link = expandHome(shown)
    rmSync(link, { force: true })
    symlinkSync(target, link)
  }
  return { updated }
}

export async function getSetupStatus(orca: Orca, host: Host | null = null, coordinatorHandle = ''): Promise<SetupStatus> {
  const [node, repos, personName] = await Promise.all([findNode(), listOrcaRepos(orca, host).catch(() => [] as SetupRepo[]), gitUserName()])
  const agents = await reportedAgents(host, coordinatorHandle)
  const statusLinePath = (await agentFiles()).statusLine[agents.coordinatorAgent] ?? ''
  return {
    configured: await isConfigValid(node),
    version: versionOf(PACKAGE_DIR),
    node: Boolean(node),
    // Where the coordinator lives may be a folder; what it watches is git repositories only.
    workspaces: listWorkspaces(repos),
    repos: await onlyGitRepos(repos.filter((repo) => !repo.folder)),
    personName,
    ...agents,
    // Offered only for the coordinator's own agent, and only when the CLI knows that agent's status-line file.
    statusLine: { path: statusLinePath, available: Boolean(statusLinePath) },
    ownPaths: [tilde(homeDir()), tilde(path.dirname(configFile())), '~/.local/state/orca-coordinator']
  }
}

/**
 * Checks the setup form before anything is written; returns the init flags or the problems.
 * No tool fields: the coordinator uses whatever tools its agent has (a ticketing / chat key in the form is ignored).
 */
async function setupFlags(options: SetupOptions): Promise<{ args: string[]; problems: string[] }> {
  const problems: string[] = []
  const workspace = String(options.workspace ?? '')
  if (!workspace || !existsSync(workspace)) problems.push(`workspace not found: ${workspace}`)
  const args = ['--workspace', workspace]
  const name = String(options.name ?? '').trim()
  if (name) args.push('--name', name)
  const agents = Array.isArray(options.agents) ? options.agents.map(String) : []
  const skillDirs = (await agentFiles()).skill
  const unknown = agents.filter((id) => !(id in skillDirs))
  if (unknown.length) problems.push(`no skills folder known for: ${unknown.join(', ')}`)
  const coordinatorAgent = String(options.coordinatorAgent ?? '').trim()
  if (coordinatorAgent && !/^[\w.-]+$/.test(coordinatorAgent)) problems.push(`invalid agent id: ${coordinatorAgent}`)
  else if (coordinatorAgent) args.push('--coordinator-agent', coordinatorAgent)
  if (agents.length === 0) args.push('--no-skill-link')
  for (const id of agents) args.push('--skill-agent', id)
  args.push(options.statusLine === true ? '--statusline' : '--no-statusline')
  if (Array.isArray(options.repos)) {
    if (options.repos.length === 0) args.push('--no-repos')
    for (const repo of options.repos) args.push('--repo', String(repo))
  }
  return { args, problems }
}

/** First setup: copy the package home and run init for the chosen workspace and answers. Writes nothing until the user confirmed the paths the screen showed. */
export async function runSetup(options: SetupOptions): Promise<{ ok: boolean; output: string }> {
  if (options.confirmed !== true) return { ok: false, output: 'Setup was not confirmed: nothing was written.' }
  const node = await findNode()
  if (!node) return { ok: false, output: NO_NODE }
  const { args, problems } = await setupFlags(options)
  if (problems.length) return { ok: false, output: problems.join('\n') }
  syncPackage()
  return init(node, args)
}

/** The patch keys whose value in the re-read config differs from what was saved. */
function notLanded(patch: ConfigPatch, config: CoordinatorSettings | null): string[] {
  if (!config) return ['config.yaml (unreadable after the save)']
  const missing: string[] = []
  const walk = (expected: unknown, actual: unknown, key: string): void => {
    if (key === 'repos') {
      const line = (r: ConfigRepo) => `${r.name}=${path.resolve(expandHome(String(r.path)))}`
      const want = (expected as ConfigRepo[]).map(line)
      const got = ((actual ?? []) as ConfigRepo[]).map(line)
      if (want.join('\n') !== got.join('\n')) missing.push(key)
    } else if (expected !== null && typeof expected === 'object') {
      for (const [k, v] of Object.entries(expected)) walk(v, (actual as Record<string, unknown> | undefined)?.[k], `${key}.${k}`)
    } else if (expected !== actual) missing.push(key)
  }
  for (const [key, value] of Object.entries(patch)) walk(value, (config as Record<string, unknown>)[key], key)
  return missing
}

/** The CLI of the package the config points at (render writes that package's paths into the wrappers). */
function coordinatorCli(config: CoordinatorSettings | null): string {
  const own = config?.paths?.package ? path.join(config.paths.package, 'bin', 'coordinator.mjs') : ''
  return own && existsSync(own) ? own : path.join(PACKAGE_DIR, 'bin', 'coordinator.mjs')
}

const NO_MODELS: ModelChoice = { models: null, tiers: null }

/**
 * The models an agent offers: the lines of `<agent> models` (a CLI argv, no shell). Null when the
 * agent has no such command, fails or prints nothing usable: the panel then asks for free text.
 * Tiers are picked by name (best / medium / lowest), else by position in the list.
 */
export async function listModels(agent: string | undefined): Promise<ModelChoice> {
  if (!agent || !/^[\w.-]+$/.test(agent)) return NO_MODELS
  const result = await run(agent, ['models'], { timeout: 8000 })
  const models = result.ok ? [...new Set(lines(result.stdout).filter((line) => /^[A-Za-z0-9][\w./:@+-]*$/.test(line)))] : []
  if (models.length === 0) return NO_MODELS
  const find = (pattern: RegExp, fallback: number) => models.find((m) => pattern.test(m)) ?? models[fallback]
  return {
    models,
    tiers: {
      best: find(/opus|ultra|max|pro|large/i, 0),
      medium: find(/sonnet|medium|standard/i, Math.floor(models.length / 2)),
      lowest: find(/haiku|nano|mini|flash|lite|small/i, models.length - 1)
    }
  }
}

/** What the settings view shows: the merged config (defaults filled), its problems, and the choices. */
export async function readSettings(orca: Orca, host: Host | null = null): Promise<ConfigRead> {
  const base = { path: configFile(), skippedRepos: [] as ConfigRepo[], models: { coordinator: NO_MODELS, worker: NO_MODELS } }
  const repos = await listGitRepos(orca, host).catch(() => [] as SetupRepo[])
  if (!existsSync(configFile())) return { ...base, repos, config: null, problems: [`no config at ${configFile()}: set the coordinator up first`] }
  const node = await findNode()
  if (!node) return { ...base, repos, config: null, problems: [NO_NODE] }
  // Entries that are not git repositories are not problems to fix by hand: the view offers to remove each.
  const skippedRepos = await loadSkippedRepos(node)
  const strict = await loadConfigJson(node, true)
  const lenient = strict.config ? null : await loadConfigJson(node, false)
  const config = strict.config ?? lenient?.config ?? null
  const models = { coordinator: await listModels(config?.agents?.coordinator?.agent), worker: await listModels(config?.agents?.worker?.agent) }
  return { ...base, repos, skippedRepos, models, config, problems: strict.config ? [] : strict.problems }
}

/** config.yaml's repos entries that are not git repositories (`config --skipped-repos`); [] when unreadable. */
async function loadSkippedRepos(node: string): Promise<ConfigRepo[]> {
  const result = await run(node, [path.join(PACKAGE_DIR, 'bin', 'coordinator.mjs'), 'config', '--lenient', '--skipped-repos'])
  try {
    const value = JSON.parse(result.stdout) as unknown
    return Array.isArray(value) ? (value as ConfigRepo[]) : []
  } catch {
    return []
  }
}

const samePath = (a: unknown, b: unknown): boolean => path.resolve(expandHome(String(a ?? ''))) === path.resolve(expandHome(String(b ?? '')))

/** A repo's tool blocks: advanced, config.yaml-only (for the shell prechecks and adapters/*.sh); the panel never sets them. */
const REPO_BLOCKS = ['ticketing', 'chat'] as const

/** A repo the form adds, without any tool block it may carry. */
function withoutBlocks(entry: ConfigRepo): ConfigRepo {
  const out: ConfigRepo = { ...entry }
  for (const key of REPO_BLOCKS) delete out[key]
  return out
}

/**
 * The repos to write: config.yaml's current (git) repos, minus what the form unchecked, plus what
 * it checked, when the form says what it loaded; else the form's list as it is. Either way an
 * existing repo is written back as config.yaml has it (its ticketing / chat blocks included), and
 * the form's own tool blocks are dropped.
 */
function mergeRepos(current: ConfigRepo[], form: ConfigRepo[], loaded: string[] | undefined): ConfigRepo[] {
  if (!Array.isArray(loaded)) return form.map((repo) => current.find((c) => samePath(c.path, repo.path)) ?? withoutBlocks(repo))
  const removed = loaded.filter((p) => !form.some((repo) => samePath(repo.path, p)))
  const added = form.filter((repo) => !loaded.some((p) => samePath(repo.path, p)) && !current.some((c) => samePath(c.path, repo.path)))
  const kept = current.filter((repo) => !removed.some((p) => samePath(repo.path, p)))
  return [...kept, ...added.map(withoutBlocks)]
}

/** The settings the panel may change; everything else (adapters, automations, queue, budget) stays config.yaml-only. */
const EDITABLE = ['person', 'repos', 'agents'] as const

/**
 * Merges the editable settings into config.yaml (validated by the package's CLI), then renders.
 * Nothing is written when validation fails; adapters, automations, queue and budget are never touched.
 */
export async function saveSettings(patch: ConfigPatch): Promise<ConfigSave> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, saved: false, errors: ['settings must be an object'] }
  const node = await findNode()
  if (!node) return { ok: false, saved: false, errors: [NO_NODE] }
  const editable = Object.fromEntries(EDITABLE.filter((key) => key in patch).map((key) => [key, patch[key]])) as ConfigPatch
  if (Array.isArray(editable.repos)) {
    const current = await loadConfigJson(node, false)
    if (!current.config) return { ok: false, saved: false, errors: ['config.yaml could not be read before the save; nothing was written.', ...current.problems] }
    editable.repos = mergeRepos(current.config.repos ?? [], editable.repos, patch.reposLoaded)
    const given = editable.repos.filter((repo) => repo && typeof repo === 'object')
    const git = await onlyGitRepos(given.map((repo) => ({ ...repo, path: path.resolve(expandHome(String(repo.path ?? ''))) })))
    const kept = new Set(git.map((repo) => repo.path))
    const notGit = given.filter((repo) => !kept.has(path.resolve(expandHome(String(repo.path ?? '')))))
    if (notGit.length) return { ok: false, saved: false, errors: notGit.map((repo) => `${repo.name || repo.path}: ${repo.path} is not a git repository; only git repositories can be watched`) }
  }
  // Writing config.yaml does not depend on where the package lives: always this plugin's own CLI,
  // which has `config --merge` (an older installed copy prints the config and exits 0 instead).
  const merge = await run(node, [path.join(PACKAGE_DIR, 'bin', 'coordinator.mjs'), 'config', '--merge', JSON.stringify(editable)])
  if (!merge.ok) return { ok: false, saved: false, errors: problemLines(merge.output) }
  // Never trust the exit code alone: read config.yaml back and check every value landed.
  const after = await loadConfigJson(node, false)
  const missing = notLanded(editable, after.config)
  if (missing.length) return { ok: false, saved: false, errors: [`config.yaml was not updated (${configFile()}): ${missing.join(', ')} did not change. Your edits are still in the form.`] }
  // Render with the package the config points at; when that is this plugin's stable home and it is stale, refresh it first.
  if (after.config && path.resolve(after.config.paths.package) === path.resolve(homeDir()) && isHomeStale()) syncPackage(true)
  const cli = coordinatorCli(after.config)
  const rendered = await run(node, [cli, 'render'], { timeout: 60000 })
  if (!rendered.ok) return { ok: false, saved: true, errors: ['Saved, but render failed:', ...problemLines(rendered.output)] }
  return { ok: true, saved: true, errors: [], output: lines(rendered.output) }
}

/** Removes one repos entry that is not a git repository; any write of repos drops such entries, read back to check. */
export async function removeSkippedRepo(target: string): Promise<ConfigSave> {
  const node = await findNode()
  if (!node) return { ok: false, saved: false, errors: [NO_NODE] }
  const skipped = await loadSkippedRepos(node)
  if (!skipped.some((repo) => samePath(repo.path, target))) return { ok: false, saved: false, errors: [`${target} is not an ignored repository entry in config.yaml.`] }
  const current = await loadConfigJson(node, false)
  if (!current.config) return { ok: false, saved: false, errors: ['config.yaml could not be read; nothing was written.', ...current.problems] }
  const result = await saveSettings({ repos: current.config.repos ?? [] })
  if (!result.saved) return result
  if ((await loadSkippedRepos(node)).some((repo) => samePath(repo.path, target))) return { ok: false, saved: true, errors: [`config.yaml still lists ${target}.`] }
  return result
}

/**
 * After Orca updates the plugin: refresh the plugin's own files only (the stable home, then the
 * rendered rules and wrappers), and only for a setup this plugin made. Agent links and settings are
 * never written here: stale links are shown in the panel with an "Update links" button.
 */
export async function updateIfInstalledHere(): Promise<{ updated: boolean; output?: string }> {
  if (!existsSync(configFile()) || isSynced()) return { updated: false }
  const config = await readConfig()
  if (!config || path.resolve(config.paths.package) !== path.resolve(homeDir())) return { updated: false }
  const node = await findNode()
  if (!node) return { updated: false }
  syncPackage()
  const result = await run(node, [path.join(homeDir(), 'bin', 'coordinator.mjs'), 'render'], { timeout: 60000 })
  return { updated: result.ok, output: result.output }
}
