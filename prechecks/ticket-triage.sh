#!/usr/bin/env bash
# Exit 0 when a ticket assigned to the human sits in one of its tool's todoStates and was not
# triaged yet (identifier absent from state/ticket-triaged.txt). Ticketing is per repository:
# every distinct setup (the default and each repo's own) is listed once.
# The CLI adapters are optional: the coordinator reaches its ticketing tool itself (MCP or CLI).
# With no CLI adapter configured, this shell check cannot look, so the run goes ahead on schedule.
source "$(dirname "${BASH_SOURCE[0]}")/../bin/lib/precheck.sh"
targets="$("$NODE_BIN" "$PKG/bin/coordinator.mjs" adapter ticketing --targets)" || exit 4
if ! printf '%s\n' "$targets" | awk -F'\t' '$2 != "" && $2 != "none" { found = 1 } END { exit !found }'; then
  echo "no ticketing CLI adapter: running on schedule, the coordinator checks with its own tools"
  exit 0
fi
ids=""
while IFS=$'\t' read -r repo kind cmd; do
  [ -n "$kind" ] && [ "$kind" != "none" ] || continue
  [ "$repo" = "-" ] && repo=""
  out="$(COORDINATOR_REPO="$repo" bash "$cmd" list --todo 2>/dev/null)" || exit 4
  ids="$ids$out"$'\n'
done <<< "$targets"
pending="$(printf '%s\n' "$ids" | sort -u | while read -r id; do [ -n "$id" ] && unseen ticket-triaged "$id"; done)"
[ -n "$pending" ] || exit 1
echo "untriaged: $(printf '%s' "$pending" | tr '\n' ' ')"
exit 0
