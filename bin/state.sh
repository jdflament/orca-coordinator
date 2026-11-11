#!/usr/bin/env bash
# state.sh check | waiting | archive
#   check    size of state.md against budget.stateBytes (exit 1 when over)
#   waiting  the numbered items under "## Waiting for <name>"
#   archive  move "Done today" items from a previous day into archive/done-<YYYY-MM>.md
source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"
STATE_MD="$STATE/state.md"
NAME="$CFG_person_name"
[ -f "$STATE_MD" ] || { echo "no $STATE_MD" >&2; exit 1; }
case "${1:-check}" in
  check)
    size=$(wc -c < "$STATE_MD" | tr -d ' ')
    if [ "$size" -gt "$CFG_budget_stateBytes" ]; then echo "state.md: $size bytes, over budget ($CFG_budget_stateBytes)"; exit 1; fi
    echo "state.md: $size bytes (budget $CFG_budget_stateBytes)"
    ;;
  waiting)
    awk -v h="## Waiting for $NAME" 'index($0, h)==1{f=1;next} /^## /{f=0} f && /^[0-9]+\. /' "$STATE_MD"
    ;;
  archive)
    header=$(grep -m1 '^## Done today' "$STATE_MD" || true)
    [ -n "$header" ] || { echo "no 'Done today' section"; exit 0; }
    day=$(printf '%s' "$header" | grep -oE '20[0-9]{2}-[0-9]{2}-[0-9]{2}' || true)
    [ -n "$day" ] && [ "$day" != "$(today)" ] || { echo "nothing to archive"; exit 0; }
    items=$(awk '/^## Done today/{f=1;next} /^## /{f=0} f' "$STATE_MD")
    out="$STATE/archive/done-${day%-*}.md"
    [ -f "$out" ] || printf '# Done %s\n' "${day%-*}" > "$out"
    printf '\n## %s\n%s\n' "$day" "$items" >> "$out"
    "$NODE_BIN" -e '
const fs = require("fs"); const [file, today] = process.argv.slice(1)
const lines = fs.readFileSync(file, "utf8").split("\n"); const out = []; let skip = false
for (const l of lines) {
  if (/^## Done today/.test(l)) { out.push(`## Done today (${today})`); skip = true; continue }
  if (skip && /^## /.test(l)) skip = false
  if (!skip) out.push(l)
}
fs.writeFileSync(file, out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n"))' "$STATE_MD" "$(today)"
    echo "archived $day to $out"
    ;;
  *) echo "usage: state check | waiting | archive" >&2; exit 1 ;;
esac
