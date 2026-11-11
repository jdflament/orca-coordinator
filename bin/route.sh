#!/usr/bin/env bash
# Automation precheck + router. Usage: route.sh <playbook> [precheck-name|none]
#   precheck fails            → exit 1 (Orca skips the run)
#   coordinator terminal live → sends "[trigger] <playbook>" to it, exit 2 (skip, no new session)
#   no live coordinator       → exit 0 (the automation runs; its fresh session becomes the coordinator)
# A state.md over budget gets "over budget" appended to the trigger so the coordinator prunes first.
source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"
playbook="${1:?playbook}"
precheck="${2:-none}"

if [ "$precheck" != "none" ]; then
  script="$PKG/prechecks/$precheck.sh"
  [ -x "$script" ] || script="$STATE/automations/precheck-$precheck.sh"
  [ -x "$script" ] || { echo "no precheck named $precheck" >&2; exit 1; }
  "$script" || exit 1
fi

handle_file="$STATE/coordinator-terminal"
[ -s "$handle_file" ] || exit 0
handle="$(cat "$handle_file")"
# Unknown is not "dead": when Orca cannot answer, skip the run rather than start a second coordinator.
list=$("$ORCA" terminal list --json 2>/dev/null) || { echo "orca terminal list failed: skipping, the coordinator may be live" >&2; exit 1; }
live=$(printf '%s' "$list" | "$NODE_BIN" -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let t
  try { t = JSON.parse(s).result.terminals } catch { t = undefined }
  if (!Array.isArray(t)) return process.stdout.write("unknown")
  const h = process.argv[1]
  process.stdout.write(t.some((x) => x.handle === h && x.connected && x.agentIdentity) ? "yes" : "no")
})' "$handle")
[ "$live" != "unknown" ] || { echo "orca terminal list gave no terminal list: skipping, the coordinator may be live" >&2; exit 1; }
[ "$live" = "yes" ] || exit 0

msg="[trigger] $playbook"
size=$(wc -c < "$STATE/state.md" 2>/dev/null | tr -d ' ' || echo 0)
[ "${size:-0}" -gt "$CFG_budget_stateBytes" ] && msg="$msg (state.md is $size bytes, over budget: prune it first)"
"$ORCA" terminal send --terminal "$handle" --text "$msg" --enter --json >/dev/null 2>&1 || exit 0
exit 2
