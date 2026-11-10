#!/usr/bin/env node
// Coordinator board — single source of truth for work state.
// Agent-agnostic CLI: any agent (OpenCode, Claude, Codex, a human) edits the board
// through this script so the shape stays valid and BOARD.md stays in sync.
//
// Usage: node bin/board.mjs <command> [args]
// Run without arguments for the command list.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOARD_FILE = process.env.COORDINATOR_BOARD || path.join(ROOT, 'board', 'board.json')
const BOARD_MD = path.join(path.dirname(BOARD_FILE), 'BOARD.md')
const INBOX_FILE = path.join(path.dirname(BOARD_FILE), 'inbox.jsonl')

const TASK_STATES = ['queued', 'active', 'blocked', 'done']
const WS_STATES = ['planned', 'active', 'paused', 'done']
const AGENT_STATES = ['idle', 'working', 'waiting', 'stopped']
const REPO_STATES = ['planned', 'building', 'review', 'shipped', 'blocked']
const REPO_KINDS = ['repo', 'pr', 'feature']
const INSTRUCTION_STATES = ['active', 'done']

const now = () => new Date().toISOString()

function emptyBoard() {
  return {
    version: 1,
    focus: '',
    updatedAt: now(),
    seq: { task: 0, decision: 0, ws: 0, instruction: 0 },
    workstreams: [],
    tasks: [],
    repos: [],
    decisions: [],
    agents: [],
    instructions: [],
    log: []
  }
}

function load() {
  try {
    const board = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'))
    return { ...emptyBoard(), ...board }
  } catch {
    return emptyBoard()
  }
}

function save(board) {
  board.updatedAt = now()
  if (board.log.length > 20) board.log = board.log.slice(-20)
  fs.mkdirSync(path.dirname(BOARD_FILE), { recursive: true })
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2) + '\n')
  render(board)
}

function log(board, text) {
  board.log.push({ at: now(), text })
}

function nextId(board, kind, prefix) {
  board.seq[kind] = (board.seq[kind] || 0) + 1
  return `${prefix}${board.seq[kind]}`
}

function findById(list, id) {
  const item = list.find((x) => x.id === id)
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

function toneFor(status) {
  if (['done'].includes(status)) return 'success'
  if (['blocked', 'paused', 'waiting'].includes(status)) return 'warning'
  if (['active', 'working'].includes(status)) return 'accent'
  return 'neutral'
}

function render(board) {
  const lines = []
  lines.push(`# Coordinator board`)
  lines.push('')
  lines.push(`> Updated ${board.updatedAt}`)
  lines.push('')
  lines.push(`**Focus:** ${board.focus || '—'}`)
  lines.push('')

  if (board.instructions?.length) {
    lines.push('## Instructions')
    lines.push('')
    for (const i of board.instructions) {
      lines.push(`- ${i.status === 'done' ? '✅' : '▶'} ${i.text}${i.to ? ` — _to ${i.to}_` : ''}`)
    }
    lines.push('')
  }

  if (board.workstreams.length) {
    lines.push('## Workstreams')
    lines.push('')
    for (const ws of board.workstreams) {
      lines.push(`- **${ws.title}** \`${ws.id}\` — ${ws.status}${ws.progress != null ? ` (${ws.progress}%)` : ''}${ws.notes ? ` — ${ws.notes}` : ''}`)
    }
    lines.push('')
  }

  lines.push('## Tasks')
  lines.push('')
  if (board.tasks.length) {
    lines.push('| id | task | status | kind | assignee |')
    lines.push('|----|------|--------|------|----------|')
    for (const t of board.tasks) {
      lines.push(`| ${t.id} | ${t.title} | ${t.status} | ${t.kind || ''} | ${t.assignee || ''} |`)
    }
  } else {
    lines.push('_none_')
  }
  lines.push('')

  if (board.repos?.length) {
    lines.push('## Repos / PRs / Features')
    lines.push('')
    for (const r of board.repos) {
      lines.push(`- **${r.name}** (${r.kind}) — ${r.status}${r.detail ? ` — ${r.detail}` : ''}${r.url ? ` — ${r.url}` : ''}`)
    }
    lines.push('')
  }

  lines.push('## Decisions')
  lines.push('')
  if (board.decisions.length) {
    for (const d of board.decisions) {
      const opts = d.options.map((o) => `${o.label}${o.recommended ? ' ★' : ''}`).join(' / ')
      lines.push(`- **${d.title}** \`${d.id}\` — ${d.status === 'answered' ? `✅ ${d.answer || ''}` : `❓ ${opts}`}${d.context ? ` — _${d.context}_` : ''}`)
    }
  } else {
    lines.push('_none_')
  }
  lines.push('')

  lines.push('## Agents')
  lines.push('')
  if (board.agents.length) {
    for (const a of board.agents) {
      lines.push(`- **${a.name}** (${a.role || 'agent'}) — ${a.state}${a.detail ? ` — ${a.detail}` : ''}`)
    }
  } else {
    lines.push('_none_')
  }
  lines.push('')

  lines.push('## Log')
  lines.push('')
  for (const e of board.log.slice(-10)) lines.push(`- ${e.at} — ${e.text}`)
  lines.push('')

  fs.mkdirSync(path.dirname(BOARD_MD), { recursive: true })
  fs.writeFileSync(BOARD_MD, lines.join('\n'))
}

// ---- commands ----

const commands = {
  show() {
    const board = load()
    if (flag('json')) {
      console.log(JSON.stringify(board, null, 2))
    } else {
      console.log(fs.readFileSync(BOARD_MD, 'utf8'))
    }
  },

  path() {
    console.log(BOARD_FILE)
  },

  focus(text) {
    const board = load()
    board.focus = text || ''
    log(board, `focus set: ${board.focus}`)
    save(board)
    console.log(board.focus)
  },

  'ws:add'(title) {
    if (!title) throw new Error('usage: ws:add <title> [--status planned|active|paused|done] [--progress N] [--notes ..] [--owner ..]')
    const board = load()
    const status = option('status') || 'planned'
    if (!WS_STATES.includes(status)) throw new Error(`status must be one of ${WS_STATES.join('|')}`)
    const progress = option('progress')
    const ws = { id: nextId(board, 'ws', 'ws'), title, status, progress: progress === undefined ? null : Number(progress), owner: option('owner') || '', notes: option('notes') || '' }
    board.workstreams.push(ws)
    log(board, `workstream added: ${title}`)
    save(board)
    console.log(ws.id)
  },

  'ws:set'(id) {
    if (!id) throw new Error('usage: ws:set <id> [--status ..] [--progress N] [--notes ..] [--title ..]')
    const board = load()
    const ws = findById(board.workstreams, id)
    const status = option('status')
    if (status) {
      if (!WS_STATES.includes(status)) throw new Error(`status must be one of ${WS_STATES.join('|')}`)
      ws.status = status
    }
    const progress = option('progress')
    if (progress !== undefined) ws.progress = progress === '' ? null : Number(progress)
    for (const k of ['notes', 'title', 'owner']) {
      const v = option(k)
      if (v !== undefined) ws[k] = v
    }
    log(board, `workstream ${id} → ${ws.status}${ws.progress != null ? ` ${ws.progress}%` : ''}`)
    save(board)
    console.log(`${ws.id} ${ws.status}`)
  },

  'task:add'(title) {
    if (!title) throw new Error('usage: task:add <title> [--ws id] [--kind subagent|orca-worker|self|human] [--assignee ..] [--status ..]')
    const board = load()
    const status = option('status') || 'queued'
    if (!TASK_STATES.includes(status)) throw new Error(`status must be one of ${TASK_STATES.join('|')}`)
    const task = {
      id: nextId(board, 'task', 't'),
      title,
      status,
      kind: option('kind') || 'self',
      assignee: option('assignee') || '',
      ws: option('ws') || '',
      detail: option('detail') || '',
      startedAt: status === 'active' ? now() : null
    }
    board.tasks.push(task)
    log(board, `task added: ${title}`)
    save(board)
    console.log(task.id)
  },

  'task:set'(id) {
    if (!id) throw new Error('usage: task:set <id> [--status ..] [--assignee ..] [--detail ..]')
    const board = load()
    const task = findById(board.tasks, id)
    const status = option('status')
    if (status) {
      if (!TASK_STATES.includes(status)) throw new Error(`status must be one of ${TASK_STATES.join('|')}`)
      task.status = status
      if (status === 'active' && !task.startedAt) task.startedAt = now()
      if (status === 'done') task.doneAt = now()
    }
    for (const k of ['assignee', 'detail', 'kind']) {
      const v = option(k)
      if (v !== undefined) task[k] = v
    }
    log(board, `task ${task.id} → ${task.status}${task.assignee ? ` (${task.assignee})` : ''}`)
    save(board)
    console.log(`${task.id} ${task.status}`)
  },

  'repo:add'(name) {
    if (!name) throw new Error('usage: repo:add <name> [--kind repo|pr|feature] [--status ..] [--detail ..] [--url ..]')
    const board = load()
    const kind = option('kind') || 'repo'
    if (!REPO_KINDS.includes(kind)) throw new Error(`kind must be one of ${REPO_KINDS.join('|')}`)
    const status = option('status') || 'planned'
    if (!REPO_STATES.includes(status)) throw new Error(`status must be one of ${REPO_STATES.join('|')}`)
    const repo = { id: nextId(board, 'repo', 'r'), name, kind, status, detail: option('detail') || '', url: option('url') || '' }
    board.repos.push(repo)
    log(board, `repo added: ${name} (${kind}, ${status})`)
    save(board)
    console.log(repo.id)
  },

  'repo:set'(id) {
    if (!id) throw new Error('usage: repo:set <id> [--status ..] [--detail ..] [--url ..]')
    const board = load()
    const repo = findById(board.repos, id)
    const status = option('status')
    if (status) {
      if (!REPO_STATES.includes(status)) throw new Error(`status must be one of ${REPO_STATES.join('|')}`)
      repo.status = status
    }
    for (const k of ['detail', 'url', 'name', 'kind']) {
      const v = option(k)
      if (v !== undefined) repo[k] = v
    }
    log(board, `repo ${repo.name} → ${repo.status}`)
    save(board)
    console.log(`${repo.id} ${repo.status}`)
  },

  'agent:set'(name, state) {
    if (!name || !state) throw new Error(`usage: agent:set <name> <${AGENT_STATES.join('|')}> [--role ..] [--detail ..]`)
    if (!AGENT_STATES.includes(state)) throw new Error(`state must be one of ${AGENT_STATES.join('|')}`)
    const board = load()
    let agent = board.agents.find((a) => a.name === name)
    if (!agent) {
      agent = { id: name, name, role: 'worker', state, detail: '', updatedAt: now() }
      board.agents.push(agent)
    }
    agent.state = state
    agent.updatedAt = now()
    for (const k of ['role', 'detail']) {
      const v = option(k)
      if (v !== undefined) agent[k] = v
    }
    log(board, `agent ${name} → ${state}`)
    save(board)
    console.log(`${name} ${state}`)
  },

  'instruction:add'(text) {
    if (!text) throw new Error('usage: instruction:add <text> [--to <coordinator>]')
    const board = load()
    const instruction = {
      id: nextId(board, 'instruction', 'i'),
      text,
      to: option('to') || 'coordinator',
      status: 'active',
      createdAt: now()
    }
    board.instructions.push(instruction)
    log(board, `instruction added: ${text}`)
    save(board)
    console.log(instruction.id)
  },

  'instruction:set'(id) {
    if (!id) throw new Error('usage: instruction:set <id> [--status active|done]')
    const board = load()
    const instruction = findById(board.instructions, id)
    const status = option('status')
    if (status) {
      if (!INSTRUCTION_STATES.includes(status)) throw new Error(`status must be one of ${INSTRUCTION_STATES.join('|')}`)
      instruction.status = status
      if (status === 'done') instruction.doneAt = now()
    }
    log(board, `instruction ${id} → ${instruction.status}`)
    save(board)
    console.log(`${instruction.id} ${instruction.status}`)
  },

  ask(title) {
    if (!title) throw new Error('usage: ask <title> [--context ..] [--options "label1|label2"] [--recommend <index or label>]')
    const board = load()
    const labels = (option('options') || 'yes|no').split('|').map((s) => s.trim()).filter(Boolean)
    const recommend = option('recommend')
    const options = labels.map((label, i) => ({
      id: `o${i + 1}`,
      label,
      recommended: recommend !== undefined && (recommend === String(i + 1) || recommend === label)
    }))
    const decision = {
      id: nextId(board, 'decision', 'd'),
      title,
      context: option('context') || '',
      options,
      status: 'pending',
      answer: '',
      createdAt: now()
    }
    board.decisions.push(decision)
    log(board, `decision raised: ${title}`)
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

  log(text) {
    if (!text) throw new Error('usage: log <text>')
    const board = load()
    log(board, text)
    save(board)
    console.log('ok')
  },

  // Decision clicks and quick actions from the Orca panel land in inbox.jsonl;
  // this drains them: decisions settle on the board, commands and messages are
  // logged (and printed) for the coordinator to act on.
  inbox() {
    let lines = []
    try {
      lines = fs.readFileSync(INBOX_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      lines = []
    }
    const board = load()
    let applied = 0
    for (const entry of lines) {
      const kind = entry.kind || (entry.decisionId ? 'decision' : 'message')
      if (kind === 'decision') {
        const d = board.decisions.find((x) => x.id === entry.decisionId)
        if (!d || d.status === 'answered') continue
        d.status = 'answered'
        d.answer = entry.optionLabel || entry.optionId
        d.answeredAt = entry.at
        d.source = 'panel'
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
    if (lines.length) fs.writeFileSync(INBOX_FILE, '')
    console.log(JSON.stringify({ applied, entries: lines }))
  },

  render() {
    render(load())
    console.log(BOARD_MD)
  }
}

function usage() {
  console.log(`Coordinator board (${BOARD_FILE})

commands:
  show [--json]                       print BOARD.md (or raw JSON)
  path                                print the board file path
  focus <text>                        set the current focus line
  ws:add <title> [--status planned|active|paused|done] [--progress N] [--notes ..] [--owner ..]
  ws:set <id> [--status planned|active|paused|done] [--progress N] [--notes ..] [--title ..]
  task:add <title> [--ws id] [--kind subagent|orca-worker|self|human] [--assignee ..] [--status ..]
  task:set <id> [--status queued|active|blocked|done] [--assignee ..] [--detail ..]
  repo:add <name> [--kind repo|pr|feature] [--status planned|building|review|shipped|blocked] [--detail ..] [--url ..]
  repo:set <id> [--status planned|building|review|shipped|blocked] [--detail ..] [--url ..]
  agent:set <name> <idle|working|waiting|stopped> [--role ..] [--detail ..]
  instruction:add <text> [--to <coordinator>]   record a standing user instruction
  instruction:set <id> [--status active|done]
  ask <title> [--context ..] [--options "a|b"] [--recommend <label>]
  answer <decisionId> <optionId|label> [--note ..]
  log <text>                          append a log entry
  inbox                               drain panel decision clicks into the board
  render                              regenerate BOARD.md`)
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
