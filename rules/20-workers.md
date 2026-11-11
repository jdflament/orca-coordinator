## Workers

- Start: `{{paths.orca}} orchestration worker-start --agent {{agents.worker.agent}} {{agents.worker.extraArgs}} --task-title "<short>" --spec "<spec>" ...`. Workers run on `{{agents.worker.agent}}`; the model comes from config (`agents.worker.model`, empty = the agent's default).
- Placement: you sit at the workspace root for context; every worker runs in the repo it works on. Read-only jobs (reviews, triage, investigation) and small edits in an existing checkout: `--worktree path:<repo path>`. They close on their own. `--worktree current` only for a job that spans several repos.
- Ticket implementation: `--worktree new-top-level --repo id:<repoId> --name "<branch>"` with the branch from `git.branchPattern` (`{{git.branchPattern}}`, e.g. `{{git.branchExample}}`); spec = the agreed plan plus {{person.name}}'s global agent rules. These stay open; release them once the PR is merged (`orchestration worker-release --dispatch <id>`).
- Fix or follow-up on an existing worker: `orchestration send --to dispatch:<id>`, never a new worker. A closed worker reopens on `send`.
- Retry a failed worker once ({{budget.workerRetries}}): `worker-stop`, then `worker-start --task <task> --retry-of <dispatch>`. The next failure goes to {{person.name}}.
- Right after `worker-start`, rename the tab: `{{paths.orca}} terminal rename --terminal <handle> --title "<playbook or ticket>: <target>"` (e.g. `pr-comments: api#481`). Never leave the default "worker-task…" name.
- Starting, stopping, retrying and steering workers is yours: never ask {{person.name}} first, do it and report after. Only the ticket plan needs their go (see Decisions).
- Then end your turn. Orca wakes you. Never poll.

## Permission prompts in workers

Workers run with permissions skipped; the only prompts left come from the agent's `ask` rules (`{{agents.worker.permissionsFile}}`: push, merge, DB clients, chat posts, API writes…). A worker that prompts is therefore either (a) about to do a write {{person.name}} did not ask for, or (b) blocked by an ask rule that is too broad. {{person.name}} never clicks Yes blind. On a `needs-input` escalation:

1. `{{paths.orca}} orchestration worker-read --dispatch <id>` and read the exact command.
2. Case (b): fix or narrow the rule (backup the file first, never widen `allow`), then `worker-stop` + `worker-start --task <task> --retry-of <dispatch>`. Tell {{person.name}} what changed.
3. Case (a): never approve on your own. Tell {{person.name}} in plain words what the worker wants to do, to what, and your recommendation (usually: deny, the playbook forbids it).
4. When {{person.name}} has already given an explicit go for that exact write (for example "go 19" on a push), answer the prompt in the worker tab yourself (`{{paths.orca}} terminal send --terminal <handle> --text y --enter`), then verify the result (for a push: the branch is on origin, `gh pr view` or `git ls-remote`). Do not send {{person.name}} back to click.
5. Otherwise, if they say yes, switch them to the tab: `{{paths.orca}} terminal switch --terminal <handle>`. Send a push notification when they may be away.

Orca cannot split a pane with an existing terminal, so "bring {{person.name}} to the tab" is `terminal switch`, used only when they must click.
