#!/usr/bin/env node
// orca-coordinator: one entry point to install, render, check and remove the coordinator setup.
//   init        write config.yaml (asks or takes flags), create the state folder, render rules and
//               playbooks, install the skill, load the panel, register automations (opt-in)
//   render      rebuild <state>/COORDINATOR.md, <state>/playbooks/, <state>/panel.json, wrappers
//   config      print the merged config (--json | --shell | --keys | --path | --skipped-repos)
//   doctor      check node, orca, gh, jq, agents, config, state, plugin, automations
//   automations install | remove | list
//   plugin      load | open | unload
//   uninstall   remove what init installed (--purge also deletes config and state)
// Every command accepts --dry-run (print, change nothing) and --yes (no prompts).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import {
  CHAT_KINDS,
  defaultConfigPath,
  defaultOrcaBin,
  defaultStatePath,
  defaults,
  deepMerge,
  detectBase,
  expandHome,
  FLAGS_KINDS,
  isGitRepo,
  loadConfig,
  notGitWarning,
  PACKAGE_ROOT,
  readYamlFile,
  render,
  repoWarnings,
  shellQuote,
  templateValues,
  TICKETING_KINDS,
  toShellExports,
  toYaml,
  validate
} from './lib/config.mjs'
import { adapterFor, adapterTargets, currentRepo, findRepo, REPO_ADAPTERS } from './lib/adapters.mjs'

const argv = process.argv.slice(2)
const command = argv[0]
const DRY = argv.includes('--dry-run')
const YES = argv.includes('--yes')
const FORCE = argv.includes('--force')

function opt(name) {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
function opts(name) {
  const out = []
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1])
  })
  return out
}
const has = (name) => argv.includes(`--${name}`)

// --config <file> applies to every command and to everything they start (board, wrappers, scripts):
// it becomes ORCA_COORDINATOR_CONFIG, which defaultConfigPath() and loadConfig() read.
if (opt('config')) process.env.ORCA_COORDINATOR_CONFIG = path.resolve(expandHome(opt('config')))

const actions = []
function did(verb, what) {
  if (verb === 'fail' && !DRY) process.exitCode = 1
  actions.push(`${DRY ? 'would ' : ''}${verb}: ${what}`)
}

function writeFile(file, content, { executable = false } = {}) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return did('keep', file)
  did(fs.existsSync(file) ? 'update' : 'create', file)
  if (DRY) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (executable) fs.chmodSync(file, 0o755)
}

function ensureDir(dir) {
  if (fs.existsSync(dir)) return
  did('create', `${dir}/`)
  if (!DRY) fs.mkdirSync(dir, { recursive: true })
}

function symlink(target, link) {
  try {
    if (fs.readlinkSync(link) === target) return did('keep', `${link} → ${target}`)
  } catch {
    // not a link, or missing
  }
  if (fs.existsSync(link) || isLink(link)) {
    // A link into another copy of this package (a clone, an older install) is ours to move.
    const previous = isLink(link) ? fs.readlinkSync(link) : ''
    const moved = previous.endsWith(path.join('skill', 'coordinator'))
    if (!FORCE && !moved) return did('skip', `${link} exists and is not ours (use --force to replace)`)
    did(moved ? 'move' : 'replace', `${link} → ${target}`)
    if (!DRY) fs.rmSync(link, { recursive: true, force: true })
  } else did('link', `${link} → ${target}`)
  if (DRY) return
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link)
}

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

function orca(config, args, { json = true } = {}) {
  const bin = config.paths.orca || defaultOrcaBin()
  const result = spawnSync(bin, json ? [...args, '--json'] : args, { encoding: 'utf8', timeout: 30000 })
  if (result.error) throw new Error(`cannot run ${bin}: ${result.error.message}`)
  const out = result.stdout || ''
  if (!json) return { ok: result.status === 0, text: out + (result.stderr || '') }
  try {
    return JSON.parse(out)
  } catch {
    return { ok: result.status === 0, text: out + (result.stderr || '') }
  }
}

/** The first executable file named `bin` on PATH, found without a shell; '' when there is none. */
function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, bin)
    try {
      if (!fs.statSync(file).isFile()) continue
      fs.accessSync(file, fs.constants.X_OK)
      return file
    } catch {
      // not here
    }
  }
  return ''
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

/** ~ for a path under the home folder, so the config file stays portable; anything else as is. */
function tilde(value) {
  const home = os.homedir()
  return typeof value === 'string' && value.startsWith(home + '/') ? '~' + value.slice(home.length) : value
}

// ---- init ----

const QUESTIONS = [
  { key: 'person.name', flag: 'name', ask: 'Your name (how the coordinator addresses you)' },
  { key: 'person.github', flag: 'github', ask: 'Your GitHub login' },
  { key: 'person.language', flag: 'language', ask: 'Language of the drafts it writes for you' },
  { key: 'person.tone', flag: 'tone', ask: 'Tone of those drafts' },
  { key: 'person.uiTermsLanguage', flag: 'ui-language', ask: 'Language UI labels are quoted in' },
  { key: 'paths.workspace', flag: 'workspace', ask: 'Orca workspace folder that hosts the coordinator', choices: listMainWorktrees },
  { key: 'paths.worktreeRoot', flag: 'worktree-root', ask: 'Folder where Orca creates worktrees (cleanup only touches these)' },
  { key: 'agents.coordinator.agent', flag: 'coordinator-agent', ask: 'Agent id for the coordinator (claude, codex, opencode, …)' },
  { key: 'agents.worker.agent', flag: 'worker-agent', ask: 'Agent id for workers' },
  { key: 'agents.automation.provider', flag: 'automation-provider', ask: 'Agent id automations start when no coordinator is live' },
  { key: 'github.org', flag: 'github-org', ask: 'GitHub organisation (owner) of your repos' },
  // Ticketing and chat are detected by the coordinator (MCP servers, CLIs): never asked. These flags
  // only write the optional CLI adapters the zero-model shell prechecks use (advanced).
  { key: 'adapters.ticketing.kind', flag: 'ticketing', ask: `Ticketing tool (${TICKETING_KINDS.join('|')})`, oneOf: TICKETING_KINDS, advanced: true },
  { key: 'adapters.ticketing.team', flag: 'ticketing-team', ask: 'Team or project key in the ticketing tool', advanced: true },
  { key: 'adapters.ticketing.issueUrl', flag: 'issue-url', ask: 'Ticket URL template, {id} for the identifier', advanced: true },
  { key: 'adapters.chat.kind', flag: 'chat', ask: `Chat tool (${CHAT_KINDS.join('|')})`, oneOf: CHAT_KINDS, advanced: true },
  { key: 'adapters.chat.draftOnlyChannels', flag: 'draft-only-channels', ask: 'Channels the bot cannot post in (comma separated, empty for none)', list: true, advanced: true },
  { key: 'adapters.flags.kind', flag: 'flags', ask: `Feature-flag tool (${FLAGS_KINDS.join('|')})`, oneOf: FLAGS_KINDS }
]

function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
function setPath(obj, key, value) {
  const parts = key.split('.')
  let o = obj
  for (const k of parts.slice(0, -1)) o = o[k] ?? (o[k] = {})
  o[parts.at(-1)] = value
}

function listMainWorktrees(config) {
  try {
    const out = orca(config, ['worktree', 'list'])
    const worktrees = out.result?.worktrees ?? []
    return [...new Set(worktrees.filter((w) => w.isMainWorktree).map((w) => w.path))]
  } catch {
    return []
  }
}

/** The folder Orca creates worktrees in: the most common parent of the non-main worktrees. */
function detectWorktreeRoot(config) {
  try {
    const out = orca(config, ['worktree', 'list'])
    const parents = (out.result?.worktrees ?? []).filter((w) => !w.isMainWorktree && w.path).map((w) => path.dirname(path.dirname(w.path)))
    const counts = new Map()
    for (const p of parents) counts.set(p, (counts.get(p) || 0) + 1)
    return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? ''
  } catch {
    return ''
  }
}

/**
 * The Orca workspace for the coordinator: the outermost Orca repo holding the clone, else the one
 * holding the folder init was started from, else that folder (a clone's parent when run inside it).
 */
function detectWorkspace(config) {
  const from = path.resolve(process.env.ORCA_COORDINATOR_CWD || process.cwd())
  const inside = (dir, root) => dir === root || dir.startsWith(root + path.sep)
  let repos = []
  try {
    repos = (orca(config, ['repo', 'list']).result?.repos ?? []).map((r) => r.path).filter(Boolean).sort((a, b) => a.length - b.length)
  } catch {
    // no Orca CLI: fall through
  }
  for (const dir of [PACKAGE_ROOT, from]) {
    const host = repos.find((root) => inside(dir, root))
    if (host) return host
  }
  return inside(from, PACKAGE_ROOT) ? path.dirname(PACKAGE_ROOT) : from
}

function detectGithubLogin() {
  const result = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 15000 })
  return result.status === 0 ? result.stdout.trim() : ''
}

/** Orca's git repositories (never its plain folders), each confirmed by git, base from origin's HEAD. */
function listRepos(config) {
  let listed = []
  try {
    listed = orca(config, ['repo', 'list']).result?.repos ?? []
  } catch {
    return []
  }
  return listed
    .filter((r) => r.path && r.kind !== 'folder' && isGitRepo(r.path))
    .map((r) => ({ name: r.displayName || path.basename(r.path), path: r.path, base: detectBase(r.path) }))
}

function warn(lines) {
  for (const line of lines) console.error(`warning: ${line}`)
}

/** Values given as flags win over everything; returns the keys they set. */
function applyFlags(config) {
  const set = new Set()
  for (const q of QUESTIONS) {
    const value = q.list ? opt(q.flag)?.split(',').map((s) => s.trim()).filter(Boolean) : opt(q.flag)
    if (value === undefined) continue
    setPath(config, q.key, value)
    set.add(q.key)
  }
  return set
}

async function askQuestions(config, rl) {
  for (const q of QUESTIONS) {
    if (q.advanced) continue
    const current = getPath(config, q.key)
    const choices = q.choices ? q.choices(config) : []
    if (choices.length) console.log(`  known: ${choices.join(', ')}`)
    const answer = (await rl.question(`${q.ask} [${Array.isArray(current) ? current.join(',') : current ?? ''}]: `)).trim()
    if (answer === '') continue
    if (q.oneOf && !q.oneOf.includes(answer)) {
      console.log(`  must be one of ${q.oneOf.join('|')}, keeping ${current}`)
      continue
    }
    setPath(config, q.key, q.list ? answer.split(',').map((s) => s.trim()).filter(Boolean) : answer)
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 })
  return result.status === 0 ? result.stdout.trim() : ''
}

/** Two-letter language of the human: macOS preferred language, else LANG/LC_ALL, else Node's locale. */
function detectLanguage() {
  const apple = process.platform === 'darwin' ? /"?([a-z]{2})[-_"]/i.exec(run('defaults', ['read', '-g', 'AppleLanguages']))?.[1] : ''
  const env = /^([a-z]{2})[_.-]/i.exec(process.env.LC_ALL || process.env.LANG || '')?.[1]
  return (apple || env || Intl.DateTimeFormat().resolvedOptions().locale.slice(0, 2) || 'en').toLowerCase()
}

/** The most common GitHub owner among the origin remotes of the repos. */
function detectGithubOrg(repos) {
  const counts = new Map()
  for (const repo of repos) {
    const url = run('git', ['-C', repo.path, 'remote', 'get-url', 'origin'])
    const owner = /github\.com[:/]([^/]+)\//.exec(url)?.[1]
    if (owner) counts.set(owner, (counts.get(owner) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

const KNOWN_AGENTS = ['claude', 'codex', 'opencode']

/** Fill every value the machine can tell, leaving alone what the config file or a flag already set. */
function detectDefaults(config, keep) {
  const free = (key) => !keep(key)
  if (free('person.name')) config.person.name = run('git', ['config', '--global', 'user.name']) || os.userInfo().username
  if (free('person.github')) config.person.github = detectGithubLogin()
  if (free('person.language')) config.person.language = detectLanguage()
  if (free('person.uiTermsLanguage')) config.person.uiTermsLanguage = config.person.language
  if (free('paths.workspace')) config.paths.workspace = detectWorkspace(config)
  if (free('paths.worktreeRoot')) config.paths.worktreeRoot = detectWorktreeRoot(config)
  const agent = KNOWN_AGENTS.find((a) => which(a))
  if (agent) {
    if (free('agents.coordinator.agent')) config.agents.coordinator.agent = agent
    if (free('agents.worker.agent')) config.agents.worker.agent = agent
    if (free('agents.automation.provider')) config.agents.automation.provider = agent
  }
  const ws = config.paths.workspace
  if (free('repos')) config.repos = ws ? listRepos(config).filter((r) => r.path === ws || r.path.startsWith(ws + path.sep)) : []
  if (free('github.org')) config.github.org = detectGithubOrg(config.repos) || config.person.github
  if (free('automations.timezone')) config.automations.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function summary(config) {
  const shown = (p) => tilde(p) || '(none yet)'
  const a = config.adapters
  const rows = [
    ['You', `${config.person.name}${config.person.github ? ` (github: ${config.person.github})` : ''}, language ${config.person.language}`],
    ['Workspace', shown(config.paths.workspace)],
    ['Worktrees', shown(config.paths.worktreeRoot)],
    ['Agent', `${config.agents.coordinator.agent} (coordinator), ${config.agents.worker.agent} (workers)`],
    ['GitHub org', config.github.org || '(none)'],
    ['Repos', config.repos.map((r) => r.name).join(', ') || '(none)'],
    ['Tools', `detected by the coordinator at session start${a.ticketing.kind !== 'none' || a.chat.kind !== 'none' ? ` (CLI adapters for prechecks: ticketing ${a.ticketing.kind}, chat ${a.chat.kind})` : ''}, flags ${a.flags.kind}`],
    ['Skill links', skillLinks(config).join(', ') || '(none)'],
    ['Status line', config.agents.coordinator.statusline ? '~/.claude/settings.json (statusLine, backup kept)' : '(untouched)'],
    ['Automations', `${config.automations.enabled ? 'on' : 'off'} (${config.automations.timezone})`]
  ]
  return rows.map(([k, v]) => `  ${k.padEnd(12)} ${v}`).join('\n')
}

async function init() {
  // npx runs from a cache npm may wipe; the skill link, panel and wrappers would point at nothing.
  if (/[\\/]_npx[\\/]/.test(PACKAGE_ROOT)) {
    console.error('orca-coordinator cannot run from the npx cache: install it from Orca (orca plugin install jdflament/orca-coordinator) or clone it and run ./setup.sh')
    process.exit(2)
  }
  const configPath = defaultConfigPath()
  let config = defaults()
  config.paths.package = PACKAGE_ROOT
  config.paths.state = defaultStatePath()
  const existed = fs.existsSync(configPath)
  if (existed) config = deepMerge(config, readYamlFile(configPath) || {})
  // A flag beats the existing file.
  if (opt('state')) config.paths.state = path.resolve(expandHome(opt('state')))
  // The package running init is the installed one, even when an older install lived elsewhere.
  config.paths.package = PACKAGE_ROOT
  for (const key of ['package', 'state', 'workspace', 'worktreeRoot', 'orca']) config.paths[key] = expandHome(config.paths[key])
  config.repos = (config.repos || []).map((r) => ({ ...r, path: expandHome(r.path || '') }))
  // Only git repositories are repos: an entry that is a plain folder (the workspace, say) is dropped.
  warn(repoWarnings(config))
  config.repos = config.repos.filter((r) => isGitRepo(r.path))
  const fromFile = existed ? readYamlFile(configPath) || {} : {}
  const fromFlags = applyFlags(config)
  if (opt('state')) fromFlags.add('paths.state')
  // --repo <path> (repeatable) picks the watched repos; --no-repos watches none.
  const reposGiven = opts('repo').length > 0 || has('no-repos')
  if (reposGiven) {
    const known = listRepos(config)
    const picked = opts('repo').map((p) => path.resolve(expandHome(p)))
    warn(picked.filter((p) => !isGitRepo(p)).map((p) => notGitWarning({ path: p })))
    config.repos = picked.filter((p) => isGitRepo(p)).map((p) => known.find((r) => r.path === p) ?? { name: path.basename(p), path: p, base: detectBase(p) })
  }
  const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length)
  detectDefaults(config, (key) => (key === 'repos' && reposGiven) || ((fromFlags.has(key) || getPath(fromFile, key) !== undefined) && !empty(getPath(config, key))))
  for (const team of opts('review-team')) if (!config.github.reviewTeams.includes(team)) config.github.reviewTeams.push(team)
  if (opt('branch-pattern')) config.git.branchPattern = opt('branch-pattern')
  if (has('automations')) config.automations.enabled = true
  if (has('statusline')) config.agents.coordinator.statusline = true
  if (has('no-statusline')) config.agents.coordinator.statusline = false
  if (opt('timezone')) config.automations.timezone = opt('timezone')

  // Show what was found; one Enter installs it, "e" walks through every question.
  if (!YES && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    console.log(`\norca-coordinator will install with:\n${summary(config)}\n`)
    const answer = (await rl.question('Press Enter to install, "e" to edit, "q" to quit: ')).trim().toLowerCase()
    if (answer === 'q') {
      rl.close()
      process.exit(0)
    }
    if (answer === 'e') {
      await askQuestions(config, rl)
      console.log(`\n${summary(config)}\n`)
    }
    rl.close()
  }

  const problems = validate(config)
  if (problems.length) {
    console.error(`config incomplete:\n  - ${problems.join('\n  - ')}\nPass the missing values as flags (see --help) or answer the prompts.`)
    process.exit(2)
  }

  const yaml = configForFile(config)
  if (existed && !FORCE) {
    const merged = deepMerge(readYamlFile(configPath) || {}, yaml)
    writeFile(configPath, serialize(merged))
  } else writeFile(configPath, serialize(yaml))

  const configDir = path.dirname(configPath)
  copyTemplate('rules.local.md', path.join(configDir, 'rules.local.md'), config)
  ensureDir(path.join(configDir, 'playbooks.local'))
  copyTemplate('playbooks.local/README.md', path.join(configDir, 'playbooks.local', 'README.md'), config)

  installState(config)
  renderAll(config)
  installSkill(config)
  if (config.agents.coordinator.statusline) installStatusline(config)
  if (!has('no-plugin')) await pluginLoad(config)
  if (config.automations.enabled) automationsInstall(config)

  report()
  console.log(`\nNext: open a terminal in ${config.paths.workspace}, start ${config.agents.coordinator.agent}, and ask it to load the coordinator skill.`)
  console.log(`Config: ${configPath}\nState:  ${config.paths.state}`)
}

/** Serialize with ~ for home paths so the file stays portable. */
function configForFile(config) {
  const out = JSON.parse(JSON.stringify(config))
  for (const key of Object.keys(out.paths)) out.paths[key] = tilde(out.paths[key])
  out.repos = out.repos.map((r) => ({ ...r, path: tilde(r.path) }))
  if (out.agents.worker.permissionsFile) out.agents.worker.permissionsFile = tilde(out.agents.worker.permissionsFile)
  return out
}

function serialize(obj) {
  return `# orca-coordinator config (written by init on ${today()}). Edit freely; run "orca-coordinator render" after.\n` + toYaml(obj)
}

/**
 * config --merge <json>: merge a JSON object into config.yaml (objects merge, arrays replace),
 * validate the result with defaults filled, and write it. Keys the patch does not name, unknown
 * keys included, and the file's leading comment block are kept; other comments are not.
 */
function configMerge(configPath, json) {
  let patch
  try {
    patch = JSON.parse(json)
  } catch (err) {
    throw new Error(`--merge expects JSON: ${err.message}`)
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('--merge expects a JSON object')
  if (!fs.existsSync(configPath)) throw new Error(`no config at ${configPath}: run "orca-coordinator init" first`)
  const original = fs.readFileSync(configPath, 'utf8')
  if (Array.isArray(patch.repos)) {
    const notGit = patch.repos.filter((r) => !r || typeof r !== 'object' || !isGitRepo(expandHome(String(r.path || ''))))
    warn(notGit.map(notGitWarning))
    patch.repos = patch.repos.filter((r) => !notGit.includes(r)).map((r) => ({ ...r, path: tilde(r.path) }))
  }
  const merged = deepMerge(readYamlFile(configPath) || {}, patch)
  const problems = validate(deepMerge(defaults(), merged))
  if (problems.length) {
    console.error(`config invalid:\n  - ${problems.join('\n  - ')}`)
    process.exit(2)
  }
  const header = /^(#[^\n]*\n)+/.exec(original)?.[0] ?? `# orca-coordinator config. Edit freely; run "orca-coordinator render" after.\n`
  writeFile(configPath, header + toYaml(merged))
  report()
}

function copyTemplate(name, target, config) {
  if (fs.existsSync(target)) return did('keep', target)
  const values = { ...templateValues(config), today: today() }
  writeFile(target, render(fs.readFileSync(path.join(PACKAGE_ROOT, 'templates', name), 'utf8'), values, { strict: false }))
}

function installState(config) {
  const state = config.paths.state
  for (const dir of ['', 'reports', 'archive', 'playbooks', 'bin', 'automations', 'automations/state', 'drafts']) ensureDir(path.join(state, dir))
  copyTemplate('state.md', path.join(state, 'state.md'), config)
  copyTemplate('lessons.md', path.join(state, 'lessons.md'), config)
  const board = path.join(state, 'board.json')
  if (!fs.existsSync(board)) {
    did('create', board)
    if (!DRY) runBoard(config, ['init'])
  }
}

function runBoard(config, args) {
  const result = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'board.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, COORDINATOR_BOARD: path.join(config.paths.state, 'board.json') }
  })
  if (result.status !== 0) throw new Error(result.stderr || 'board.mjs failed')
  return result.stdout
}

function renderAll(config) {
  const values = { ...templateValues(config), today: today() }
  const state = config.paths.state
  const configDir = path.dirname(defaultConfigPath())

  // COORDINATOR.md: rules/*.md in order, then rules.local.md.
  const rules = fs.readdirSync(path.join(PACKAGE_ROOT, 'rules')).filter((f) => f.endsWith('.md')).sort()
  const parts = rules.map((f) => render(fs.readFileSync(path.join(PACKAGE_ROOT, 'rules', f), 'utf8'), values, { file: f }))
  const local = path.join(configDir, 'rules.local.md')
  if (fs.existsSync(local)) parts.push(render(fs.readFileSync(local, 'utf8'), values, { strict: false, file: local }))
  writeFile(path.join(state, 'COORDINATOR.md'), `<!-- rendered by orca-coordinator render on ${today()}; edit rules/ or rules.local.md, not this file -->\n\n` + parts.join('\n\n'))

  // Playbooks: template or local override, preamble prepended, local append appended.
  const preamble = render(fs.readFileSync(path.join(PACKAGE_ROOT, 'playbooks', '_preamble.md'), 'utf8'), values, { file: '_preamble.md' })
  const names = new Set(fs.readdirSync(path.join(PACKAGE_ROOT, 'playbooks')).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md').map((f) => f.slice(0, -3)))
  const localDir = path.join(configDir, 'playbooks.local')
  if (fs.existsSync(localDir)) for (const f of fs.readdirSync(localDir)) if (f.endsWith('.md') && !f.endsWith('.append.md') && f !== 'README.md') names.add(f.slice(0, -3))
  for (const name of [...names].sort()) {
    const override = path.join(localDir, `${name}.md`)
    const source = fs.existsSync(override) ? override : path.join(PACKAGE_ROOT, 'playbooks', `${name}.md`)
    let text = render(fs.readFileSync(source, 'utf8'), values, { file: source })
    if (!text.startsWith('---')) text = preamble.replace('<playbook>', name) + '\n---\n\n' + text
    const append = path.join(localDir, `${name}.append.md`)
    if (fs.existsSync(append)) text += '\n' + render(fs.readFileSync(append, 'utf8'), values, { file: append })
    writeFile(path.join(state, 'playbooks', `${name}.md`), text)
  }

  // panel.json: what the panel needs from config without reading yaml, plus the tools record the
  // coordinator wrote (`coordinator tools --set`, read by workers and automation sessions), kept as it is.
  const recorded = readPanelJson(state)
  const kept = Object.fromEntries(['tools', 'detectedAt'].filter((key) => key in recorded).map((key) => [key, recorded[key]]))
  writeFile(path.join(state, 'panel.json'), JSON.stringify({ repoColors: config.board.repoColors || {}, oncallLabel: config.board.oncallLabel || 'oncall', ...kept }, null, 2) + '\n')

  // Wrappers: short scripts the rules, the panel and the human call by a fixed name.
  const pkg = PACKAGE_ROOT
  const env = `COORDINATOR_PACKAGE=${shellQuote(pkg)} COORDINATOR_STATE=${shellQuote(state)} COORDINATOR_BOARD=${shellQuote(path.join(state, 'board.json'))} ORCA_COORDINATOR_CONFIG=${shellQuote(defaultConfigPath())}`
  const wrap = (name, body) => writeFile(path.join(state, 'bin', name), `#!/usr/bin/env bash\n# generated by orca-coordinator render\nexport ${env}\n${body}\n`, { executable: true })
  wrap('board', `exec ${shellQuote(process.execPath)} ${shellQuote(path.join(pkg, 'bin', 'board.mjs'))} "$@"`)
  wrap('cleanup', `exec bash ${shellQuote(path.join(pkg, 'bin', 'cleanup.sh'))} "$@"`)
  wrap('metrics', `exec bash ${shellQuote(path.join(pkg, 'bin', 'metrics.sh'))} "$@"`)
  wrap('lessons', `exec bash ${shellQuote(path.join(pkg, 'bin', 'lessons.sh'))} "$@"`)
  wrap('state', `exec bash ${shellQuote(path.join(pkg, 'bin', 'state.sh'))} "$@"`)
  wrap('coordinator', `exec ${shellQuote(process.execPath)} ${shellQuote(path.join(pkg, 'bin', 'coordinator.mjs'))} "$@"`)
  // ticketing / chat [--repo <name>] <args>: the adapter of that repo (else of the folder it runs in, else the default).
  for (const kind of REPO_ADAPTERS) {
    wrap(
      kind,
      [
        'repo="${COORDINATOR_REPO:-}"',
        'if [ "${1:-}" = "--repo" ]; then repo="${2:?repo name}"; shift 2; fi',
        `cmd="$(COORDINATOR_REPO="$repo" ${shellQuote(process.execPath)} ${shellQuote(path.join(pkg, 'bin', 'coordinator.mjs'))} adapter ${kind} --cmd)" || exit 3`,
        'COORDINATOR_REPO="$repo" exec bash "$cmd" "$@"'
      ].join('\n')
    )
  }

  // Route scripts for automations (one per job), used as Orca prechecks.
  for (const job of config.automations.jobs || []) {
    wrap(`../automations/route-${job.playbook}.sh`, `exec bash ${shellQuote(path.join(pkg, 'bin', 'route.sh'))} ${shellQuote(job.playbook)} ${shellQuote(job.precheck || 'none')}`)
  }
}

const SKILL_DIRS = [
  { agent: 'claude', dir: '~/.claude/skills/coordinator' },
  { agent: 'opencode', dir: '~/.config/opencode/skills/coordinator' },
  { agent: 'agents', dir: '~/.agents/skills/coordinator' }
]

/**
 * Links the skill into the agents' skills folders. Only what was asked for: --skill-agent <id>
 * (repeatable), else the coordinator's own agent; --no-skill-link links nothing; --skill-dir <dir>
 * adds a folder. A folder that merely exists is never linked into.
 */
function skillAgents(config) {
  return new Set(has('no-skill-link') ? [] : opts('skill-agent').length ? opts('skill-agent') : [config.agents.coordinator.agent])
}

/** The folders installSkill will link into, as shown before the user confirms. */
function skillLinks(config) {
  const wanted = skillAgents(config)
  return [...SKILL_DIRS.filter((entry) => wanted.has(entry.agent)).map((entry) => entry.dir), ...opts('skill-dir')]
}

function installSkill(config) {
  const target = path.join(PACKAGE_ROOT, 'skill', 'coordinator')
  const wanted = skillAgents(config)
  for (const entry of SKILL_DIRS) if (wanted.has(entry.agent)) symlink(target, expandHome(entry.dir))
  for (const dir of opts('skill-dir')) symlink(target, expandHome(dir))
  if (wanted.has('codex')) did('note', `codex reads no skills folder: paste ${target}/SKILL.md into ~/.codex/AGENTS.md`)
}

function installStatusline(config) {
  const agent = config.agents.coordinator.agent
  if (agent !== 'claude') return did('note', `status line: no installer for ${agent}; run ${path.join(PACKAGE_ROOT, 'bin', 'statusline.sh')} from its status-line hook`)
  const settingsFile = expandHome('~/.claude/settings.json')
  const exists = fs.existsSync(settingsFile)
  let settings = {}
  if (exists) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    } catch (err) {
      // Rewriting a file we cannot read would drop the human's settings.
      return did('fail', `${settingsFile} is not valid JSON (${err.message}): status line not installed, file left as is`)
    }
  }
  const script = path.join(PACKAGE_ROOT, 'bin', 'statusline.sh')
  const current = settings.statusLine?.command
  if (current === script) return did('keep', `${settingsFile} statusLine`)
  if (current) writeFile(path.join(config.paths.state, 'statusline-chain'), current + '\n')
  did(current ? 'update' : 'create', `${settingsFile} statusLine → ${script}${current ? ' (previous command chained)' : ''}`)
  if (DRY) return
  if (exists) fs.copyFileSync(settingsFile, `${settingsFile}.bak-${today()}`)
  else fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  settings.statusLine = { type: 'command', command: script }
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n')
}

// ---- plugin ----

const PLUGIN_ID = 'coordinator-board'

/** The panel plugin Orca has, whatever its publisher: `local` from a folder, the owner from GitHub. */
function findPlugin(config) {
  return (orca(config, ['plugin', 'list']).result?.plugins ?? []).find((p) => p.pluginKey === `local.${PLUGIN_ID}` || p.pluginKey?.endsWith(`.${PLUGIN_ID}`))
}

/**
 * Install the panel through Orca's own plugin installer from this package (the repo root is the
 * plugin). A panel Orca installed from GitHub or a catalog is Orca's to update: leave it. Re-installs
 * a folder install only when the files changed, and replaces a development load.
 */
async function pluginLoad(config) {
  const dir = PACKAGE_ROOT
  const mine = findPlugin(config)
  if (mine && mine.publisher !== 'local' && !FORCE) return did('keep', `plugin ${mine.pluginKey} (installed by Orca from ${mine.source?.reference ?? 'its catalog'}; update it from Orca)`)
  const marker = path.join(config.paths.state, 'plugin-folder')
  const ours = fs.existsSync(marker)
  const hash = orca(config, ['plugin', 'inspect', dir]).result?.contentHash
  if (mine && !mine.isDev && hash && mine.source?.contentHash === hash) return did('keep', `plugin ${mine.pluginKey} (installed, up to date)`)
  if (mine && !ours && !FORCE) return did('skip', `a plugin ${mine.pluginKey} is already in Orca and was not installed by this package; re-run with --force to replace it`)
  if (mine?.isDev) {
    did('unload', `plugin ${mine.pluginKey} development folder (replaced by an install)`)
    if (!DRY) orca(config, ['plugin', 'dev', 'unload', mine.pluginKey])
  }
  did(mine && !mine.isDev ? 'update' : 'install', `plugin ${dir}`)
  if (DRY) return
  let out = orca(config, ['plugin', 'install', dir])
  const fingerprint = out.error?.data?.approvalFingerprint || /--approve\s+([\w+/=:-]+)/.exec(out.error?.message ?? out.text ?? '')?.[1]
  if (out.ok === false && fingerprint) {
    did('note', `the panel needs your approval in Orca: it runs a small worker that reads the state folder and calls the Orca CLI`)
    if (!YES && !(await confirm('Approve the Coordinator board panel in Orca? [Y/n] '))) return did('note', `approve later with: ${config.paths.orca} plugin install ${dir} --approve ${fingerprint}`)
    out = orca(config, ['plugin', 'install', dir, '--approve', fingerprint])
  }
  if (out.ok === false) return did('fail', `plugin install: ${out.error?.message ?? JSON.stringify(out).slice(0, 200)}`)
  // Only a successful install makes the plugin ours to update or remove later.
  writeFile(marker, dir + '\n')
  const key = out.result?.plugin?.pluginKey ?? out.result?.pluginKey ?? `local.${PLUGIN_ID}`
  orca(config, ['plugin', 'open', key, '--panel', PLUGIN_ID])
  did('open', 'panel Coordinator board')
  if (config.paths.state !== defaultStatePath()) did('note', `set the plugin setting "Coordinator state folder" to ${config.paths.state} (Settings → Plugins)`)
}

/** Ask yes/no on a terminal; no terminal means no. Empty answer means yes. */
async function confirm(question) {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(question)).trim().toLowerCase()
  rl.close()
  return answer === '' || answer === 'y' || answer === 'yes'
}

function pluginUnload(config) {
  const mine = findPlugin(config)
  if (!mine) return did('skip', 'plugin not installed')
  const marker = path.join(config.paths.state, 'plugin-folder')
  if (!fs.existsSync(marker) && mine.publisher === 'local' && !FORCE) return did('skip', `plugin ${mine.pluginKey} was not installed by this package (use --force to remove it anyway)`)
  did('remove', `plugin ${mine.pluginKey}`)
  if (DRY) return
  orca(config, mine.isDev ? ['plugin', 'dev', 'unload', mine.pluginKey] : ['plugin', 'uninstall', mine.pluginKey])
  if (fs.existsSync(marker)) fs.unlinkSync(marker)
}

// ---- automations ----

function automationName(job) {
  return `${job.name || job.playbook} · ${job.playbook}`
}

function existingAutomations(config) {
  const list = orca(config, ['automations', 'list'])
  return list.result?.automations ?? []
}

/** The playbook an automation was registered for by this package, or null when it is not ours. */
function playbookOf(automation) {
  const fromPrompt = /^\[trigger\] ([\w-]+)$/.exec(automation.prompt ?? '')?.[1]
  if (fromPrompt) return fromPrompt
  // Older listings may omit the prompt: fall back to the name this package writes.
  return automation.prompt === undefined ? / · ([\w-]+)$/.exec(automation.name ?? '')?.[1] ?? null : null
}

function findAutomation(existing, job) {
  return existing.find((a) => a.name === automationName(job)) ?? existing.find((a) => playbookOf(a) === job.playbook)
}

function automationArgs(config, job) {
  return [
    '--name', automationName(job),
    '--trigger', job.schedule,
    '--prompt', `[trigger] ${job.playbook}`,
    '--provider', config.agents.automation.provider,
    '--precheck', path.join(config.paths.state, 'automations', `route-${job.playbook}.sh`),
    '--precheck-timeout', '120',
    '--workspace', `path:${config.paths.workspace}`,
    '--timezone', config.automations.timezone || 'UTC',
    '--missed-run-grace-minutes', String(config.automations.graceMinutes ?? 720),
    '--reuse-session'
  ]
}

/**
 * Make Orca match config: create missing jobs, push a changed name or schedule to the registered
 * automation, remove jobs turned off or gone from config. Automations this package did not
 * register (their prompt is not "[trigger] <playbook>") are never touched.
 */
function automationsInstall(config) {
  const existing = existingAutomations(config)
  const jobs = config.automations.jobs || []
  for (const job of jobs) {
    const name = automationName(job)
    const found = findAutomation(existing, job)
    if (job.enabled === false) {
      if (!found) continue
      did('remove', `automation "${found.name}" (turned off)`)
      if (!DRY) orca(config, ['automations', 'remove', found.id])
      continue
    }
    if (found) {
      const schedule = found.trigger ?? found.schedule
      if (found.name === name && schedule === job.schedule) {
        did('keep', `automation "${name}"`)
        continue
      }
      did('update', `automation "${name}" (${job.schedule}, precheck ${job.precheck || 'none'})`)
      if (DRY) continue
      const out = orca(config, ['automations', 'edit', found.id, ...automationArgs(config, job)])
      if (out.ok === false) did('fail', `automation "${name}": ${out.error?.message ?? 'unknown error'}`)
      continue
    }
    did('create', `automation "${name}" (${job.schedule}, precheck ${job.precheck || 'none'})`)
    if (DRY) continue
    const out = orca(config, ['automations', 'create', ...automationArgs(config, job), '--enabled'])
    if (out.ok === false) did('fail', `automation "${name}": ${out.error?.message ?? 'unknown error'}`)
  }
  const wanted = new Set(jobs.map((j) => j.playbook))
  for (const a of existing) {
    const playbook = playbookOf(a)
    if (!playbook || wanted.has(playbook)) continue
    did('remove', `automation "${a.name}" (no longer in config)`)
    if (!DRY) orca(config, ['automations', 'remove', a.id])
  }
}

function automationsRemove(config) {
  for (const a of existingAutomations(config)) {
    if (!playbookOf(a)) continue
    did('remove', `automation "${a.name}"`)
    if (!DRY) orca(config, ['automations', 'remove', a.id])
  }
}

function automationsList(config) {
  const existing = existingAutomations(config)
  for (const job of config.automations.jobs || []) {
    const found = findAutomation(existing, job)
    console.log(`${found ? '✓' : '·'} ${job.playbook.padEnd(22)} ${job.schedule.padEnd(20)} precheck ${job.precheck || 'none'}${found ? `  (${found.enabled ? 'enabled' : 'disabled'}, next ${found.nextRunAt ? new Date(found.nextRunAt).toISOString() : '-'})` : '  (not registered)'}`)
  }
}

/** <state>/panel.json as an object; {} when missing or corrupt. */
function readPanelJson(state) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(state, 'panel.json'), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * tools: print the coordinator's tools record (panel.json). tools --set "Linear:mcp,GitHub:gh":
 * replace it (names and how they are reached only, never a token), stamped with detectedAt. The
 * panel does not show it; `tools` prints it for workers and automation sessions. Other panel.json keys are kept.
 */
function toolsCommand(config) {
  const state = config.paths.state
  const panel = readPanelJson(state)
  const spec = opt('set')
  if (spec === undefined) return console.log(JSON.stringify({ tools: panel.tools ?? null, detectedAt: panel.detectedAt ?? null }, null, 2))
  const tools = []
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, via = 'agent'] = part.split(':').map((s) => s.trim())
    if (!name || name.length > 40 || via.length > 40 || /[\u0000-\u001f]/.test(part)) throw new Error(`tools --set: bad entry "${part}" (expected Name:via, e.g. Linear:mcp)`)
    if (!tools.some((t) => t.name.toLowerCase() === name.toLowerCase())) tools.push({ name, via: via || 'agent' })
  }
  writeFile(path.join(state, 'panel.json'), JSON.stringify({ ...panel, tools, detectedAt: new Date().toISOString() }, null, 2) + '\n')
  report()
}

/**
 * adapter <ticketing|chat> [--repo <name>]: the resolved block for that repo (else the one holding
 * the current folder, else the default) as JSON; --cmd: only its script; --targets: one line per
 * distinct setup across the default and the repos, "<repo, - for the default>\t<kind>\t<script>".
 */
function adapterCommand(config, kind) {
  if (!REPO_ADAPTERS.includes(kind)) throw new Error(`usage: adapter ${REPO_ADAPTERS.join('|')} [--repo <name>] [--cmd | --targets]`)
  if (has('targets')) {
    for (const target of adapterTargets(config, kind)) console.log(`${target.repo || '-'}\t${target.adapter.kind}\t${target.adapter.cmd}`)
    return
  }
  let repo
  if (opt('repo') !== undefined) {
    repo = findRepo(config, opt('repo'))
    if (!repo) throw new Error(`unknown repo: ${opt('repo')} (not in config.yaml repos)`)
  } else repo = currentRepo(config)
  const resolved = adapterFor(config, kind, repo)
  console.log(has('cmd') ? resolved.cmd : JSON.stringify({ repo: repo?.name ?? '', ...resolved }, null, 2))
}

// ---- doctor ----

function doctor() {
  const checks = []
  const ok = (name, pass, detail = '') => checks.push(`${pass ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`)
  const major = Number(process.versions.node.split('.')[0])
  ok('node ≥ 20', major >= 20, process.versions.node)
  let config = null
  let problems = []
  try {
    const loaded = loadConfig({ strict: false })
    config = loaded.config
    problems = loaded.problems
    ok('config', loaded.sources.length > 0 && problems.length === 0, loaded.sources.length ? loaded.sources.join(', ') + (problems.length ? ` (${problems.join('; ')})` : '') : 'missing, run init')
    for (const warning of loaded.warnings) checks.push(`! ${warning}`)
  } catch (err) {
    ok('config', false, err.message)
  }
  const orcaBin = config?.paths.orca || defaultOrcaBin()
  const version = spawnSync(orcaBin, ['--version'], { encoding: 'utf8' })
  ok('orca CLI', version.status === 0, version.status === 0 ? `${orcaBin} ${version.stdout.trim()}` : `${orcaBin} not runnable`)
  if (version.status === 0) {
    const status = orca({ paths: { orca: orcaBin } }, ['status'])
    ok('orca app reachable', status.ok !== false, status.ok === false ? status.error?.message ?? '' : '')
  }
  for (const tool of ['gh', 'jq', 'git']) ok(tool, Boolean(which(tool)), which(tool) || 'not on PATH')
  if (config) {
    for (const [role, agent] of [['coordinator', config.agents.coordinator.agent], ['worker', config.agents.worker.agent], ['automation', config.agents.automation.provider]]) {
      const bin = which(agent)
      ok(`${role} agent "${agent}"`, true, bin ? bin : 'not on PATH (fine when Orca launches it by id)')
    }
    ok('workspace', fs.existsSync(config.paths.workspace), config.paths.workspace)
    ok('state folder', fs.existsSync(path.join(config.paths.state, 'state.md')), config.paths.state)
    const rendered = fs.existsSync(path.join(config.paths.state, 'COORDINATOR.md'))
    ok('rendered rules', rendered, rendered ? path.join(config.paths.state, 'COORDINATOR.md') : 'missing, run render')
    const skill = SKILL_DIRS.map((e) => expandHome(e.dir)).filter((d) => isLink(d) || fs.existsSync(d))
    ok('skill installed', skill.length > 0, skill.join(', ') || 'no agent skills folder links to skill/coordinator')
    if (config.agents.coordinator.statusline && config.agents.coordinator.agent === 'claude') {
      // Orca leaves a user statusLine alone, but anything else may replace it: say so, and how to re-chain.
      let current = null
      try {
        current = JSON.parse(fs.readFileSync(expandHome('~/.claude/settings.json'), 'utf8')).statusLine?.command ?? null
      } catch {
        // missing or unreadable: reported as not installed
      }
      const script = path.join(PACKAGE_ROOT, 'bin', 'statusline.sh')
      ok('status line', current === script, current === script ? script : `~/.claude/settings.json statusLine is ${current ? 'another command' : 'not set'}; run "orca-coordinator statusline" to chain it`)
    }
    if (version.status === 0) {
      const mine = findPlugin(config)
      ok('panel plugin', Boolean(mine), mine ? `${mine.pluginKey} ${mine.status}${mine.isDev ? ' (development folder)' : ''} from ${mine.source?.reference ?? mine.devPath ?? 'Orca'}` : 'not installed (install it from Orca, or plugin load)')
      const existing = existingAutomations(config)
      const registered = (config.automations.jobs || []).filter((j) => findAutomation(existing, j))
      ok('automations', !config.automations.enabled || registered.length === config.automations.jobs.length, `${registered.length}/${config.automations.jobs.length} registered${config.automations.enabled ? '' : ' (disabled in config)'}`)
    }
    for (const kind of REPO_ADAPTERS) {
      for (const target of adapterTargets(config, kind)) {
        const script = path.join(PACKAGE_ROOT, 'adapters', kind, `${target.adapter.kind}.sh`)
        ok(`${kind} adapter${target.repos.length ? ` (${target.repos.join(', ')})` : ''}`, fs.existsSync(script), script)
      }
    }
  }
  console.log(checks.join('\n'))
  process.exitCode = checks.some((c) => c.startsWith('✗')) ? 1 : 0
}

// ---- uninstall ----

async function uninstall() {
  // Purging deletes reports, lessons and config: without a terminal to ask on, only --yes allows it.
  if (has('purge') && !YES && !DRY && !process.stdin.isTTY) {
    throw new Error('uninstall --purge deletes the state folder and the config: no terminal to confirm on, re-run with --yes (nothing was changed)')
  }
  const { config } = loadConfig({ strict: false })
  const configPath = defaultConfigPath()
  const configDir = path.dirname(configPath)
  automationsRemove(config)
  pluginUnload(config)
  const target = path.join(PACKAGE_ROOT, 'skill', 'coordinator')
  for (const entry of SKILL_DIRS) {
    const link = expandHome(entry.dir)
    try {
      if (fs.readlinkSync(link) === target) {
        did('unlink', link)
        if (!DRY) fs.unlinkSync(link)
      }
    } catch {
      // not ours
    }
  }
  const settingsFile = expandHome('~/.claude/settings.json')
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    if (settings.statusLine?.command === path.join(PACKAGE_ROOT, 'bin', 'statusline.sh')) {
      const chain = path.join(config.paths.state, 'statusline-chain')
      const previous = fs.existsSync(chain) ? fs.readFileSync(chain, 'utf8').trim() : ''
      did('restore', `${settingsFile} statusLine${previous ? ` → ${previous}` : ' (removed)'}`)
      if (!DRY) {
        if (previous) settings.statusLine = { type: 'command', command: previous }
        else delete settings.statusLine
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n')
      }
    }
  } catch {
    // no settings file
  }
  const bin = path.join(config.paths.state, 'bin')
  if (fs.existsSync(bin)) {
    did('remove', `${bin}/ (wrappers)`)
    if (!DRY) fs.rmSync(bin, { recursive: true, force: true })
  }
  if (has('purge')) {
    if (!YES && !DRY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const answer = (await rl.question(`Delete ${config.paths.state} and ${configPath}? This removes state.md, reports, lessons and your config. [y/N] `)).trim().toLowerCase()
      rl.close()
      if (answer !== 'y') return report()
    }
    did('delete', config.paths.state)
    if (!DRY) fs.rmSync(config.paths.state, { recursive: true, force: true })
    // The config file and what init put next to it; the folder only when nothing else is left in it.
    for (const file of [configPath, path.join(configDir, 'rules.local.md'), path.join(configDir, 'playbooks.local')]) {
      if (!fs.existsSync(file)) continue
      did('delete', file)
      if (!DRY) fs.rmSync(file, { recursive: true, force: true })
    }
    if (!DRY && fs.existsSync(configDir) && fs.readdirSync(configDir).length === 0) fs.rmdirSync(configDir)
  } else did('keep', `${config.paths.state} and ${configPath} (use --purge to delete them)`)
  report()
}

function report() {
  console.log(actions.length ? actions.join('\n') : 'nothing to do')
}

function usage() {
  console.log(`orca-coordinator <command> [--dry-run] [--yes]

  init         write config, create state, render, install skill, load panel, register automations
               flags: --name --github --language --tone --ui-language --workspace --worktree-root
                      --coordinator-agent --worker-agent --automation-provider --github-org
                      --review-team <team> (repeatable) --branch-pattern --flags <kind>
                      advanced (CLI adapters for shell prechecks; tools are detected otherwise):
                      --ticketing <kind> --ticketing-team --issue-url --chat <kind> --draft-only-channels a,b
                      --repo <path> (repeatable) | --no-repos
                      --automations --statusline | --no-statusline --timezone --no-plugin
                      --skill-agent <claude|opencode|agents|codex> (repeatable; default: the coordinator's agent)
                      --no-skill-link | --skill-dir <dir>
                      --config <file> --state <dir> --force
  render       rebuild COORDINATOR.md, playbooks/, panel.json and the bin wrappers from config
  tools        print the tools the coordinator recorded; --set "Linear:mcp,GitHub:gh" records them (names only)
  adapter      ticketing|chat [--repo <name>] [--cmd | --targets]: the optional CLI adapter a repo's prechecks use
  config       print the merged config: --json | --shell | --keys | --path | --skipped-repos (non-git repos entries, ignored)
               --merge '<json>': merge into config.yaml (arrays replace), validate, write
  doctor       check the installation
  statusline   install (or re-chain) the ◆ COORDINATOR / WORKER status line badge, nothing else
  automations  install | remove | list
  plugin       load | open | unload
  uninstall    remove automations, plugin, skill links, wrappers (--purge: also config and state)
  paths        print the folders this install uses`)
}

async function main() {
  switch (command) {
    case 'init':
      return init()
    case 'render': {
      const { config, warnings } = loadConfig()
      warn(warnings)
      renderAll(config)
      return report()
    }
    case 'config': {
      if (opt('merge') !== undefined) return configMerge(defaultConfigPath(), opt('merge'))
      const { config, sources, configPath, warnings, skippedRepos } = loadConfig({ strict: !has('lenient') })
      // The repos entries ignored because they are not git repositories, as JSON (the panel offers to remove them).
      if (has('skipped-repos')) return console.log(JSON.stringify(skippedRepos))
      warn(warnings)
      if (has('path')) return console.log(configPath)
      if (has('shell')) return process.stdout.write(toShellExports(config))
      if (has('keys')) return console.log(Object.keys(templateValues(config)).sort().join('\n'))
      if (has('json')) return console.log(JSON.stringify(config, null, 2))
      console.log(`# sources: ${sources.join(', ') || 'defaults only'}\n${toYaml(configForFile(config))}`)
      return
    }
    case 'paths': {
      const { config } = loadConfig({ strict: false })
      const values = templateValues(config)
      for (const key of Object.keys(values).filter((k) => k.startsWith('paths.') || k === 'configPath').sort()) console.log(`${key.padEnd(26)} ${values[key]}`)
      return
    }
    case 'doctor':
      return doctor()
    case 'statusline': {
      // Only the status line step of init: chain whatever statusLine is set now, point it at ours.
      const { config } = loadConfig({ strict: false })
      installStatusline(config)
      return report()
    }
    case 'adapter': {
      const { config } = loadConfig()
      return adapterCommand(config, argv[1])
    }
    case 'tools': {
      const { config } = loadConfig({ strict: false })
      return toolsCommand(config)
    }
    case 'automations': {
      const { config } = loadConfig()
      const sub = argv[1]
      if (sub === 'install') {
        renderAll(config)
        automationsInstall(config)
      } else if (sub === 'remove') automationsRemove(config)
      else if (sub === 'list') return automationsList(config)
      else throw new Error('usage: automations install | remove | list')
      return report()
    }
    case 'plugin': {
      const { config } = loadConfig()
      const sub = argv[1]
      if (sub === 'load') await pluginLoad(config)
      else if (sub === 'unload') pluginUnload(config)
      else if (sub === 'open') {
        const mine = findPlugin(config)
        if (!mine) throw new Error('the panel plugin is not installed')
        orca(config, ['plugin', 'open', mine.pluginKey, '--panel', PLUGIN_ID])
        did('open', 'panel')
      } else throw new Error('usage: plugin load | open | unload')
      return report()
    }
    case 'uninstall':
      return uninstall()
    case undefined:
    case 'help':
    case '--help':
      return usage()
    default:
      throw new Error(`unknown command: ${command}`)
  }
}

main().catch((err) => {
  console.error(`orca-coordinator: ${err.message}`)
  process.exit(1)
})
