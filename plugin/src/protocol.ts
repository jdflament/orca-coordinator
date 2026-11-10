// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

export interface BoardOption {
  id: string
  label: string
  recommended?: boolean
}

export interface BoardDecision {
  id: string
  title: string
  context?: string
  options: BoardOption[]
  status: string
  answer?: string
  answeredAt?: string
  createdAt?: string
}

export interface BoardTask {
  id: string
  title: string
  status: string
  kind?: string
  assignee?: string
  ws?: string
  detail?: string
}

export interface BoardWorkstream {
  id: string
  title: string
  status: string
  progress?: number | null
  owner?: string
  notes?: string
}

export interface BoardRepo {
  id: string
  name: string
  kind: string
  status: string
  detail?: string
  url?: string
}

export interface BoardAgent {
  id?: string
  name: string
  role?: string
  state: string
  detail?: string
  updatedAt?: string
}

/** A standing instruction the user gave the coordinator. */
export interface BoardInstruction {
  id: string
  text: string
  to?: string
  status: string
  createdAt?: string
}

export interface Board {
  version: number
  focus?: string
  updatedAt?: string
  workstreams?: BoardWorkstream[]
  tasks?: BoardTask[]
  repos?: BoardRepo[]
  decisions?: BoardDecision[]
  agents?: BoardAgent[]
  instructions?: BoardInstruction[]
  log?: { at: string; text: string }[]
}

/** What the worker answers and posts: the parsed board, or why it could not. */
export interface BoardSnapshot {
  board: Board | null
  error: string
  boardPath: string
}

declare module 'orca' {
  interface PluginRequests {
    /** The board as the worker last read it from disk. */
    'board.get': { output: BoardSnapshot }
    /** Records a decision click by appending to inbox.jsonl beside the board. */
    'decision.respond': {
      input: { decisionId: string; optionId: string; note?: string }
      output: { ok: boolean; at: string; optionLabel: string }
    }
    /** Queues a quick action: nudge (unblock a task), stop (an agent), … */
    'command.send': {
      input: { command: 'nudge' | 'stop' | string; target: string }
      output: { ok: boolean; at: string }
    }
    /** Brings the coordinator's terminal to the front in Orca. */
    'coordinator.focus': {
      input: { terminal?: string }
      output: { ok: boolean; terminal?: string; title?: string; error?: string }
    }
    /** Whether the coordinator's terminal is the tab on screen right now. */
    'coordinator.visible': {
      output: { ok: boolean; visible: boolean }
    }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel whenever the board file changes. */
    'board.changed': BoardSnapshot
  }
}

export {}
