// Setting the coordinator up from inside Orca. The plugin is the whole orca-coordinator
// package; Orca keeps each installed version in its own folder, so the package is copied to a
// stable home (the skill link, wrappers and automations point there) and init runs from it.
// Runs on the user's own node, not Orca's: init writes that path into the wrappers.
import { execFile } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdapterKinds, ConfigPatch, ConfigRepo, ConfigRead, ConfigSave, CoordinatorSettings, SetupOptions, SetupRepo, SetupStatus, SetupWorkspace } from './protocol'

/** This plugin's root: src/ → plugin/ → the package. */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE_MARKER = '.installed-from'

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

export type CoordinatorConfig = CoordinatorSettings

const lines = (output: string): string[] => output.split('\n').map((line) => line.trim()).filter(Boolean)

/** `coordinator.mjs config --json` with the user's node; strict also validates. warnings: entries the CLI skipped (a repo that is not a git repository). */
async function loadConfigJson(node: string, strict: boolean): Promise<{ config: CoordinatorConfig | null; problems: string[]; warnings: string[] }> {
  const result = await run(node, [path.join(PACKAGE_DIR, 'bin', 'coordinator.mjs'), 'config', '--json', ...(strict ? [] : ['--lenient'])])
  const warnings = lines(result.stderr).filter((line) => line.startsWith('warning: ')).map((line) => line.slice('warning: '.length))
  if (!result.ok) return { config: null, warnings, problems: lines(result.output).filter((line) => line !== 'orca-coordinator: config invalid:' && !line.startsWith('warning: ')).map((line) => line.replace(/^- /, '').replace(/^orca-coordinator: /, '')) }
  try {
    const config = JSON.parse(result.stdout) as CoordinatorConfig
    // Defence in depth: whatever the CLI version, only git repositories are repos.
    if (Array.isArray(config.repos)) config.repos = await onlyGitRepos(config.repos.filter((repo) => repo && repo.path))
    return { config, problems: [], warnings }
  } catch {
    return { config: null, problems: ['config --json printed something that is not JSON'], warnings }
  }
}

/** The merged config, as the package's own CLI reads it; null when there is none. */
export async function readConfig(): Promise<CoordinatorConfig | null> {
  if (!existsSync(configFile())) return null
  const node = await findNode()
  if (!node) return null
  return (await loadConfigJson(node, false)).config
}

/** A config file exists and the package's own validation accepts it. */
async function isConfigValid(node: string): Promise<boolean> {
  return Boolean(node) && existsSync(configFile()) && (await loadConfigJson(node, true)).config !== null
}

/** The adapter kinds this package ships: adapters/<kind>/<name>.sh, 'none' first. */
export function adapterKinds(): AdapterKinds {
  const names = (kind: string): string[] => {
    try {
      const found = readdirSync(path.join(PACKAGE_DIR, 'adapters', kind)).filter((f) => f.endsWith('.sh')).map((f) => f.slice(0, -3))
      return ['none', ...found.filter((name) => name !== 'none').sort()]
    } catch {
      return ['none']
    }
  }
  return { ticketing: names('ticketing'), chat: names('chat') }
}

async function gitUserName(): Promise<string> {
  const result = await run('git', ['config', '--global', 'user.name'], { timeout: 5000 })
  return result.ok ? result.output.split('\n')[0].trim() : ''
}

async function init(node: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return run(node, [path.join(homeDir(), 'bin', 'coordinator.mjs'), 'init', '--yes', '--no-plugin', ...args], { timeout: 180000 })
}

type Orca = (args: string[]) => Promise<string>

/** Orca's repos and folders, as `orca repo list` gives them. */
export async function listOrcaRepos(orca: Orca): Promise<SetupRepo[]> {
  const response = JSON.parse(await orca(['repo', 'list', '--json'])) as { result?: { repos?: { id?: string; path?: string; displayName?: string; kind?: string }[] } }
  return (response.result?.repos ?? [])
    .filter((repo) => repo.path)
    .map((repo) => ({ id: String(repo.id ?? ''), path: String(repo.path), name: repo.displayName || path.basename(String(repo.path)), folder: repo.kind !== undefined && repo.kind !== 'git' }))
}

/** Orca's git repositories (kind "git"), each confirmed by git: never a plain folder. */
export async function listGitRepos(orca: Orca): Promise<SetupRepo[]> {
  return onlyGitRepos((await listOrcaRepos(orca)).filter((repo) => !repo.folder))
}

/** Where the coordinator can live: the default first (the first folder, else the shortest path), then the rest by path length. */
export function listWorkspaces(repos: SetupRepo[]): SetupWorkspace[] {
  const home = os.homedir()
  const fallback = repos.find((repo) => repo.folder) ?? [...repos].sort((a, b) => a.path.length - b.path.length)[0]
  return [...repos]
    .sort((a, b) => Number(b === fallback) - Number(a === fallback) || Number(b.folder) - Number(a.folder) || a.path.length - b.path.length)
    .map((repo) => ({ path: repo.path, name: repo.path.startsWith(home + '/') ? '~' + repo.path.slice(home.length) : repo.path }))
}

export async function getSetupStatus(orca: Orca): Promise<SetupStatus> {
  const [node, repos, personName] = await Promise.all([findNode(), listOrcaRepos(orca).catch(() => [] as SetupRepo[]), gitUserName()])
  return {
    configured: await isConfigValid(node),
    version: versionOf(PACKAGE_DIR),
    node: Boolean(node),
    // Where the coordinator lives may be a folder; what it watches is git repositories only.
    workspaces: listWorkspaces(repos),
    repos: await onlyGitRepos(repos.filter((repo) => !repo.folder)),
    personName,
    adapters: adapterKinds()
  }
}

/** Checks the setup form before anything is written; returns the init flags or the problems. */
function setupFlags(options: SetupOptions): { args: string[]; problems: string[] } {
  const kinds = adapterKinds()
  const problems: string[] = []
  const workspace = String(options.workspace ?? '')
  if (!workspace || !existsSync(workspace)) problems.push(`workspace not found: ${workspace}`)
  const ticketing = options.ticketing ?? 'none'
  const chat = options.chat ?? 'none'
  if (!kinds.ticketing.includes(ticketing)) problems.push(`ticketing must be one of ${kinds.ticketing.join(', ')}`)
  if (!kinds.chat.includes(chat)) problems.push(`chat must be one of ${kinds.chat.join(', ')}`)
  const issueUrl = String(options.issueUrl ?? '').trim()
  if (ticketing !== 'none' && !issueUrl.includes('{id}')) problems.push('the ticket URL template needs {id}, e.g. https://linear.app/team/issue/{id}')
  const args = ['--workspace', workspace]
  const name = String(options.name ?? '').trim()
  if (name) args.push('--name', name)
  if (options.ticketing) args.push('--ticketing', ticketing)
  if (ticketing !== 'none') args.push('--issue-url', issueUrl)
  if (options.chat) args.push('--chat', chat)
  if (Array.isArray(options.repos)) {
    if (options.repos.length === 0) args.push('--no-repos')
    for (const repo of options.repos) args.push('--repo', String(repo))
  }
  return { args, problems }
}

/** First setup: copy the package home and run init for the chosen workspace and answers. */
export async function runSetup(options: SetupOptions): Promise<{ ok: boolean; output: string }> {
  const node = await findNode()
  if (!node) return { ok: false, output: 'Node.js 20.6 or newer is needed on your PATH (https://nodejs.org).' }
  const { args, problems } = setupFlags(options)
  if (problems.length) return { ok: false, output: problems.join('\n') }
  syncPackage()
  return init(node, args)
}

const expandHome = (value: string): string => (value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value)

/** The patch keys whose value in the re-read config differs from what was saved. */
function notLanded(patch: ConfigPatch, config: CoordinatorConfig | null): string[] {
  if (!config) return ['config.yaml (unreadable after the save)']
  const missing: string[] = []
  const walk = (expected: unknown, actual: unknown, key: string): void => {
    if (key === 'repos') {
      const line = (r: ConfigRepo) => `${r.name}=${path.resolve(expandHome(String(r.path)))} ${JSON.stringify(REPO_BLOCKS.map((key) => (r[key] ? [r[key]?.kind ?? '', r[key]?.issueUrl ?? ''] : null)))}`
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
function coordinatorCli(config: CoordinatorConfig | null): string {
  const own = config?.paths?.package ? path.join(config.paths.package, 'bin', 'coordinator.mjs') : ''
  return own && existsSync(own) ? own : path.join(PACKAGE_DIR, 'bin', 'coordinator.mjs')
}

/** What the settings view shows: the merged config (defaults filled), its problems, and the choices. */
export async function readSettings(orca: Orca): Promise<ConfigRead> {
  const base = { path: configFile(), adapters: adapterKinds(), skippedRepos: [] as ConfigRepo[] }
  const repos = await listGitRepos(orca).catch(() => [] as SetupRepo[])
  if (!existsSync(configFile())) return { ...base, repos, config: null, problems: [`no config at ${configFile()}: set the coordinator up first`] }
  const node = await findNode()
  if (!node) return { ...base, repos, config: null, problems: ['Node.js 20.6 or newer is needed on your PATH (https://nodejs.org).'] }
  // Entries that are not git repositories are not problems to fix by hand: the view offers to remove each.
  const skippedRepos = await loadSkippedRepos(node)
  const strict = await loadConfigJson(node, true)
  if (strict.config) return { ...base, repos, skippedRepos, config: strict.config, problems: [] }
  const lenient = await loadConfigJson(node, false)
  return { ...base, repos, skippedRepos, config: lenient.config, problems: strict.problems }
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

const REPO_BLOCKS = ['ticketing', 'chat'] as const

/** entry with the form's ticketing / chat blocks applied: a block the form names replaces it, null removes it (back to the default). */
function applyBlocks(entry: ConfigRepo, form: ConfigRepo | undefined): ConfigRepo {
  const out: ConfigRepo = { ...entry }
  for (const key of REPO_BLOCKS) {
    if (form && key in form) out[key] = form[key]
    if (out[key] === null) delete out[key]
  }
  return out
}

/**
 * The repos to write: config.yaml's current (git) repos, minus what the form unchecked, plus what
 * it checked, when the form says what it loaded; else the form's list as it is. Either way a
 * repo's ticketing / chat block changes only when the form names it, so other repos keep theirs.
 */
function mergeRepos(current: ConfigRepo[], form: ConfigRepo[], loaded: string[] | undefined): ConfigRepo[] {
  if (!Array.isArray(loaded)) return form.map((repo) => applyBlocks(current.find((c) => samePath(c.path, repo.path)) ?? repo, repo))
  const removed = loaded.filter((p) => !form.some((repo) => samePath(repo.path, p)))
  const added = form.filter((repo) => !loaded.some((p) => samePath(repo.path, p)) && !current.some((c) => samePath(c.path, repo.path)))
  const kept = current.filter((repo) => !removed.some((p) => samePath(repo.path, p)))
  return [...kept.map((repo) => applyBlocks(repo, form.find((f) => samePath(f.path, repo.path)))), ...added.map((repo) => applyBlocks(repo, undefined))]
}

/** The settings the panel may change; everything else (automations, queue, budget) stays config.yaml-only. */
const EDITABLE = ['person', 'repos', 'adapters'] as const

/**
 * Merges the editable settings into config.yaml (validated by the package's CLI), then renders.
 * Nothing is written when validation fails; automations, queue and budget are never touched.
 */
export async function saveSettings(patch: ConfigPatch): Promise<ConfigSave> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, saved: false, errors: ['settings must be an object'] }
  const node = await findNode()
  if (!node) return { ok: false, saved: false, errors: ['Node.js 20.6 or newer is needed on your PATH (https://nodejs.org).'] }
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
  const clean = (output: string): string[] => lines(output).filter((line) => line !== 'config invalid:').map((line) => line.replace(/^- /, '').replace(/^orca-coordinator: /, ''))
  if (!merge.ok) return { ok: false, saved: false, errors: clean(merge.output) }
  // Never trust the exit code alone: read config.yaml back and check every value landed.
  const after = await loadConfigJson(node, false)
  const missing = notLanded(editable, after.config)
  if (missing.length) return { ok: false, saved: false, errors: [`config.yaml was not updated (${configFile()}): ${missing.join(', ')} did not change. Your edits are still in the form.`] }
  // Render with the package the config points at; when that is this plugin's stable home and it is stale, refresh it first.
  if (after.config && path.resolve(after.config.paths.package) === path.resolve(homeDir()) && isHomeStale()) syncPackage(true)
  const cli = coordinatorCli(after.config)
  const rendered = await run(node, [cli, 'render'], { timeout: 60000 })
  if (!rendered.ok) return { ok: false, saved: true, errors: ['Saved, but render failed:', ...clean(rendered.output)] }
  return { ok: true, saved: true, errors: [], output: lines(rendered.output) }
}

/** Removes one repos entry that is not a git repository; any write of repos drops such entries, read back to check. */
export async function removeSkippedRepo(target: string): Promise<ConfigSave> {
  const node = await findNode()
  if (!node) return { ok: false, saved: false, errors: ['Node.js 20.6 or newer is needed on your PATH (https://nodejs.org).'] }
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
 * After Orca updates the plugin: refresh the stable home and re-render, but only for a setup
 * this plugin made (a clone used with setup.sh keeps pointing at the clone).
 */
export async function updateIfInstalledHere(): Promise<{ updated: boolean; output?: string }> {
  if (!existsSync(configFile()) || isSynced()) return { updated: false }
  const config = await readConfig()
  if (!config || path.resolve(config.paths.package) !== path.resolve(homeDir())) return { updated: false }
  const node = await findNode()
  syncPackage()
  const result = await init(node, [])
  return { updated: result.ok, output: result.output }
}

