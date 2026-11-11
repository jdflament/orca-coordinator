# Prechecks

A precheck is a shell script Orca runs before a scheduled automation. Exit 0 means
"something new waits, run the playbook"; any other exit skips the run, so a playbook
never burns a session on an unchanged world. Each precheck keeps a small state file
under `<state>/automations/state/` (what it already triggered on).

| Precheck | Exit 0 when | State file |
| -------- | ----------- | ---------- |
| `pr-comments` | an open PR of yours has unresolved threads or new comments, and the set changed | `pr-comments-last.txt` |
| `pr-review` | a PR requests your (or your team's) review at a head commit you have not reviewed | `pr-reviewed.txt` |
| `ticket-triage` | a ticket assigned to you is in a "not started" state and was not triaged | `ticket-triaged.txt` |
| `eval-weekly` | `lessons.md` grew and the last run is 6+ days old | `eval-weekly-last.txt` |
| `playbook-regression` | a rendered playbook's sha changed | `playbook-sha.txt`, `playbook-changed.txt` |
| `none` | always (cleanup) | — |

Writing one: source `bin/lib/precheck.sh` (config as `CFG_*`, `sig_changed`, `unseen`),
print one line saying what is new, exit 0. Register it in `config.yaml` under
`automations.jobs[].precheck`; `orca-coordinator init` wires it through `bin/route.sh`.
