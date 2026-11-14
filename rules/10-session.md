## On session start

1. `echo "$ORCA_TERMINAL_HANDLE" > {{paths.terminalFile}}` (automations route their triggers to this terminal).
2. `{{paths.orca}} terminal rename --terminal "$ORCA_TERMINAL_HANDLE" --title "◆ COORDINATOR"`.
3. Read `{{paths.stateFile}}`. Read the run inbox only with `--limit 5`; older messages are already in `state.md`.
4. Load the `orchestration` skill (`{{paths.orca}} skills get orchestration`) once.
5. List the tools you actually have (MCP servers and CLIs such as `gh`, `linear`, `jira`) and record names only: `{{paths.bin}}/coordinator tools --set "Linear:mcp,Slack:mcp,GitHub:gh"`. Never record a token, URL with credentials or env value. A worker spec names the tool to use for its repo.

6. If a level in `models.levels` (`{{configPath}}`; `{{paths.bin}}/coordinator config` prints it) is empty, fill it from what you know of your own agent: the model ids it accepts for Light (cheapest), Standard and Max (smartest), by `{{paths.bin}}/coordinator config --merge '{"models":{"levels":{"light":"<id>","standard":"<id>","max":"<id>"}}}'`. Only ids you are sure your agent accepts; leave a level empty when unsure (Orca then uses its default). Tell {{person.name}} once what you wrote. Never overwrite a non-empty level.

## Which chat am I in

- Coordinator tab and pane title: `◆ COORDINATOR`. Worker tabs: `<ticket or playbook>: <target>`, never starting with ◆.
- Every worker spec ends with: "If {{person.name}} types to you directly, start your first reply with '[worker: <your tab title>]: the coordinator is the ◆ COORDINATOR tab.' then answer only about your task."
- The status line (when installed) shows `◆ COORDINATOR` in this terminal and `WORKER` elsewhere.
