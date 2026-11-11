// Which ticketing and chat tool a repository uses. Ticketing and chat belong to the project, not
// to the person: a repos[] entry may carry its own `ticketing` / `chat` block, the top-level
// `adapters` block is the default for the others, and a repository's own .orca-coordinator.yaml
// (at its root) wins over both. Every consumer resolves through adapterFor().
import fs from 'node:fs'
import path from 'node:path'
import { deepMerge, defaults, PACKAGE_ROOT, readYamlFile } from './config.mjs'

/** The adapter kinds a repository can override (flags stay global). */
export const REPO_ADAPTERS = ['ticketing', 'chat']

/** A layer over a block: merged when it keeps the block's tool, else over the built-in defaults of the new tool (no stray team, URL or channels). */
function layer(kind, block, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return block
  if (over.kind && over.kind !== block.kind) return deepMerge(defaults().adapters[kind], over)
  return deepMerge(block, over)
}

/** The repository's own .orca-coordinator.yaml adapters block for kind, if any. */
function projectBlock(repo, kind) {
  const file = repo?.path ? path.join(repo.path, '.orca-coordinator.yaml') : ''
  if (!file || !fs.existsSync(file)) return undefined
  try {
    return readYamlFile(file)?.adapters?.[kind]
  } catch {
    return undefined
  }
}

/** The configured repo named or located by ref (a name, or a path inside it: the deepest match). */
export function findRepo(config, ref) {
  if (!ref) return null
  const repos = config.repos || []
  const byName = repos.find((repo) => repo.name === ref)
  if (byName) return byName
  // Only something written as a path is a path: a mistyped name is unknown, never "the repo I am in".
  if (!/[\\/]/.test(String(ref)) && !String(ref).startsWith('.')) return null
  const target = path.resolve(String(ref))
  const inside = (dir) => target === path.resolve(dir) || target.startsWith(path.resolve(dir) + path.sep)
  return repos.filter((repo) => repo.path && inside(repo.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null
}

/** The repo a script acts on: $COORDINATOR_REPO (name or path; unknown throws), else the one holding cwd; null for the default. */
export function currentRepo(config, env = process.env, cwd = process.cwd()) {
  if (!env.COORDINATOR_REPO) return findRepo(config, cwd)
  const repo = findRepo(config, env.COORDINATOR_REPO)
  // Never fall back to another project's tool for a repo that is named but unknown.
  if (!repo) throw new Error(`unknown repo: ${env.COORDINATOR_REPO} (not in config.yaml repos)`)
  return repo
}

/**
 * The resolved adapter block for kind ('ticketing' | 'chat') in repo (an entry, a name, or null for
 * the default), with `cmd`: the adapters/<kind>/<name>.sh script to run.
 */
export function adapterFor(config, kind, repo) {
  if (!REPO_ADAPTERS.includes(kind)) throw new Error(`adapter kind must be one of ${REPO_ADAPTERS.join('|')}`)
  const entry = typeof repo === 'string' ? findRepo(config, repo) : repo
  let block = config.adapters[kind]
  block = layer(kind, block, entry?.[kind])
  block = layer(kind, block, projectBlock(entry, kind))
  const pkg = config.paths?.package || PACKAGE_ROOT
  return { ...block, cmd: path.join(pkg, 'adapters', kind, `${block.kind}.sh`) }
}

/** The config with adapters.ticketing / adapters.chat replaced by what repo resolves to. */
export function withRepoAdapters(config, repo) {
  if (!repo) return config
  const adapters = { ...config.adapters }
  for (const kind of REPO_ADAPTERS) {
    const { cmd, ...block } = adapterFor(config, kind, repo)
    adapters[kind] = block
  }
  return { ...config, adapters }
}

/**
 * The distinct setups of kind across the default and every repo: one target per different
 * resolved block, with the repos that use it (repo: the first of them, '' for the default).
 */
export function adapterTargets(config, kind) {
  const targets = []
  const add = (repo) => {
    const resolved = adapterFor(config, kind, repo)
    const key = JSON.stringify(resolved)
    const found = targets.find((t) => t.key === key)
    if (found) return repo && found.repos.push(repo.name)
    targets.push({ key, repo: repo?.name ?? '', repos: repo ? [repo.name] : [], adapter: resolved })
  }
  add(null)
  for (const repo of config.repos || []) add(repo)
  return targets.map(({ key, ...target }) => target)
}
