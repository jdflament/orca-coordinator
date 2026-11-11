# eval-weekly

Weekly self-evaluation of the coordinator. Goal: turn last week's corrections and metrics into at most 3 concrete edits to the coordinator's rules or playbooks. You propose; you never apply.

Read, in this order:
1. `{{paths.lessons}}`: every line dated within the last 7 days (date | miss | rule).
2. `{{paths.metrics}}`: all rows; compare the last 7 days with the rows before them (corrections, escalations, questions, stale drops, waiting, state_bytes).
3. `{{paths.archive}}/done-*.md`: sections dated within the last 7 days, plus `{{paths.stateFile}}` "Done today".
4. The 10 most recent `{{paths.reports}}/*.md` (`ls -t`), first 30 lines each: look for repeated worker mistakes, missing sections, questions a playbook should have answered.
5. The rendered rules `{{paths.rulesFile}}` and the playbook(s) your proposals touch, in full. Note `wc -c` of the rules file.

Then propose at most 3 diffs. Each one:
- Targets one of: a file in `{{paths.package}}/rules/`, a file in `{{paths.package}}/playbooks/`, `{{paths.rulesLocal}}`, or a file in `{{paths.playbooksLocal}}/`. Never the agent's global settings or permissions.
- Is motivated by one named lesson line, metric movement, or report pattern you cite verbatim. No proposal without evidence.
- Is the smallest text change that would have prevented the miss. Prefer replacing a rule over adding one; prefer deleting a rule nobody applied over clarifying it.
- When the rendered rules exceed 9000 bytes, at least one proposal deletes or merges text, and you say how many bytes it saves.
- Is written as a unified diff (`diff -u` format, real paths, correct hunk headers) that applies cleanly with `patch -p0` from `/`. Verify with `patch --dry-run -p0` against a copy in your scratchpad; never touch the real file.

Report format: one `## Evidence` section (lesson lines, metric deltas, report patterns, one line each), then one `## Diff N: <file> — <one-line intent>` section per proposal with the evidence it answers in one line and the diff in a ```diff block, then `## Not proposed` with lessons you saw but left out and why (one line each). Nothing else. If nothing warrants a change, say so in one line under `## Evidence` and propose no diff.

The coordinator shows {{person.name}} the diffs; their "go N" applies them (`patch -p0`, then `orca-coordinator render`). You never apply, commit, or post anything.
