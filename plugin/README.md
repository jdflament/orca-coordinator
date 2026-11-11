# Coordinator board (Orca panel)

The repository root is the plugin (`orca-plugin.json` there): Orca installs the whole
package, and this folder holds the panel and its worker. Until the coordinator is set up the
panel shows a setup screen (pick an Orca workspace, `src/setup.ts` copies the package to
`~/.local/share/orca-coordinator` and runs `init` with your own node); after that, a
**Start coordinator** button when no coordinator terminal is live.

A right-sidebar panel over the coordinator's `board.json`: what needs you (decisions
with imperative buttons, workers waiting for input), work grouped by workstream with
ticket and PR links, running agents, a live dot for the coordinator terminal, and a
**Clean up** button that runs the zero-model cleanup script.

- Buttons send text to the coordinator terminal (`<option> <id>`, `nudge <ticket>`,
  `stop <agent>`). When no coordinator terminal is live the click is queued in
  `inbox.jsonl` beside the board and drained by `board.mjs inbox`.
- Settings: **Coordinator state folder** (default `~/.local/state/orca-coordinator`),
  **Orca CLI** (empty = bundled CLI on macOS or `orca` on PATH).
- `panel.json` in that folder (written by `orca-coordinator render`) carries the
  ticket-link template, repo colours and the oncall label from your config.
- No build step: Orca transpiles `src/worker.ts`. The panel is plain HTML.

From the repository root:

```sh
orca plugin validate .
orca plugin test .                  # worker tests (node:test), including a full setup in a temp home
orca plugin dev load .              # load into Orca while editing, prints the --approve fingerprint
orca plugin open local.coordinator-board --panel coordinator-board
```
