#!/usr/bin/env bash
# Linear through Orca's own connector (`orca linear …`). See adapters/README.md.
source "$(dirname "${BASH_SOURCE[0]}")/../../bin/lib/env.sh"
TEAM="${CFG_adapters_ticketing_team:-}"
cmd="${1:-}"; shift || true
case "$cmd" in
  get) "$ORCA" linear issue "${1:?id}" --comments --children --attachments --json ;;
  list)
    out=$("$ORCA" linear list --filter assigned --limit 100 ${TEAM:+--team "$TEAM"} --json) || exit 4
    if [ "${1:-}" = "--todo" ]; then
      printf '%s' "$out" | jq -r --arg states "$CFG_adapters_ticketing_todoStates" '
        ($states | split(", ")) as $todo
        | (.result | (.issues // .)) | .[] | select(((.state.name // .state // .status) as $s | $todo | index($s))) | .identifier'
    else
      printf '%s' "$out" | jq -r '(.result | (.issues // .)) | .[] | .identifier'
    fi ;;
  url) printf '%s\n' "${CFG_adapters_ticketing_issueUrl//\{id\}/${1:?id}}" ;;
  comment) require_yes "$@"; "$ORCA" linear comment add "${1:?id}" --body "${2:?text}" --json ;;
  status) require_yes "$@"; "$ORCA" linear status set "${1:?id}" --status "${2:?state}" --json ;;
  create)
    require_yes "$@"
    json="${1:?json}"
    title=$(printf '%s' "$json" | jq -r .title); desc=$(printf '%s' "$json" | jq -r '.description // ""')
    parent=$(printf '%s' "$json" | jq -r '.parent // ""'); labels=$(printf '%s' "$json" | jq -r '(.labels // []) | join(",")')
    "$ORCA" linear save-issue --team "$TEAM" --title "$title" --description "$desc" ${parent:+--parent "$parent"} ${labels:+--labels "$labels"} --json ;;
  *) echo "usage: linear.sh get <id> | list [--todo] | url <id> | comment <id> <text> --yes | status <id> <state> --yes | create <json> --yes" >&2; exit 1 ;;
esac
