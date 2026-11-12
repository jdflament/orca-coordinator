# Coordinator board (Orca panel)

The repository root is the plugin (`orca-plugin.json` there): Orca installs the whole
package, and this folder holds the panel and its worker. Until the coordinator is set up the
panel shows a setup screen (pick an Orca workspace and the git repositories to watch;
`src/setup.ts` copies the package to `~/.local/share/orca-coordinator` and runs `init` with
your own node); after that, a **Start coordinator** button when no coordinator terminal is
live, and a settings gear (name, draft language and tone, watched git repositories; written to
`config.yaml` through `coordinator.mjs config --merge`, then rendered).

A right-sidebar panel over the coordinator's `board.json`: what needs you (decisions
with imperative buttons, workers waiting for input), work grouped by workstream with
ticket and PR links (each item's own url; a known host only adds an icon), local git work of
the configured repos, running agents, a live dot for the coordinator terminal, and a
**Clean up** item in the ⋯ menu that previews the zero-model cleanup script (`-n`) and runs
it on Confirm.

- Buttons send text to the coordinator terminal (`<option> <id>`, `nudge <ticket>`,
  `stop <agent>`). When no coordinator terminal is live the click is queued in
  `inbox.jsonl` beside the board and drained by `board.mjs inbox`.
- Settings: **Coordinator state folder** (default `~/.local/state/orca-coordinator`),
  **Orca CLI** (empty = bundled CLI on macOS or `orca` on PATH).
- `panel.json` in that folder (written by `orca-coordinator render`) carries the repo
  colours and the oncall label from your config.
- No build step: Orca transpiles `src/worker.ts`. The panel is plain HTML.

From the repository root:

```sh
orca plugin validate .
orca plugin test .                  # worker tests (src/worker.test.ts, a full setup in a temp home) and test/
orca plugin dev load .              # load into Orca while editing, prints the --approve fingerprint
orca plugin open local.coordinator-board --panel coordinator-board
```
