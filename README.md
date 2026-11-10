# orca-coordinator

A coordinator setup for agent-driven work: **you are the coordinator** (the
agent: OpenCode, Claude, Codex, …), this repo gives you the brain and the eyes.

- **`skill/coordinator/SKILL.md`** — the coordinator operating loop: dispatch
  policy (subagents vs Orca workers vs handoffs), token discipline, plain and
  explicit naming, when to escalate decisions to the human. Agent-agnostic;
  install it in any agent that supports skills (or paste it into system
  instructions).
- **`bin/board.mjs`** — the board CLI. One JSON file (`board/board.json`) holds
  focus, workstreams/features, tasks, repos/PRs, subagent states, decisions and
  a log. `board.json` is local state: it is gitignored, so nothing sensitive
  leaks. `BOARD.md` is rendered beside it for humans.
- **`plugin/`** — an [Orca](https://orca.sh) sidebar panel: a clean, live
  overview of what the coordinator is doing — what needs your action,
  features, tasks, repos/PRs, subagents, and agents running in Orca (read
  straight from Orca itself). Decision buttons write to the board's inbox.

## Install

### 1. Board + skill

```sh
git clone https://github.com/jdflament/orca-coordinator ~/Workspace/orca-coordinator
```

Point agents at the skill (pick what your agent reads):

| Agent | Where |
| ----- | ----- |
| OpenCode | `~/.config/opencode/skills/coordinator` → clone's `skill/coordinator` (symlink or copy) |
| Claude Code | `~/.claude/skills/coordinator` → same |
| Any `.agents`-aware agent | `~/.agents/skills/coordinator` → same |
| Codex / others | paste `skill/coordinator/SKILL.md` into `AGENTS.md` / system prompt |

Set `COORDINATOR_BOARD` if you cloned somewhere else than
`~/Workspace/orca-coordinator` (or just edit the panel's "Board file" setting).

### 2. Orca panel

```sh
ORCA="/Applications/Orca.app/Contents/Resources/bin/orca"
$ORCA plugin dev load ~/Workspace/orca-coordinator/plugin   # loads + prompts approval
$ORCA plugin enable local.coordinator-overview --approve <fingerprint>  # prints it
$ORCA plugin open local.coordinator-overview --panel coordinator-overview
```

The panel needs Orca ≥ 1.4.246. It only asks for: its own settings, read
agent status, read workspace.

## Board CLI

```text
board.mjs show [--json]      print BOARD.md (or raw JSON)
board.mjs focus <text>       set the current focus line
board.mjs instruction:add|instruction:set  standing user instructions (shown in the panel)
board.mjs ws:add|ws:set      workstreams (features): status, progress
board.mjs task:add|task:set  tasks: queued|active|blocked|done, assignee, kind
board.mjs repo:add|repo:set  repos / PRs / features: status, detail, url
board.mjs agent:set          subagent registry: idle|working|waiting|stopped
board.mjs ask|answer         decisions (recommended option shows starred in the panel)
board.mjs inbox              drain the panel's decision clicks and quick actions
board.mjs log <text>         append a log entry
```

## Panel quick actions

The panel is buttons only — no text box; you talk to the agent in chat:

- **Jump to coordinator** — brings the coordinator's terminal to the front.
  The worker resolves it from the **Coordinator terminal** setting: a title
  substring (default `coordinator`) or a `term_…` handle.
- **Answer decisions** — the buttons on each decision card (approve/deny or
  whatever options the coordinator raised).
- **Nudge a blocked task** — ⚡ button on a blocked task: asks the coordinator
  to unblock and retry it.
- **Stop a busy agent** — ■ button on a working agent.

Everything is written to `board/inbox.jsonl` and applied when the coordinator
next runs `bin/board.mjs inbox` (each turn). Done tasks fold away behind a
"Done (N)" collapsible so history can grow without filling the panel.

The panel also shows the **standing instructions** you gave the coordinator
(`instruction:add` on the board) — active ones up top, done ones drop away —
and the **Jump to coordinator** button at the bottom appears only when you
are not already on the coordinator's tab.

## Git policy

The coordinator never commits or pushes on its own: it shows you what
changed and waits for your validation (see `skill/coordinator/SKILL.md`).

## Layout

```text
skill/coordinator/SKILL.md   the brain (agent-agnostic)
bin/board.mjs                board CLI
board/                       live state (gitignored: board.json, BOARD.md, inbox.jsonl)
plugin/                      Orca panel (orca-plugin.json, src/)
```

## License

MIT
