# Playbooks

A playbook is the spec of one recurring job, written for a worker. The coordinator
starts a worker with "Follow `<state>/playbooks/<name>.md`" when a trigger arrives,
reads the report the worker leaves under `<state>/reports/`, and decides what reaches
the human.

Each file here is a template: `{{dotted.key}}` placeholders come from `config.yaml`
(see `orca-coordinator config --keys` for the full list, including derived values
such as `{{adapters.ticketing.run}}` and `{{paths.reports}}`). `orca-coordinator render`
writes the rendered copies to `<state>/playbooks/`. A file with the same name in
`~/.config/orca-coordinator/playbooks.local/` replaces the template; a file named
`<name>.append.md` is appended to it. Nothing here names a company, a person or a tool
outside config.

| Playbook | Does | Writes | Trigger |
| -------- | ---- | ------ | ------- |
| `pr-comments` | triages every comment waiting on your open PRs, prepares fixes and replies | nothing until "go" | precheck `pr-comments` |
| `pr-review` | reviews PRs that request your review, drafts your comments in your voice | nothing until "go" | precheck `pr-review` |
| `ticket-triage` | reads your not-started tickets, verifies the repo in code, proposes a 5-line plan each | nothing | precheck `ticket-triage` |
| `cleanup` | closes unused terminals, removes worktrees whose PR is merged | terminals, worktrees (conservative) | daily, no precheck |
| `eval-weekly` | turns last week's lessons and metrics into ≤3 diffs to the rules or playbooks | nothing (proposals) | precheck `eval-weekly` |
| `playbook-regression` | re-runs a changed playbook read-only on its last input, reports drift | nothing | precheck `playbook-regression` |

## From playbook to automation

1. Write or adapt the template; render it (`orca-coordinator render`) and read the result.
2. Give it a precheck (`prechecks/<name>.sh`) that exits non-zero when nothing changed.
3. Add a job to `automations.jobs` in `config.yaml`:
   `{playbook: <name>, schedule: "<cron>", precheck: <name>, name: "<what it does>"}`.
4. `orca-coordinator automations install` registers it in Orca with
   `bin/route.sh <name> <precheck>` as the Orca precheck: the precheck gate, then the
   trigger text sent to the live coordinator terminal (exit 2 = no new session), or a
   fresh session when no coordinator is live (exit 0).
5. Test by hand: `bash bin/route.sh <name> <precheck>; echo $?`.

The common preamble of every playbook (where to write the report, how to finish with
`worker_done`, never message the human directly) is `_preamble.md`; `render` prepends it
to every playbook that does not start with `---`.
