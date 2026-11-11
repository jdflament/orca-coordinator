#!/usr/bin/env bash
# Agent status line: "◆ COORDINATOR" in the coordinator terminal, "WORKER" elsewhere.
# Reads the status-line JSON on stdin (Claude Code passes one); forwards it to the
# command in <state>/statusline-chain when that file exists (your previous status line).
input=$(cat)
STATE="${COORDINATOR_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/orca-coordinator}"
if [ -s "$STATE/statusline-chain" ]; then
  printf '%s' "$input" | /bin/sh -c "$(cat "$STATE/statusline-chain")" 2>/dev/null
fi
if [ -n "${ORCA_TERMINAL_HANDLE:-}" ] && [ "$ORCA_TERMINAL_HANDLE" = "$(cat "$STATE/coordinator-terminal" 2>/dev/null)" ]; then
  printf ' \033[1;30;43m ◆ COORDINATOR \033[0m'
else
  printf ' \033[1;37;44m WORKER \033[0m \033[2mnot the coordinator\033[0m'
fi
