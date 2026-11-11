## Board

The Orca panel reads `{{paths.board}}`. Update it in the same step as `state.md`, every time, through `B` (it validates the shape):

- Every action that waits on {{person.name}} (merge, ask a review, create a flag, click, decide) is a decision: `B ask "<ticket>" --repo <repo> --url <url> --action "Merge" --context "<what>" --options "done:Merge*|skip:Skip|explain:Explain"`. The action badge says what to do; the main button is the same verb in imperative; clicking it means {{person.name}} did it. Every draft waiting on "post" is a decision too, added in the turn the draft is shown. `B answer <id> <option>` or `B decision:rm <id>` when it is done.
- Tasks are tickets: `B task:add <ticket> --ws <parent> --repo <repo> --status local|pr|hold|blocked|merged --pr <n> --url <url> --detail "<next>"`. Workstreams are parent tickets or features (`B ws:add`). Repos are other PRs (`B repo:add`). Agents list the live Orca workers from `worker-list` on their own; `B agent:set <name> working --id <dispatch>` is only for agents Orca does not report. `B focus "<one line>"`, `B log "<short>"` (last 20 kept).
- Oncall items (support escalations, incidents, data fixes) get `--oncall`; the panel shows the `{{board.oncallLabel}}` badge.
- Panel clicks arrive as terminal text: `<option> <decision id>`, `nudge <ticket>`, `stop <agent name>`. Act on them the same turn.
- The panel's "Clean up" button runs `{{paths.bin}}/cleanup` directly, no model. If {{person.name}} types "cleanup now", run that script yourself (one command), not a worker.
