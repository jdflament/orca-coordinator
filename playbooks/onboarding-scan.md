---
runner: coordinator
---
# onboarding-scan

Run by the coordinator itself (no worker) on its first session, and again when {{person.name}} says "rescan". Goal: understand the current situation before acting. Read-only except the board and `state.md`; ask {{person.name}} nothing that is not sensitive (see Decide yourself). The zero-model script `{{paths.bin}}/scan` gathers the facts: one tab-separated line per fact, `unavailable` when a tool failed (say so, do not guess).

1. Run `{{paths.bin}}/scan`. Then, for what it cannot see: `{{paths.orca}} orchestration worker-list --json` (running workers), `{{paths.orca}} terminal list --json` (agents in other terminals), and the skills, playbooks and hooks of the agents in use (read-only; never open or edit another agent's config).
2. Other workflows. For each `automation` line marked `other`, and each other skill/playbook/automation you found that does PR review, comment triage, ticket triage or cleanup, compare it with this coordinator's own jobs (`ours:<playbook>`): same job = duplicate, a job that acts on the same PRs or worktrees = conflict. For each, one line: what it is, which to keep (default: keep the coordinator's, because it reports through the board; keep the other when it does something the coordinator does not), and how to disable it in Orca's own UI. Never disable or edit it yourself. The `version` line: when `outdated`, one line "orca-coordinator <installed> → <latest>", nothing more.
3. Current state, onto the board through `B`, never duplicating what is on it (the script already skips PRs whose url is on the board; check `B` output for tasks and agents before adding):
   - `review` lines: one decision each, `B ask "<repo>#<n>" --repo <repo> --url <url> --action "Review" --context "<title>" --options "done:Reviewed*|skip:Skip"`. If decisions support a "settles when" field, set it to the PR being merged, closed or reviewed at its head.
   - `mine` lines: a task each, `B task:add <repo>#<n> --repo <repo> --status pr --url <url> --detail "<n> comments to triage"`.
   - `repo` lines with dirty files or commits not on a remote: a task with `--status local` and the branch in `--detail`. A clean repo on its base branch is not listed.
   - Running workers and agents Orca does not report: `B agent:set`. Workers from `worker-list` appear on their own.
   Respect the queue limit ({{queue.max}}): list the oldest-waiting first, mention the rest in `state.md` only.
4. Record in `state.md` (one line each): the scan date, the duplicate/conflict verdicts, the version line. `B log "scan: <n> reviews, <n> PRs, <n> local"`. Touch `{{paths.state}}/onboarding-scanned` so the next session start does not repeat it.
5. Tell {{person.name}} in at most 6 lines: what is waiting on them (count and the top item), conflicts with advice, the version line if outdated. No questions unless a sensitive action is needed.
