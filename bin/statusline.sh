#!/usr/bin/env bash
# Agent status line badge:
#   "◆ COORDINATOR" in the coordinator terminal (ORCA_TERMINAL_HANDLE = <state>/coordinator-terminal),
#   "WORKER"        in a terminal Orca assigned a worker dispatch to,
#   nothing         anywhere else (chats the human starts by hand, non-Orca terminals).
# Reads the status-line JSON on stdin (Claude Code passes one) and first forwards it to the
# command in <state>/statusline-chain when that file exists (the previous status line, e.g. Orca's).
#
# Worker signal: the plugin keeps <state>/worker-terminals (one terminal handle per line, the
# terminals Orca dispatched workers to); this script only reads it. No file: no WORKER badge.
#
# The chained command is run without a shell: its words are split on whitespace and a leading ~
# is expanded. A command that needs shell syntax (quotes, pipes, variables, ;) is not run.
#
# Orca and settings.json: Orca writes its statusLine only when the slot is empty or already holds
# its own command; a user command like this one is left alone. `orca-coordinator doctor` reports
# when statusLine no longer points here; `orca-coordinator statusline` re-chains it.
input=$(cat)
# A chain that leads back here would loop forever.
[ -n "${ORCA_COORDINATOR_STATUSLINE:-}" ] && exit 0
export ORCA_COORDINATOR_STATUSLINE=1
STATE="${COORDINATOR_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/orca-coordinator}"
if [ -s "$STATE/statusline-chain" ]; then
  read -r -a chain < "$STATE/statusline-chain"
  case "${chain[*]}" in
    *[\'\"\$\`\\\;\&\|\<\>\(\)\*\?\{\}]*) ;;
    *) chain=("${chain[@]/#\~/$HOME}"); printf '%s' "$input" | "${chain[@]}" 2>/dev/null ;;
  esac
fi
handle="${ORCA_TERMINAL_HANDLE:-}"
[ -n "$handle" ] || exit 0
if [ "$handle" = "$(cat "$STATE/coordinator-terminal" 2>/dev/null)" ]; then
  printf ' \033[1;30;43m ◆ COORDINATOR \033[0m'
  exit 0
fi
case "$handle" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
if grep -qxF "$handle" "$STATE/worker-terminals" 2>/dev/null; then
  printf ' \033[1;37;44m WORKER \033[0m'
fi
exit 0
