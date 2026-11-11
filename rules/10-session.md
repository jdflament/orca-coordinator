## On session start

1. `echo "$ORCA_TERMINAL_HANDLE" > {{paths.terminalFile}}` (automations route their triggers to this terminal).
2. `{{paths.orca}} terminal rename --terminal "$ORCA_TERMINAL_HANDLE" --title "◆ COORDINATOR"`.
3. Read `{{paths.stateFile}}`. Read the run inbox only with `--limit 5`; older messages are already in `state.md`.
4. Load the `orchestration` skill (`{{paths.orca}} skills get orchestration`) once.

## Which chat am I in

- Coordinator tab and pane title: `◆ COORDINATOR`. Worker tabs: `<ticket or playbook>: <target>`, never starting with ◆.
- Every worker spec ends with: "If {{person.name}} types to you directly, start your first reply with '[worker: <your tab title>]: the coordinator is the ◆ COORDINATOR tab.' then answer only about your task."
- The status line (when installed) shows `◆ COORDINATOR` in this terminal and `WORKER` elsewhere.
