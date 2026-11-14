#!/usr/bin/env node
// Coordinator board: the single file the Orca panel reads (schema/board.schema.json).
// Agent-agnostic CLI: any agent (OpenCode, Claude, Codex, a human) edits the board
// through this script so the shape stays valid and BOARD.md stays in sync.
//
// Board file: $COORDINATOR_BOARD, else <paths.state>/board.json from config.yaml,
// else ./board/board.json. Run without arguments for the command list.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './lib/config.mjs'
import { validateAgainst } from './lib/validate.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'board.schema.json'), 'utf8'))

function resolveBoardFile() {
  if (process.env.COORDINATOR_BOARD) return path.resolve(process.env.COORDINATOR_BOARD)
  try {
    const { config } = loadConfig({ strict: false })
    if (config.paths.state) return path.join(config.paths.state, 'board.json')
  } catch {
    // fall through to the local default
  }
  return path.join(ROOT, 'board', 'board.json')
}

const BOARD_FILE = resolveBoardFile()
const STATE_DIR = process.env.COORDINATOR_STATE || path.dirname(BOARD_FILE)
const BOARD_MD = path.join(path.dirname(BOARD_FILE), 'BOARD.md')
const INBOX_FILE = path.join(path.dirname(BOARD_FILE), 'inbox.jsonl')
const INBOX_REJECTED = path.join(path.dirname(BOARD_FILE), 'inbox.rejected.jsonl')

const VERSION = 2
const LOG_KEPT = 20
const enumOf = (p) => p.enum
const TASK_STATES = enumOf(SCHEMA.properties.tasks.items.properties.status)
const WS_STATES = enumOf(SCHEMA.properties.workstreams.items.properties.status)
const AGENT_STATES = enumOf(SCHEMA.properties.agents.items.properties.state)
const REPO_STATES = enumOf(SCHEMA.properties.repos.items.properties.status)
const REPO_KINDS = enumOf(SCHEMA.properties.repos.items.properties.kind)
const INSTRUCTION_STATES = enumOf(SCHEMA.properties.instructions.items.properties.status)

const SETTLES_WHEN = enumOf(SCHEMA.properties.decisions.items.properties.settlesWhen)
const GH_TIMEOUT_MS = 15000
const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/

const list = (value) => (Array.isArray(value) ? value : [])
const now = () => new Date().toISOString()

function emptyBoard() {
  return {
    version: VERSION,
    focus: '',
    updatedAt: now(),
    seq: { decision: 0, instruction: 0 },
    instructions: [],
    decisions: [],
    workstreams: [],
    tasks: [],
    repos: [],
    agents: [],
    log: []
  }
}

// Only a missing file starts an empty board: an unreadable or corrupt one is refused, or the
// next write would replace everything on it.
function load() {
  let text
  try {
    text = fs.readFileSync(BOARD_FILE, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return emptyBoard()
    throw new Error(`cannot read ${BOARD_FILE}: ${err.message}`)
  }
  let board
  try {
    board = JSON.parse(text)
  } catch (err) {
    throw new Error(`cannot read ${BOARD_FILE}: not valid JSON (${err.message}); fix the file or reset it with "init --force"`)
  }
  if (!board || typeof board !== 'object' || Array.isArray(board)) throw new Error(`cannot read ${BOARD_FILE}: not a board object`)
  const merged = { ...emptyBoard(), ...board, seq: { ...emptyBoard().seq, ...(board.seq || {}) } }
  merged.version = VERSION
  if (!merged.seq.decision) merged.seq.decision = merged.decisions.reduce((max, d) => Math.max(max, Number(d.id) || 0), 0)
  return merged
}

function save(board) {
  board.updatedAt = now()
  if (board.log.length > LOG_KEPT) board.log = board.log.slice(-LOG_KEPT)
  const problems = validateAgainst(SCHEMA, board)
  if (problems.length) throw new Error(`refusing to write an invalid board:\n  ${problems.join('\n  ')}`)
  fs.mkdirSync(path.dirname(BOARD_FILE), { recursive: true })
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2) + '\n')
  render(board)
}

function log(board, text) {
  board.log.push({ at: now(), text })
}

function nextId(board, kind) {
  board.seq[kind] = (board.seq[kind] || 0) + 1
  return board.seq[kind]
}

function findById(list, id) {
  const item = list.find((x) => String(x.id) === String(id))
  if (!item) throw new Error(`no item with id ${id}`)
  return item
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

function option(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : undefined
}

function assertState(value, allowed, what) {
  if (!allowed.includes(value)) throw new Error(`${what} must be one of ${allowed.join('|')}`)
}

function copyOptions(target, keys) {
  for (const key of keys) {
    const value = option(key)
    if (value !== undefined) target[key] = value
  }
}

function setOncall(target) {
  if (flag('oncall')) target.oncall = true
  if (flag('no-oncall')) delete target.oncall
}

/** "done:Merge*|skip:Skip|explain:Explain" → options; `*` marks the recommended one. */
function parseOptions(spec, recommend) {
  return spec
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const recommended = entry.endsWith('*')
      const clean = recommended ? entry.slice(0, -1) : entry
      const [id, label] = clean.includes(':') ? clean.split(/:(.*)/s) : [clean.toLowerCase().replace(/\s+/g, '-'), clean]
      const option = { id, label }
      if (recommended || (recommend !== undefined && (recommend === String(i + 1) || recommend === id || recommend === label))) option.recommended = true
      return option
    })
}

function render(board) {
  const lines = []
  lines.push('# Coordinator board', '', `> Updated ${board.updatedAt}`, '', `**Focus:** ${board.focus || '—'}`, '')

  if (board.instructions.length) {
    lines.push('## Instructions', '')
    for (const i of board.instructions) lines.push(`- ${i.status === 'done' ? '✅' : '▶'} ${i.text}`)
    lines.push('')
  }

  lines.push('## Decisions (needs you)', '')
  if (board.decisions.length) {
    for (const d of board.decisions) {
      const opts = d.options.map((o) => `${o.label}${o.recommended ? ' ★' : ''}`).join(' / ')
      const head = `- **${d.title}** \`${d.id}\`${d.repo ? ` (${d.repo})` : ''}${d.oncall ? ' 🔴 oncall' : ''} — ${d.action || ''}`
      lines.push(`${head}: ${d.status === 'answered' ? `✅ ${d.answer || ''}` : `❓ ${opts}`}${d.context ? ` — _${d.context}_` : ''}${d.url ? ` — ${d.url}` : ''}`)
    }
  } else lines.push('_none_')
  lines.push('')

  if (board.workstreams.length) {
    lines.push('## Workstreams', '')
    for (const ws of board.workstreams) {
      const own = board.tasks.filter((t) => t.ws === ws.id)
      const progress = ws.progress != null ? ws.progress : own.length ? Math.round((100 * own.filter((t) => t.status === 'merged').length) / own.length) : null
      lines.push(`- **${ws.title}** \`${ws.id}\` — ${ws.status}${progress != null ? ` (${progress}%)` : ''}${ws.oncall ? ' 🔴 oncall' : ''}${ws.notes ? ` — ${ws.notes}` : ''}`)
      for (const t of own) lines.push(`  - ${t.id} · ${t.repo || ''} · ${t.status}${t.pr ? ` · #${t.pr}` : ''}${t.detail ? ` — ${t.detail}` : ''}`)
    }
    lines.push('')
  }

  const orphans = board.tasks.filter((t) => !board.workstreams.some((ws) => ws.id === t.ws))
  if (orphans.length) {
    lines.push('## Tasks without workstream', '')
    for (const t of orphans) lines.push(`- ${t.id} · ${t.repo || ''} · ${t.status}${t.pr ? ` · #${t.pr}` : ''}${t.detail ? ` — ${t.detail}` : ''}`)
    lines.push('')
  }

  if (board.repos.length) {
    lines.push('## Repos / PRs', '')
    for (const r of board.repos) lines.push(`- **${r.name}** (${r.kind}${r.repo ? `, ${r.repo}` : ''}) — ${r.status}${r.detail ? ` — ${r.detail}` : ''}${r.url ? ` — ${r.url}` : ''}`)
    lines.push('')
  }

  lines.push('## Agents', '')
  if (board.agents.length) for (const a of board.agents) lines.push(`- **${a.name}**${a.repo ? ` (${a.repo})` : ''} — ${a.state}${a.detail ? ` — ${a.detail}` : ''}`)
  else lines.push('_none_')
  lines.push('', '## Log', '')
  for (const e of board.log.slice(-10)) lines.push(`- ${e.at} — ${e.text}`)
  lines.push('')

  fs.mkdirSync(path.dirname(BOARD_MD), { recursive: true })
  fs.writeFileSync(BOARD_MD, lines.join('\n'))
}

function runScript(name, args) {
  const result = spawnSync('bash', [path.join(ROOT, 'bin', name), ...args], {
    stdio: 'inherit',
    env: { ...process.env, COORDINATOR_STATE: STATE_DIR, COORDINATOR_PACKAGE: ROOT }
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

// ---- commands ----

const commands = {
  show() {
    const board = load()
    if (flag('json')) console.log(JSON.stringify(board, null, 2))
    else {
      render(board)
      console.log(fs.readFileSync(BOARD_MD, 'utf8'))
    }
  },

  path() {
    console.log(BOARD_FILE)
  },

  init() {
    if (fs.existsSync(BOARD_FILE) && !flag('force')) throw new Error(`${BOARD_FILE} exists (use --force to reset)`)
    save(emptyBoard())
    console.log(BOARD_FILE)
  },

  validate() {
    let board
    try {
      board = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'))
    } catch (err) {
      throw new Error(`cannot read ${BOARD_FILE}: ${err.message}`)
    }
    const problems = validateAgainst(SCHEMA, board)
    if (problems.length) {
      for (const p of problems) console.log(p)
      process.exitCode = 1
    } else console.log(`${BOARD_FILE}: valid`)
  },

  focus(text) {
    const board = load()
    board.focus = text || ''
    log(board, `focus set: ${board.focus}`)
    save(board)
    console.log(board.focus)
  },

  'ws:add'(id) {
    if (!id) throw new Error('usage: ws:add <id> [--title ..] [--url ..] [--status planned|ready|active|paused|done] [--progress N] [--notes ..] [--oncall]')
    const board = load()
    if (board.workstreams.some((ws) => ws.id === id)) throw new Error(`workstream ${id} exists`)
    const status = option('status') || 'planned'
    assertState(status, WS_STATES, 'status')
    const progress = option('progress')
    const ws = { id, title: option('title') || id, url: option('url') || '', status, progress: progress === undefined ? null : Number(progress), notes: option('notes') || '' }
    setOncall(ws)
    board.workstreams.push(ws)
    log(board, `workstream added: ${ws.title}`)
    save(board)
    console.log(ws.id)
  },

  'ws:set'(id) {
    if (!id) throw new Error('usage: ws:set <id> [--status ..] [--progress N|""] [--notes ..] [--title ..] [--url ..] [--oncall|--no-oncall]')
    const board = load()
    const ws = findById(board.workstreams, id)
    const status = option('status')
    if (status) {
      assertState(status, WS_STATES, 'status')
      ws.status = status
    }
    const progress = option('progress')
    if (progress !== undefined) ws.progress = progress === '' ? null : Number(progress)
    copyOptions(ws, ['notes', 'title', 'url'])
    setOncall(ws)
    log(board, `workstream ${id} → ${ws.status}${ws.progress != null ? ` ${ws.progress}%` : ''}`)
    save(board)
    console.log(`${ws.id} ${ws.status}`)
  },

  'ws:rm'(id) {
    if (!id) throw new Error('usage: ws:rm <id>')
    const board = load()
    findById(board.workstreams, id)
    board.workstreams = board.workstreams.filter((ws) => ws.id !== id)
    log(board, `workstream removed: ${id}`)
    save(board)
    console.log(`${id} removed`)
  },

  'task:add'(id) {
    if (!id) throw new Error('usage: task:add <ticket id> [--ws <workstream id>] [--repo ..] [--status local|pr|hold|blocked|merged] [--pr N] [--url ..] [--detail ..] [--oncall]')
    const board = load()
    if (board.tasks.some((t) => t.id === id)) throw new Error(`task ${id} exists`)
    const status = option('status') || 'local'
    assertState(status, TASK_STATES, 'status')
    const task = { id, ws: option('ws') || '', repo: option('repo') || '', status, url: option('url') || '', detail: option('detail') || '' }
    const pr = option('pr')
    if (pr !== undefined) task.pr = Number(pr)
    setOncall(task)
    board.tasks.push(task)
    log(board, `task added: ${id}${task.repo ? ` (${task.repo})` : ''}`)
    save(board)
    console.log(task.id)
  },

  'task:set'(id) {
    if (!id) throw new Error('usage: task:set <ticket id> [--status ..] [--pr N] [--url ..] [--detail ..] [--repo ..] [--ws ..] [--oncall|--no-oncall]')
    const board = load()
    const task = findById(board.tasks, id)
    const status = option('status')
    if (status) {
      assertState(status, TASK_STATES, 'status')
      task.status = status
      if (status === 'merged') task.mergedAt = now()
    }
    const pr = option('pr')
    if (pr !== undefined) task.pr = Number(pr)
    copyOptions(task, ['url', 'detail', 'repo', 'ws'])
    setOncall(task)
    log(board, `task ${task.id} → ${task.status}${task.pr ? ` #${task.pr}` : ''}`)
    save(board)
    console.log(`${task.id} ${task.status}`)
  },

  'task:rm'(id) {
    if (!id) throw new Error('usage: task:rm <ticket id>')
    const board = load()
    findById(board.tasks, id)
    board.tasks = board.tasks.filter((t) => t.id !== id)
    log(board, `task removed: ${id}`)
    save(board)
    console.log(`${id} removed`)
  },

  'repo:add'(name) {
    if (!name) throw new Error('usage: repo:add <name> [--id <ticket>] [--kind repo|pr|feature] [--repo ..] [--status ..] [--detail ..] [--url ..] [--oncall]')
    const board = load()
    const kind = option('kind') || 'pr'
    assertState(kind, REPO_KINDS, 'kind')
    const status = option('status') || 'review'
    assertState(status, REPO_STATES, 'status')
    const id = option('id') || name
    if (board.repos.some((r) => r.id === id)) throw new Error(`repo entry ${id} exists`)
    const repo = { id, name, kind, repo: option('repo') || '', status, detail: option('detail') || '', url: option('url') || '' }
    setOncall(repo)
    board.repos.push(repo)
    log(board, `repo added: ${name} (${kind}, ${status})`)
    save(board)
    console.log(repo.id)
  },

  'repo:set'(id) {
    if (!id) throw new Error('usage: repo:set <id> [--status ..] [--detail ..] [--url ..] [--name ..] [--repo ..] [--oncall|--no-oncall]')
    const board = load()
    const repo = findById(board.repos, id)
    const status = option('status')
    if (status) {
      assertState(status, REPO_STATES, 'status')
      repo.status = status
    }
    copyOptions(repo, ['detail', 'url', 'name', 'repo', 'kind'])
    setOncall(repo)
    log(board, `repo ${repo.name} → ${repo.status}`)
    save(board)
    console.log(`${repo.id} ${repo.status}`)
  },

  'repo:rm'(id) {
    if (!id) throw new Error('usage: repo:rm <id>')
    const board = load()
    findById(board.repos, id)
    board.repos = board.repos.filter((r) => r.id !== id)
    log(board, `repo removed: ${id}`)
    save(board)
    console.log(`${id} removed`)
  },

  'agent:set'(name, state) {
    if (!name || !state) throw new Error(`usage: agent:set <name> <${AGENT_STATES.join('|')}> [--id <dispatch>] [--repo ..] [--role ..] [--detail ..]`)
    assertState(state, AGENT_STATES, 'state')
    const board = load()
    let agent = board.agents.find((a) => a.name === name)
    if (!agent) {
      agent = { id: option('id') || name, name, role: 'worker', state, detail: '', updatedAt: now() }
      board.agents.push(agent)
    }
    agent.state = state
    agent.updatedAt = now()
    copyOptions(agent, ['id', 'repo', 'role', 'detail'])
    log(board, `agent ${name} → ${state}`)
    save(board)
    console.log(`${name} ${state}`)
  },

  'agent:rm'(name) {
    if (!name) throw new Error('usage: agent:rm <name>')
    const board = load()
    if (!board.agents.some((a) => a.name === name)) throw new Error(`no agent named ${name}`)
    if (name === 'coordinator') throw new Error('the coordinator stays on the board')
    board.agents = board.agents.filter((a) => a.name !== name)
    log(board, `agent removed: ${name}`)
    save(board)
    console.log(`${name} removed`)
  },

  clean() {
    const board = load()
    const removed = board.agents.filter((a) => a.name !== 'coordinator' && ['idle', 'stopped'].includes(a.state)).map((a) => a.name)
    const settled = board.decisions.filter((d) => d.status === 'answered').map((d) => d.id)
    if (removed.length) board.agents = board.agents.filter((a) => !removed.includes(a.name))
    if (settled.length) board.decisions = board.decisions.filter((d) => d.status !== 'answered')
    if (removed.length || settled.length) {
      log(board, `cleaned: ${[...removed, ...settled.map((id) => `decision ${id}`)].join(', ')}`)
      save(board)
    }
    for (const name of removed) console.log(name)
    for (const id of settled) console.log(`decision ${id}`)
    if (!removed.length && !settled.length) console.log('nothing to clean')
  },

  'instruction:add'(text) {
    if (!text) throw new Error('usage: instruction:add <text>')
    const board = load()
    const instruction = { id: `i${nextId(board, 'instruction')}`, text, status: 'active', createdAt: now() }
    board.instructions.push(instruction)
    log(board, `instruction added: ${text}`)
    save(board)
    console.log(instruction.id)
  },

  'instruction:set'(id) {
    if (!id) throw new Error('usage: instruction:set <id> [--status active|done] [--text ..]')
    const board = load()
    const instruction = findById(board.instructions, id)
    const status = option('status')
    if (status) {
      assertState(status, INSTRUCTION_STATES, 'status')
      instruction.status = status
      if (status === 'done') instruction.doneAt = now()
    }
    copyOptions(instruction, ['text'])
    log(board, `instruction ${id} → ${instruction.status}`)
    save(board)
    console.log(`${instruction.id} ${instruction.status}`)
  },

  ask(title) {
    if (!title) throw new Error('usage: ask <title> [--repo ..] [--url ..] [--action <verb>] [--context ..] [--options "id:Label*|id:Label"] [--recommend <id|label>] [--settles-when ${SETTLES_WHEN.join('|')}] [--oncall]')
    const board = load()
    const action = option('action') || 'Decide'
    const options = parseOptions(option('options') || `done:${action}*|skip:Skip|explain:Explain`, option('recommend'))
    const settlesWhen = option('settles-when')
    if (settlesWhen !== undefined) {
      assertState(settlesWhen, SETTLES_WHEN, '--settles-when')
      if (!PR_URL.test(option('url') || '')) throw new Error(`--settles-when ${settlesWhen} needs --url to be a GitHub pull request URL`)
    }
    const decision = { id: nextId(board, 'decision'), title, repo: option('repo') || '', url: option('url') || '', action, context: option('context') || '', options, status: 'pending', createdAt: now() }
    if (settlesWhen) decision.settlesWhen = settlesWhen
    setOncall(decision)
    board.decisions.push(decision)
    log(board, `decision ${decision.id} raised: ${title} (${action})`)
    save(board)
    console.log(decision.id)
  },

  answer(id, optionId) {
    if (!id || !optionId) throw new Error('usage: answer <decisionId> <optionId|label> [--note ..]')
    const board = load()
    const d = findById(board.decisions, id)
    const chosen = d.options.find((o) => o.id === optionId || o.label === optionId)
    if (!chosen) throw new Error(`option ${optionId} not on ${id}`)
    d.status = 'answered'
    d.answer = chosen.label
    d.answeredAt = now()
    const note = option('note')
    if (note) d.note = note
    log(board, `decision ${id} answered: ${d.answer}`)
    save(board)
    console.log(`${d.id} → ${d.answer}`)
  },

  // Zero-model: settles pending decisions whose "settles when" condition is met (PRs, through gh).
  // A gh failure leaves the decision pending; the next run checks again.
  reconcile() {
    const board = load()
    const me = (() => {
      try {
        return loadConfig({ strict: false }).config.person?.github || ''
      } catch {
        return ''
      }
    })()
    const settled = []
    for (const d of board.decisions) {
      if (d.status !== 'pending' || !d.settlesWhen) continue
      const result = spawnSync('gh', ['pr', 'view', d.url, '--json', 'state,reviews'], { encoding: 'utf8', timeout: GH_TIMEOUT_MS })
      if (result.error || result.status !== 0) {
        console.error(`board: reconcile: gh failed for decision ${d.id}: ${(result.error?.message || result.stderr || '').trim()}`)
        continue
      }
      let pr
      try {
        pr = JSON.parse(result.stdout)
      } catch {
        console.error(`board: reconcile: gh gave no JSON for decision ${d.id}`)
        continue
      }
      const reviewed = list(pr.reviews).some((r) => me && r.author?.login === me && r.state !== 'PENDING')
      const met = { 'pr-merged': pr.state === 'MERGED', 'pr-closed': pr.state === 'MERGED' || pr.state === 'CLOSED', 'pr-reviewed': reviewed }[d.settlesWhen]
      if (!met) continue
      d.status = 'answered'
      d.answer = 'Settled'
      d.answeredAt = now()
      d.note = `settled automatically: ${d.settlesWhen}`
      log(board, `decision ${d.id} settled: ${d.settlesWhen}`)
      settled.push(d.id)
    }
    if (settled.length) save(board)
    for (const id of settled) console.log(`settled ${id}`)
  },

  'decision:rm'(id) {
    if (!id) throw new Error('usage: decision:rm <decisionId>')
    const board = load()
    findById(board.decisions, id)
    board.decisions = board.decisions.filter((d) => String(d.id) !== String(id))
    log(board, `decision ${id} removed`)
    save(board)
    console.log(`${id} removed`)
  },

  log(text) {
    if (!text) throw new Error('usage: log <text>')
    const board = load()
    log(board, text)
    save(board)
    console.log('ok')
  },

  // The panel sends clicks as terminal text to the coordinator by default; an
  // inbox.jsonl (written when the coordinator terminal is offline) is drained here.
  // The inbox is moved aside before it is read, so a click the panel appends meanwhile lands in a
  // fresh inbox.jsonl; the moved file is deleted only once the board is saved (a failed save
  // leaves it for the next drain). Lines that are not JSON go to inbox.rejected.jsonl.
  inbox() {
    const dir = path.dirname(INBOX_FILE)
    try {
      fs.renameSync(INBOX_FILE, path.join(dir, `inbox.draining-${String(Date.now()).padStart(15, '0')}-${process.pid}.jsonl`))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    const drains = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^inbox\.draining-.*\.jsonl$/.test(f)).sort().map((f) => path.join(dir, f)) : []
    const lines = []
    const rejected = []
    for (const file of drains) {
      for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!raw.trim()) continue
        try {
          const entry = JSON.parse(raw)
          if (!entry || typeof entry !== 'object') throw new Error('not an object')
          lines.push(entry)
        } catch {
          rejected.push(raw)
        }
      }
    }
    const board = load()
    let applied = 0
    for (const entry of lines) {
      const kind = entry.kind || (entry.decisionId ? 'decision' : 'message')
      if (kind === 'decision') {
        const d = board.decisions.find((x) => String(x.id) === String(entry.decisionId))
        if (!d || d.status === 'answered') continue
        d.status = 'answered'
        d.answer = entry.optionLabel || entry.optionId
        d.answeredAt = entry.at
        log(board, `decision ${d.id} answered from panel: ${d.answer}`)
        applied++
      } else if (kind === 'command') {
        log(board, `user command: ${entry.command} ${entry.target ?? ''}`.trim())
        applied++
      } else {
        log(board, `user message: ${entry.text}`)
        applied++
      }
    }
    if (applied) save(board)
    if (rejected.length) fs.appendFileSync(INBOX_REJECTED, rejected.map((l) => l + '\n').join(''))
    for (const file of drains) fs.unlinkSync(file)
    const result = { applied, entries: lines }
    if (rejected.length) result.rejected = rejected.length
    console.log(JSON.stringify(result))
    if (rejected.length) console.error(`board: ${rejected.length} inbox line(s) were not JSON, kept in ${INBOX_REJECTED}`)
  },

  render() {
    render(load())
    console.log(BOARD_MD)
  },

  lessons(...args) {
    runScript('lessons.sh', args)
  },

  metrics(...args) {
    runScript('metrics.sh', args)
  },

  state(...args) {
    runScript('state.sh', args)
  }
}

function usage() {
  console.log(`Coordinator board (${BOARD_FILE})

commands:
  show [--json]                       print BOARD.md (or raw JSON)
  path                                print the board file path
  init [--force]                      create an empty board
  validate                            check the file against schema/board.schema.json
  focus <text>                        set the current focus line
  ws:add <id> [--title ..] [--url ..] [--status ${WS_STATES.join('|')}] [--progress N] [--notes ..] [--oncall]
  ws:set <id> [--status ..] [--progress N|""] [--notes ..] [--title ..] [--url ..] [--oncall|--no-oncall]
  ws:rm <id>
  task:add <ticket> [--ws <ws id>] [--repo ..] [--status ${TASK_STATES.join('|')}] [--pr N] [--url ..] [--detail ..] [--oncall]
  task:set <ticket> [--status ..] [--pr N] [--url ..] [--detail ..] [--repo ..] [--ws ..] [--oncall|--no-oncall]
  task:rm <ticket>
  repo:add <name> [--id <ticket>] [--kind ${REPO_KINDS.join('|')}] [--repo ..] [--status ${REPO_STATES.join('|')}] [--detail ..] [--url ..]
  repo:set <id> [--status ..] [--detail ..] [--url ..] [--name ..] [--repo ..]
  repo:rm <id>
  agent:set <name> <${AGENT_STATES.join('|')}> [--id <dispatch>] [--repo ..] [--role ..] [--detail ..]
  agent:rm <name>                     remove an agent from the board (never the coordinator)
  clean                               prune idle/stopped agents and answered decisions
  instruction:add <text>              record a standing instruction from the human
  instruction:set <id> [--status ${INSTRUCTION_STATES.join('|')}] [--text ..]
  ask <title> [--repo ..] [--url ..] [--action <verb>] [--context ..] [--options "id:Label*|id:Label"] [--recommend <id>] [--settles-when ${SETTLES_WHEN.join('|')}] [--oncall]
  reconcile                           settle decisions whose --settles-when is met (gh, no model)
  answer <decisionId> <optionId|label> [--note ..]
  decision:rm <decisionId>
  log <text>                          append a log entry (last ${LOG_KEPT} kept)
  inbox                               drain inbox.jsonl (offline panel clicks) into the board
  render                              regenerate BOARD.md
  lessons add "<miss>" "<rule>" | lessons list [--days N]    (bin/lessons.sh)
  metrics                             append one row to metrics.tsv      (bin/metrics.sh)
  state [check|waiting|archive]       state.md budget, waiting items, archive done items (bin/state.sh)

Panel clicks reach the coordinator terminal as text: "<option> <decisionId>", "nudge <ticket>", "stop <agent>".`)
}

const [cmd, ...args] = process.argv.slice(2)
try {
  if (!cmd || cmd === 'help' || cmd === '--help') usage()
  else if (!commands[cmd]) throw new Error(`unknown command: ${cmd}`)
  else commands[cmd](...args)
} catch (err) {
  console.error(`board: ${err.message}`)
  process.exit(1)
}
