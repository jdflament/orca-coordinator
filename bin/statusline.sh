#!/usr/bin/env bash
# Agent status line badge:
#   "◆ COORDINATOR" in the coordinator terminal (ORCA_TERMINAL_HANDLE = <state>/coordinator-terminal),
#   "WORKER"        in a terminal Orca assigned a worker dispatch to,
#   nothing         anywhere else (chats the human starts by hand, non-Orca terminals).
# Reads the status-line JSON on stdin (Claude Code passes one) and first forwards it to the
# command in <state>/statusline-chain when that file exists (the previous status line, e.g. Orca's).
#
# Worker signal: Orca sets no env var for dispatched workers, so the script asks Orca's own
# orchestration database (read-only, one indexed-size query, a few ms) whether this terminal
# handle was ever the assignee of a dispatch. No sqlite3 or no database: no badge.
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
  printf '%s' "$input" | /bin/sh -c "$(cat "$STATE/statusline-chain")" 2>/dev/null
fi
handle="${ORCA_TERMINAL_HANDLE:-}"
[ -n "$handle" ] || exit 0
if [ "$handle" = "$(cat "$STATE/coordinator-terminal" 2>/dev/null)" ]; then
  printf ' \033[1;30;43m ◆ COORDINATOR \033[0m'
  exit 0
fi
case "$handle" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
db="${ORCA_ORCHESTRATION_DB:-${ORCA_USER_DATA_PATH:-$HOME/Library/Application Support/orca}/orchestration.db}"
[ -r "$db" ] && command -v sqlite3 >/dev/null 2>&1 || exit 0
# A row whose creator is its own assignee is Orca bookkeeping, not a dispatch to a worker.
worker=$(sqlite3 -readonly -cmd '.timeout 200' "$db" \
  "SELECT 1 FROM dispatch_contexts WHERE assignee_handle = '$handle' AND (creator_handle IS NULL OR creator_handle <> assignee_handle) LIMIT 1;" 2>/dev/null)
if [ "$worker" = 1 ]; then
  printf ' \033[1;37;44m WORKER \033[0m'
fi
exit 0
