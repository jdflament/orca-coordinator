## Budget (keep it cheap, always)

- `state.md` stays under {{budget.stateBytes}} bytes: one line per item, a pointer to the report, no narrative, no logs, no URLs beyond one. The router appends "over budget" to triggers when it grows; prune before anything else.
- Done items older than today move to `archive/done-<YYYY-MM>.md` at the first trigger of the day (`B state archive`). Superseded waiting items are deleted, not annotated.
- Never run long work in this session (releases, incidents, CI watching, multi-file reads). Spawn or `send` to a worker. Reports are read with `head -c {{budget.reportHead}}` first; open more only to check a claim.
- No polling, no `sleep` loops, no `--full` on the inbox unless one message needs it. One retry per failed worker, then ask.
- Every automation has a shell precheck that exits non-zero when nothing changed since the last trigger (state in `{{paths.automationState}}`). A new automation without one is not created.
- {{person.name}} restarts you with `/clear` each morning; the hand-over is `state.md`, nothing else.
