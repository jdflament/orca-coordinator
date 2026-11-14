# Design decisions

Dated record of the choices that shaped the package. Newest last.

## 2026-11-10: a coordinator, not a chat bot

- **One coordinator, many workers.** The coordinator is the human's single point of contact. It plans, dispatches Orca workers, judges their reports and asks the human only for sensitive decisions. It never does multi-step work itself.
- **Everything the human must act on is a board decision** with an action badge and an imperative button. The panel is buttons only; the human talks to the coordinator in chat.
- **Hand-over is one file.** `state.md` survives `/clear` and restarts; it has a byte budget and the router warns when it is over.
- **Automations have prechecks.** A scheduled job never starts a session when nothing changed; a shell script decides that for free.
- **Zero-model cleanup.** Releasing settled workers and merged worktrees is a script, wired to a panel button.
- **Coordinator and worker are visibly different.** ◆ in the coordinator tab title and status line, a self-identification line in every worker's first reply.

## 2026-11-11: make it shareable (goal of this package)

Goal: carry everything the reference coordinator does, generic and agnostic (any person, ticketing tool, chat, agent), fully on Orca. Everything specific stays local and configurable.

Decisions:

- **Panel shipped as is.** The HTML panel is the reference UI; only its hard-coded paths became plugin settings (`coordinatorDir`, `orcaBin`) and the ticket-link base comes from config through the worker. The upstream components panel and its tests were replaced; the worker test was adapted.
- **`board.mjs` kept and upgraded** to board schema 2, validating every write against `schema/board.schema.json`, so agents without file-edit tools (and humans) can keep the board valid.
- **Clicks go to the coordinator terminal** as `<option> <id>` text by default; `inbox.jsonl` is only a fallback when no coordinator is live.
- **Shared vs local layout.** Shared: `rules/`, `plugin/`, `bin/`, `prechecks/`, `adapters/`, `playbooks/`, `schema/`, `templates/`, `skill/`. Local, never committed: `config.yaml`, `rules.local.md`, `playbooks.local/`, and the runtime state (state, board, reports, lessons, metrics).
- **Install assumes no folders.** Config at `~/.config/orca-coordinator/config.yaml` (XDG) or `$ORCA_COORDINATOR_CONFIG`; runtime state at `~/.local/state/orca-coordinator/`; optional per-project `.orca-coordinator.yaml`.
- **`init` asks** for the few values it cannot guess: your name, draft language and tone, UI-term language, flags kind, agent per role, which Orca workspace hosts the coordinator (listed from Orca), repos (from `orca repo list`). Flags answer the same questions non-interactively.
- **Automations are opt-in**, off by default (`automations.enabled`).
- **Adapters** expose one interface per tool kind (`get|list|comment|create|url`, `search|draft|post`, `get|list|url|toggle`) so playbooks and rules never name a vendor CLI. Writes refuse without `--yes`.
- **Not in the package:** company or product names, chat ids, flag URLs and credential names, repo names, ticket prefixes, team labels, review prefixes, personal rules, model choices, home paths. They live in `config.yaml` and `rules.local.md`.

### Update, same day: official-grade, config-driven

- **Nothing assumes a personal layout.** No default workspace path, no worktree-root convention, no repo names, no branch rule, no team rules, no ticket prefixes. "Everyone has a different way of working": all of it is config.
- **Setup is one idempotent entry point** (`orca-coordinator init`, also `./setup.sh`), with `--dry-run` and `uninstall`, that validates Orca and the agents, prints what it did, and never overwrites a config it did not write. README sections: Requirements, Install, Configure, How it works, Playbooks, Automations, Board panel, Self-improvement loop, Uninstall, Contributing, License (MIT).
- **No version suffixes in names** inside the package; no ticket numbers, people or reports.
- **New folds shipped:** `lessons.md` (one line per human correction: date | miss | rule), `bin/metrics.sh` (no model, appends to `metrics.tsv`, run at the end of cleanup), playbooks `eval-weekly` (weekly, proposes at most 3 diffs to the rules, never applies) and `playbook-regression` (on playbook sha change), each with a precheck that exits non-zero when nothing changed.
- **Tracker rule in the skill:** tracker and GitHub stay in sync in the same step (PR attached, status follows the PR state, one child ticket per repo, design changes recorded as a comment on the parent).
- **Worker rules in the skill:** rename every worker tab right after start; on an explicit go for a push, the coordinator answers the prompt in the worker tab itself and verifies origin.
- **Design documents live inside the package** (`docs/`), not in loose files.
- **Tools are detected, not configured.** The coordinator uses whatever MCP servers and CLIs its agent has, records their names with `coordinator tools --set`, and keeps a one-line hint per repo in `state.md`. The panel shows no tool settings or tool list; board items carry their own url and a known host only picks an icon. `adapters.ticketing|chat` and `repos[].ticketing|chat` stay as optional, config.yaml-only CLI adapters for the zero-model prechecks, which cannot call MCP; with none, `ticket-triage` runs on schedule.

## 2026-11-12: v1.0.1, what the panel owns

Supersedes the 2026-11-11 notes where they differ (the ticket-link template from config is gone: each board item carries its own url).

- **The panel's settings are the person and the repos only.** Name, draft language and tone, and the watched repositories; written through `coordinator.mjs config --merge`, read back to check, then rendered. Automations, queue, budget and the CLI adapters stay `config.yaml`-only; a save never touches them, even when a patch names them. No per-repo ticketing or chat settings in the panel.
- **Repos are git repositories only.** A `repos[]` entry that is not the top of a git work tree (the workspace folder, a folder inside a repo, a missing path) is a warning, skipped by every consumer, never written by `init` or `config --merge`, and offered for removal in the settings view.
- **Clean up previews first.** The ⋯ menu runs `bin/cleanup -n` (changes nothing) and shows what it would close and remove; only Confirm runs it.
- **The status-line badge reads the plugin's own file, not Orca's database.** Orca sets no env var for dispatched workers, so the plugin worker writes the terminals of the workers Orca lists to `<state>/worker-terminals` and `bin/statusline.sh` only reads it (no `sqlite3`, no dependency on Orca's schema; Orca plugin review, issue #1). The chained previous status line runs without a shell. `orca-coordinator statusline` re-chains a replaced `statusLine`.
