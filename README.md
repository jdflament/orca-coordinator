# orca-coordinator

A coordinator setup for agent-driven work on [Orca](https://orca.sh): **you talk to one
agent, the coordinator; it dispatches Orca workers, judges what they bring back, keeps a
board you can act on with one click, and asks you only for the decisions that are yours.**

Everything about *you* (name, repos, tracker, chat, agents, limits) is one config file.
Nothing in the package assumes a folder layout, a company or a tool.

Three folds:

1. **Board and panel.** `board.json` (schema inside) holds what needs you, the work by
   ticket, other PRs and running workers. An Orca sidebar panel shows it with imperative
   buttons (Merge, Skip, Explain, nudge, stop) and a zero-model **Clean up** button.
2. **Playbooks and automations with prechecks.** Six recurring jobs (PR comments, PR
   review, ticket triage, cleanup, weekly eval, playbook regression) as rendered specs
   for workers. Orca runs them on a schedule only when a shell precheck says something
   changed, and routes the trigger to the live coordinator instead of starting a session.
3. **Self-improvement loop.** One line per correction you make (`lessons.md`),
   counters without a model (`metrics.tsv`), a weekly worker that proposes at most three
   diffs to the rules (never applies), and a regression check when a playbook changes.

## Requirements

- Orca ≥ 1.4.246 with its CLI (`/Applications/Orca.app/Contents/Resources/bin/orca` on
  macOS, or `orca` on PATH).
- Node.js ≥ 20.6 (the CLI and the board; no npm dependencies).
- `git`, `gh` (GitHub CLI, signed in), `jq`.
- An agent Orca can launch for the coordinator and for workers (Claude Code, Codex,
  OpenCode, …) that supports skills, or whose system prompt you can paste into.
- Optional: the CLI of your tracker (`orca linear` is built into Orca; `jira` for Jira),
  a chat credential or MCP tool, a feature-flag API credential in your keychain.

## Install

From Orca. In Settings → Plugins, install `jdflament/orca-coordinator`, or from a terminal:

```sh
orca plugin install jdflament/orca-coordinator
```

Orca shows what the plugin may do (it runs a small worker on your machine) and asks you to
approve it once. The **Coordinator board** panel then opens on a setup screen: one
**Set up in <folder>** button for your top Orca folder (**Change folder** picks another), above a
short form (your name, the repos to watch, your ticketing and chat tools). That copies
the package to `~/.local/share/orca-coordinator` (Orca keeps each plugin version in its own
folder; the skill link and the wrappers need a path that does not move) and runs
`orca-coordinator init --yes` there. Then **Start coordinator** opens your agent in that
workspace with the coordinator skill loaded. The gear in the panel header edits the same
settings later (it writes `config.yaml`, then re-renders and re-registers automations).

Updates come from Orca too: `orca plugin update --all` (or the Plugins page) installs the next
release, and the panel brings the package and its rendered rules up to date the next time it
starts. Your config and state are never touched by an update.

The setup needs Node.js ≥ 20.6 on your PATH; the panel says so if it is missing.

From a clone (to hack on it; the panel is then installed from the clone):

```sh
git clone https://github.com/jdflament/orca-coordinator ~/src/orca-coordinator
cd ~/src/orca-coordinator
./setup.sh                      # shows what it detected; Enter installs, e edits
./setup.sh --dry-run            # same, prints what it would do and changes nothing
node bin/coordinator.mjs doctor # checks node, orca, gh, jq, config, state, plugin, automations
```

`init` detects everything it can and shows it before writing anything; Enter installs, `e`
walks through each value. It finds: your name (`git config user.name`) and GitHub login
(`gh`), your language (system locale) and timezone, the agent installed (`claude`, `codex`
or `opencode`), the workspace (the Orca repo holding the clone, else the one holding the
folder you ran it from, else that folder), its repos and their GitHub owner, and Orca's
worktree folder. Ticketing, chat and flags start at `none`. `--yes` takes all of it without
asking.

Non-interactive, all flags:

```sh
./setup.sh --yes --name Alex --github alex-dev --workspace ~/code --github-org acme \
  --worker-agent claude --coordinator-agent claude --ticketing linear --ticketing-team ENG \
  --issue-url 'https://linear.app/acme/issue/{id}' --chat slack --flags none --automations
```

`init` is idempotent: it keeps a config it did not write (merge only), keeps existing
state, re-links the skill, reloads the panel if needed, and registers only the
automations that are missing. Run it again after editing the config, or just
`node bin/coordinator.mjs render` for the rules, playbooks and wrappers.

What `init` does, in order: writes `~/.config/orca-coordinator/config.yaml`
(+ `rules.local.md`, `playbooks.local/`), creates `~/.local/state/orca-coordinator/`
(`state.md`, `board.json`, `lessons.md`, `reports/`, `archive/`, `bin/` wrappers),
renders `COORDINATOR.md` and `playbooks/` from your config, links
`skill/coordinator` into every agent skills folder it finds (`~/.claude/skills`,
`~/.config/opencode/skills`, `~/.agents/skills`; Codex gets a paste hint), installs the
panel through Orca's plugin installer (`orca plugin install <clone>`; it leaves alone a panel
Orca installed from GitHub) and opens it, and, when `automations.enabled` is true or
`--automations` is given, registers the scheduled jobs.

## Configure

One file: `~/.config/orca-coordinator/config.yaml` (or `$ORCA_COORDINATOR_CONFIG`).
A project can add `.orca-coordinator.yaml` at its root to override keys; for ticketing and
chat it wins over everything else for that repository. Full example
with comments: [`config.example.yaml`](config.example.yaml). Print the merged result
with `node bin/coordinator.mjs config` (`--keys` lists every placeholder the templates
can use).

| Key | What it drives |
| --- | -------------- |
| `person.name`, `github`, `language`, `tone`, `uiTermsLanguage`, `voiceFile` | how the coordinator addresses you, how drafts and review comments are written |
| `paths.package`, `state`, `workspace`, `worktreeRoot`, `orca` | where the package, the runtime state, your Orca workspace, Orca's worktrees and the Orca CLI are |
| `agents.coordinator.agent`, `agents.worker.{agent,model,extraArgs,permissionsFile}`, `agents.automation.provider` | which agent runs each role; the worker agent is a plain config value |
| `git.branchPattern`, `prTitlePattern`, `protectedBranches` | branch names for ticket worktrees (`{github}`, `{ticket}`, `{ticket-lower}`), PR titles, branches never pushed to |
| `repos[]` | name, path and base branch of the git repositories the coordinator works in (init fills it from `orca repo list`; plain folders are ignored), and optionally the repo's own `ticketing` / `chat` block |
| `github.org`, `reviewTeams`, `skipRepos`, `botReviewer`, `requestBotReview` | which PRs are yours to review, which to ignore, which bot to request |
| `adapters.ticketing.{kind,via,team,todoStates,childLabel,issueUrl}` | the default for repos without their own block: `linear`, `jira`, `github` or `none`; how tickets are read and linked |
| `adapters.chat.{kind,via,mentionIds,reviewChannels,draftOnlyChannels}` | the default for repos without their own block: `slack` or `none`; where review pings come from; channels where only drafts are possible |
| `adapters.flags.{kind,baseUrl,project,uiUrl,secretRef}` | `unleash` or `none`; the secret stays in the keychain (`keychain:<service>`), an env var or a file |
| `sensitive[]` | the actions the coordinator must ask you for |
| `queue.max`, `queue.staleHours` | how many items may wait on you, when they go stale |
| `budget.stateBytes`, `reportHead`, `workerRetries`, `maxWorkersPerTrigger` | the cost rules below |
| `automations.enabled`, `timezone`, `graceMinutes`, `jobs[]` | the scheduled jobs: `{playbook, schedule, precheck, name}` |
| `board.oncallLabel`, `board.repoColors` | the panel's oncall badge text and per-repo colours |

Secrets never go in the file: `secretRef` points at the keychain, an env var or a file.

## How it works

- **Coordinator.** Loads the `coordinator` skill, reads the config and the rendered
  rules (`<state>/COORDINATOR.md`), then `state.md`. It writes its terminal handle so
  automations can reach it, renames its tab `◆ COORDINATOR`, and ends every turn after
  dispatching: Orca wakes it when a worker reports.
- **Workers.** Started with `orca orchestration worker-start --agent <agents.worker.agent>`
  from a spec, their tab renamed `<playbook or ticket>: <target>`. Read-only jobs run in
  the current worktree; ticket work gets a new top-level worktree named by
  `git.branchPattern`. Follow-ups go to the same dispatch with `send`.
- **Reports.** Workers write to `<state>/reports/` and finish with `worker_done`. The
  coordinator reads the first 2500 bytes, drops weak findings, and either notes the
  result in `state.md` or raises a decision on the board and tells you in 2–4 lines.
- **Decide vs ask.** Everything reversible the coordinator decides. The `sensitive`
  list (commit, push, PR open/merge/comment, ticket writes, chat posts, DB, deploy,
  prod, branch deletion, permission widening) needs your explicit go, one question per
  message with a recommendation.
- **Hand-over.** `state.md` is the only memory across `/clear` and restarts. It has a
  byte budget; the router warns when it is over.
- **Permission prompts in workers** are never approved blind: the coordinator reads the
  exact command, narrows an over-broad ask rule (backup first) and retries, or tells you
  what the worker wants to do. A push you already approved it answers itself in the
  worker tab, then verifies origin.

The full map of behaviours and where each lives is in [`docs/GAP.md`](docs/GAP.md); the
dated design decisions are in [`docs/DECISIONS.md`](docs/DECISIONS.md). The rules
themselves are the files in [`rules/`](rules/), rendered with your config; your own
additions go in `rules.local.md`.

## Playbooks

Templates in [`playbooks/`](playbooks/) with `{{dotted.key}}` placeholders from the
config, rendered to `<state>/playbooks/` by `render`. A file with the same name in
`~/.config/orca-coordinator/playbooks.local/` replaces a template, `<name>.append.md`
extends it. Each one says what it reads, what it may write (usually nothing until
your "go"), the report format, and how it handles your decision relayed by the
coordinator.

| Playbook | Does |
| -------- | ---- |
| `pr-comments` | every comment waiting on your open PRs: verdict (apply / skip / wrong / answer), fix on the branch, reply draft in your tone; pushes and replies only on "go" |
| `pr-review` | PRs requesting your (or your team's) review, plus chat pings: review in your voice, zero comments is a valid outcome; submits only on "go" |
| `ticket-triage` | your not-started tickets: repo verified in code, 5-line plan each, rule violations flagged |
| `cleanup` | unused terminals and merged worktrees, conservative; metrics at the end |
| `eval-weekly` | last week's lessons, metrics, archive and reports → at most 3 unified diffs to the rules or playbooks |
| `playbook-regression` | re-runs a changed playbook read-only on its last input and reports drift |

Adapters under [`adapters/`](adapters/) give the playbooks one interface per tool
kind, so a playbook says `{{adapters.ticketing.run}} --repo <repo> get <id>` whatever the
tracker. Ticketing and chat are per repository: `<state>/bin/ticketing` and `<state>/bin/chat`
run the tool of the repo named by `--repo` (else of the repo holding the current folder, else
the default); `orca-coordinator adapter ticketing --repo api` shows what a repo resolves to,
`--targets` lists every distinct setup. Writes through an adapter refuse without `--yes`.

## Automations

Each job in `automations.jobs[]` becomes an Orca automation whose precheck is
`bin/route.sh <playbook> <precheck>`:

1. the precheck (`prechecks/<name>.sh`) exits non-zero when nothing changed since the
   last trigger (its state lives in `<state>/automations/state/`), so no session starts;
2. when a coordinator terminal is live, the router sends it `[trigger] <playbook>`
   (with "over budget" appended when `state.md` is too big) and exits 2: Orca skips
   the run, the coordinator starts one worker;
3. when no coordinator is live, the router exits 0 and the automation's fresh session
   becomes the coordinator.

```sh
node bin/coordinator.mjs automations list       # jobs from config and whether Orca has them
node bin/coordinator.mjs automations install    # register the missing ones (needs automations.enabled or runs anyway)
node bin/coordinator.mjs automations remove
bash bin/route.sh pr-review pr-review; echo $?   # try a route by hand
```

Automations are off by default (`automations.enabled: false`); `init --automations`
or the config turns them on. See [`prechecks/README.md`](prechecks/README.md) to write
a new one.

## Board panel

`plugin/` is the Orca panel: a plain HTML page plus a worker that reads
`<state>/board.json`, adds the live Orca workers and whether the coordinator terminal
is alive, and forwards clicks. Sections: header (live dot, last update, Clean up,
jump to coordinator), focus line, counters, standing instructions, **Needs you**
(decisions with their action badge and imperative buttons, workers waiting for input),
**Work** (tickets grouped by workstream with repo colour, PR link, status, oncall badge,
nudge on blocked, done fold), **Agents** (board agents and live workers with stop).

Clicks reach the coordinator as terminal text: `<option> <decision id>`,
`nudge <ticket>`, `stop <agent>`. When no coordinator is live they queue in
`inbox.jsonl` and `board.mjs inbox` drains them. Buttons lock for five seconds after a
click so a double click never sends twice.

The board CLI keeps the file valid for any agent:

```text
board.mjs ask "PROJ-101" --repo api --url <pr> --action Merge --context "CI green" --options "done:Merge*|skip:Skip|explain:Explain"
board.mjs task:add PROJ-101 --ws PROJ-100 --repo api --status pr --pr 42 --url <pr> --detail "review"
board.mjs ws:add PROJ-100 --title "Checkout redesign" --status active
board.mjs agent:set "pr-review: api#42" working --id ctx_1
board.mjs answer 1 done | decision:rm 1 | task:set PROJ-101 --status merged | focus "..." | log "..."
board.mjs validate | show | show --json | lessons add "<miss>" "<rule>" | metrics | state check|waiting|archive
```

`<state>/bin/board` is the same CLI with the paths filled in; the rules call it `B`.

## Self-improvement loop

- **Lessons.** When you correct the coordinator it appends one line to
  `<state>/lessons.md`: `date | what I missed | rule that would have caught it`. It never
  reads the file on its own turns.
- **Metrics.** `bin/metrics.sh` appends a row to `<state>/metrics.tsv` (corrections,
  escalations, questions, reports, workers, stale drops, waiting items, state size)
  with no model involved. Cleanup runs it at the end.
- **Weekly eval.** The `eval-weekly` playbook (precheck: new lessons and 6+ days since
  the last run) reads lessons, metrics, the archive and the ten latest reports, and
  proposes at most three unified diffs against `rules/`, `playbooks/`, `rules.local.md`
  or `playbooks.local/`. It never applies them: the coordinator shows them, your
  "go N" applies with `patch -p0`, then `render`.
- **Regression.** When a rendered playbook's sha changes, `playbook-regression` re-runs
  it read-only on the input of its last report and reports `same`, `drift: …` or
  `not comparable: …`.

## Budget rules

- `state.md` under `budget.stateBytes` (2500): one line per item, pointers to reports.
  Yesterday's done items go to `archive/done-<YYYY-MM>.md` at the first trigger of the day.
- Reports are read with `head -c budget.reportHead` first.
- No long work in the coordinator session: spawn or `send` to a worker. No polling, no
  sleep loops, one retry per failed worker, at most `budget.maxWorkersPerTrigger` per trigger.
- Every automation has a precheck; a precheck that cannot be written means no automation.
- Workers run on the cheapest capable agent and model (`agents.worker.model`); the
  coordinator runs on the smartest one.

## Uninstall

```sh
node bin/coordinator.mjs uninstall           # automations, panel plugin, skill links, wrappers, status line
node bin/coordinator.mjs uninstall --purge   # also deletes ~/.local/state/orca-coordinator and ~/.config/orca-coordinator (asks first)
```

Both accept `--dry-run`. Installed from Orca, run them as
`node ~/.local/share/orca-coordinator/bin/coordinator.mjs uninstall --purge`, then delete
`~/.local/share/orca-coordinator`; from a clone, delete the clone by hand.

## Contributing

- `npm test` runs the Node tests (`test/`); `npm run check` adds `orca plugin validate`
  and `orca plugin test` for the panel. No build step anywhere.
- Rules go in `rules/` as short numbered Markdown files with `{{placeholders}}`; nothing
  personal, nothing vendor-specific outside `adapters/`.
- A new tool kind is one script in `adapters/<kind>/` with the common command names,
  plus its name in `bin/lib/config.mjs`.
- A new playbook ships with a precheck and a row in `config.example.yaml`.
- Keep the panel HTML as the single UI; change the worker contract in
  `plugin/src/protocol.ts` first.

## Releasing

The repository is the Orca plugin (`orca-plugin.json` at the root), so a version tag is a
release: Orca installs the newest `vX.Y.Z` tag and `orca plugin update` moves to the next one.

```sh
# bump "version" in package.json and orca-plugin.json (a test checks they match)
git commit -am "v1.0.1" && git tag -a v1.0.1 -m v1.0.1 && git push --follow-tags
```

The tag starts [`.github/workflows/release.yml`](.github/workflows/release.yml): it checks
the tag matches both files, runs the tests and writes the GitHub release notes. Once, for the
listing on onorca.dev: `gh repo edit jdflament/orca-coordinator --add-topic orca-plugin`.

## License

MIT. Author: [jdflament](https://github.com/jdflament).
