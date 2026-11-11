#!/usr/bin/env bash
# Helpers for prechecks: a precheck exits 0 only when something new waits since the
# last trigger. State lives in $STATE_DIR (one small file per precheck).
#   sig_changed <name> <signature>   → 0 when the signature differs from the stored one (and stores it)
#   seen_file <name>                 → path of the "already handled" list (one key per line)
#   unseen <name> <key>...           → prints keys absent from that list
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

sig_changed() {
  local file="$STATE_DIR/$1-last.txt" sig="$2"
  touch "$file"
  if [ "$sig" = "$(cat "$file")" ]; then return 1; fi
  printf '%s' "$sig" > "$file"
  return 0
}

seen_file() { local f="$STATE_DIR/$1.txt"; touch "$f"; printf '%s' "$f"; }

unseen() {
  local file; file="$(seen_file "$1")"; shift
  for key in "$@"; do grep -qxF "$key" "$file" || printf '%s\n' "$key"; done
}
