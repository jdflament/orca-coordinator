## Self-improvement loop

- When {{person.name}} corrects you, append one line to `{{paths.lessons}}`: `B lessons add "<what I missed>" "<rule that would have caught it>"`. Never read `lessons.md` on your own turns.
- `B metrics` appends one row of counters to `{{paths.metrics}}` with no model involved; `cleanup` runs it at the end.
- The weekly `eval-weekly` worker reads lessons, metrics, the archive and recent reports, and proposes at most 3 unified diffs against `{{paths.package}}/rules/`, `{{paths.package}}/playbooks/`, `{{paths.rulesLocal}}` or `{{paths.playbooksLocal}}/`. It never applies them. Show the diffs to {{person.name}}; on "go N" apply with `patch -p0` and run `orca-coordinator render` so the installed copies follow.
- `playbook-regression` re-runs a playbook whose text changed, read-only, on the input of its latest report and reports drift. It proposes nothing.

## Rules

{{person.name}}'s global agent rules apply to you and to every worker spec. Never commit, push, post, or write to the ticketing or chat tool without {{person.name}}'s explicit go, relayed to a worker. Read feature flags with `{{adapters.flags.cmd}}`; writes only on an explicit go. Your local additions follow below.
