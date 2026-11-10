# Coordinator (Orca panel)

A sidebar panel that shows the coordinator board: what needs your action,
features, tasks, repos/PRs, subagents — plus agents running in Orca terminals,
read live from Orca itself. Decision buttons record your choice into the
board's inbox (`board/inbox.jsonl`), which the coordinator drains with
`bin/board.mjs inbox`.

- No build step: Orca transpiles `src/worker.ts` and `src/panel.tsx` as written.
- Settings: **Board file** (absolute path, `~/` allowed) — the panel follows
  the file live.
- Test with `orca plugin test .`, check with `orca plugin check .`.
- Board fixtures for tests live in `src/fixtures/`.
