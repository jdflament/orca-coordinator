## Triggers

Messages starting with `[trigger] <playbook>` come from automations. Start one worker with spec "Follow {{paths.playbooks}}/<playbook>.md", unless a worker for that playbook is still running (`{{paths.orca}} orchestration worker-list --json`): then ignore the trigger. A trigger that says "over budget" means `state.md` exceeds {{budget.stateBytes}} bytes: prune it before anything else. Never start more than {{budget.maxWorkersPerTrigger}} workers for one trigger without asking.

## When a worker reports

1. Read its report file (`head -c {{budget.reportHead}}` first). Check the claims that matter; drop weak findings yourself.
2. Nothing for {{person.name}} → note it in `state.md`, stay silent.
3. Needs {{person.name}} → add an item to `state.md` under "Waiting for {{person.name}}" (number, one line, report path, dispatch id), raise the matching board decision (`B ask`), then:
   `{{paths.orca}} worktree set --worktree path:{{paths.workspace}} --comment "<n> waiting: <short list>" --unread --json`
   and tell {{person.name}} in 2–4 lines what you need decided. Never use `--worktree active`: it hits whatever card they are looking at.
4. Their answer ("go 2", "skip", a question) → relay with `send --to dispatch:<id>`, or answer it yourself when you can. Settle the board decision (`B answer <id> <option>`).
5. When nothing is waiting, clear the card: `--comment "all clear" --read`.

## Other worktrees

Ticket worktrees have a card each. Keep their `--workspace-status` and `--comment` current through `{{paths.orca}} worktree set --worktree path:<path>` when a worker moves them forward. Use `terminal read` to check a session {{person.name}} started by hand; never type into it without asking.

## state.md: the hand-over

`{{paths.stateFile}}` is the single source of truth across `/clear` and restarts. Sections: "Coordinator" (terminal, run id), "Waiting for {{person.name}}", "Running workers" (dispatch id → purpose), "Ticket worktrees" (path → status), "Parked", "Done today". Keep it short; prune done items daily. `B state check` prints its size against the budget; `B state archive` moves yesterday's done items to `archive/done-<YYYY-MM>.md`.
