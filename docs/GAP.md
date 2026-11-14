# Behaviour map: what the coordinator does, and where each piece lives

The package splits every behaviour into a **shared** part (this repository: rules,
scripts, playbooks, panel) and a **local** part (your config, your overrides, your
runtime state). `cfg.x` names a key in `config.yaml`.

| Behaviour | Shared (package) | Local (yours) | Config key |
| --------- | ---------------- | ------------- | ---------- |
| Session start: write the terminal handle, read `state.md` and the inbox (`--limit 5`), load the orchestration skill | `rules/10-session.md` | `<state>/coordinator-terminal` | `paths.state` |
| Hand-over via `state.md`, `/clear` daily, fixed sections | `rules/30-triggers-reports.md`, `templates/state.md`, `bin/state.sh` | `<state>/state.md` | `budget.stateBytes` |
| Worker lifecycle: coordinator at the workspace root, each worker in its repo (`path:<repo>` for read-only and small edits, new top-level worktree for tickets, `current` only across repos), follow-up by `send` on the same dispatch, start/stop/retry/steer without asking, end the turn | `rules/20-workers.md` | — | `agents.worker.*`, `git.branchPattern` |
| Worker naming: tab renamed `<playbook or ticket>: <target>` right after start | `rules/20-workers.md` | — | — |
| Test quality bar in specs that write tests: public entry points, named failures, risky paths, real temp dirs, weak tests rewritten or deleted | `rules/25-worker-tests.md` | — | — |
| Permission prompts: read the command, never approve blind, narrow an over-broad ask rule (backup, retry with `--retry-of`), answer an already-approved push in the worker tab and verify origin | `rules/20-workers.md` | the agent's permissions file | `agents.worker.permissionsFile` |
| Decide vs ask: worker lifecycle without asking, go only on a ticket plan, sensitive list, "do the reversible part, ask one question" | `rules/40-decisions.md` | `rules.local.md` for extra items | `sensitive[]` |
| Short queue: max items, re-check before listing, stale drop, safe defaults, one question with a recommendation | `rules/40-decisions.md` | — | `queue.max`, `queue.staleHours` |
| Budget: `state.md` size guard, daily archive, `head -c` on reports, one retry, no long work in the coordinator | `rules/70-budget.md`, `bin/route.sh` (guard) | — | `budget.*` |
| Router: precheck gate, live-coordinator check, trigger text, budget warning | `bin/route.sh` | `<state>/automations/route-*.sh` (generated) | `automations.*` |
| Precheck framework: exit non-zero when unchanged, dedupe state | `bin/lib/precheck.sh`, `prechecks/*.sh` | `<state>/automations/state/` | — |
| Prechecks shipped: PR comments, PR reviews, ticket triage, weekly eval, playbook regression | `prechecks/` | — | `github.*`, `adapters.ticketing.*` |
| Automation schedules | `config.example.yaml` defaults | registered in Orca by `init` | `automations.jobs[]` |
| Board schema (tasks local/pr/hold/blocked/merged, decisions with `action`, `url`, `repo`, `oncall`) | `schema/board.schema.json`, `bin/board.mjs` (validates writes), `plugin/src/protocol.ts` | `<state>/board.json` | — |
| Decision = action badge + imperative button, Skip / Explain, drafts as decisions | `rules/60-board.md`, `plugin/panel/index.html` | — | — |
| Board agents: live Orca workers from `worker-list`; `B agent:set` only for agents Orca does not report | `rules/60-board.md`, `bin/board.mjs` | — | — |
| Panel clicks: `terminal send "<option> <id>"` to the live coordinator; `inbox.jsonl` fallback when it is offline | `plugin/src/worker.ts`, `bin/board.mjs inbox` | — | plugin setting `coordinatorDir` |
| Priority badge (`oncall` field) | panel, schema, `board.mjs --oncall` | — | `board.oncallLabel` |
| Cleanup script (zero model) + panel ⋯ menu item: dry-run preview, then Confirm, then a feedback line | `bin/cleanup.sh` (`-n`), plugin handler `board.cleanup` | — | `paths.worktreeRoot` |
| Status line ◆ COORDINATOR / WORKER (WORKER read from the plugin's own `<state>/worker-terminals`) | `bin/statusline.sh` | `~/.claude/settings.json` by `init --statusline` or `orca-coordinator statusline`; previous command in `<state>/statusline-chain` | `agents.coordinator.statusline` |
| Worker self-identification footer in every spec, ◆ tab title | `rules/10-session.md`, `playbooks/_preamble.md` | — | `person.name` |
| Optional rule `drafts`: the human's language and tone (both optional), UI terms kept, never post, no "I recommend" in text they post, ≤2 proof links | `rules/optional/drafts.md` | `person.voiceFile` | `person.*` |
| Optional rules `planning-tracker` (every named repo, show cuts, one ticket per repo per feature) and `five-line-plan` | `rules/optional/planning-tracker.md`, `rules/optional/five-line-plan.md` | — | `rules.optional`, `git.*` |
| Optional rule `planning-tracker`: tracker and GitHub in sync in the same step (PR attached, status follows PR, one child per repo, design decisions as a parent comment) | `rules/optional/planning-tracker.md` | — | `adapters.ticketing.*` |
| Chat draft-only fallback (channels the bot cannot post in; part of the `drafts` rule) | `rules/optional/drafts.md`, `adapters/chat/*.sh` | — | `adapters.chat.draftOnlyChannels[]` |
| Ticketing CLI adapter for prechecks (Linear, Jira, GitHub issues, none), per repo | `adapters/ticketing/`, `bin/lib/adapters.mjs` | — | `adapters.ticketing.*`, `repos[].ticketing` |
| Chat CLI adapter for prechecks (Slack, none), per repo | `adapters/chat/`, `bin/lib/adapters.mjs` | — | `adapters.chat.*`, `repos[].chat` |
| Flags (Unleash, none) | `adapters/flags/` | credential in keychain/env/file | `adapters.flags.*` |
| Playbooks (pr-comments, pr-review, ticket-triage, cleanup, eval-weekly, playbook-regression) | `playbooks/*.md` templates | `playbooks.local/` overrides, rendered copies in `<state>/playbooks/` | all placeholders |
| Panel UI: live workers, "Needs you" cards, coordinator-live dot, Clean up (⋯ menu), jump to coordinator, local git work per repo (opens Source Control) | `plugin/` | — | plugin settings |
| Panel settings (gear): name, writing language and style, watched git repositories; nothing else | `plugin/src/setup.ts` (`config.read`, `config.save`, `config.removeRepo`), `coordinator.mjs config --merge` | `config.yaml` | `person.*`, `repos[]` |
| Repos are git repositories only: a plain folder in `repos[]` is a warning, skipped everywhere, offered for removal in settings | `bin/lib/config.mjs` (`isGitRepo`), `plugin/src/setup.ts` | `config.yaml` | `repos[]` |
| Tools detected, not configured: names recorded with `coordinator tools --set`, per-repo hint in `state.md`; CLI adapters only for the shell prechecks | `rules/00-role.md`, `rules/10-session.md`, `bin/coordinator.mjs tools` | `<state>/panel.json` (`tools`), `state.md` | `adapters.*`, `repos[].ticketing` / `chat` (optional) |
| Personal rules (team labels, review prefixes, voice) | — | `rules.local.md`, `config.yaml` | — |
| Lessons: one line per correction | `bin/lessons.sh`, `templates/lessons.md` | `<state>/lessons.md` | — |
| Metrics: counters without a model, appended after cleanup | `bin/metrics.sh` | `<state>/metrics.tsv` | — |
| Weekly eval: ≤3 diffs proposed, never applied; playbook regression on text change | `playbooks/eval-weekly.md`, `playbooks/playbook-regression.md`, their prechecks | diffs land in `rules/` or `rules.local.md` | `automations.jobs[]` |
| Git gate, standing instructions, never poll | `skill/coordinator/SKILL.md`, `rules/` | — | — |
| `init` / `render` / `doctor` / `uninstall` | `bin/coordinator.mjs` | config, state, symlinks, automations | — |

## What never goes in the shared part

Company and product names, people, chat channel or user ids, flag-tool URLs and
credential names, repo names, ticket prefixes, team labels, review prefixes, voice
samples, model choices, absolute home paths, and any runtime content (state,
board, reports, archive). All of it is either a config key or a local file.
