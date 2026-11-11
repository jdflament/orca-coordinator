#!/usr/bin/env bash
# Unleash admin API, read-only unless --yes. Config: adapters.flags.{baseUrl, project, secretRef, uiUrl}.
source "$(dirname "${BASH_SOURCE[0]}")/../../bin/lib/env.sh"
set -o pipefail
BASE="${CFG_adapters_flags_baseUrl%/}/api/admin/projects/${CFG_adapters_flags_project:-default}"
[ -n "${CFG_adapters_flags_baseUrl:-}" ] || { echo "adapters.flags.baseUrl not configured" >&2; exit 3; }
SECRET=$(resolve_secret "${CFG_adapters_flags_secretRef:-}") || { echo "no flags credential (adapters.flags.secretRef)" >&2; exit 3; }
req() { curl -sS -f -X "$1" -H "Authorization: $SECRET" -H "Content-Type: application/json" "$2"; }
cmd="${1:-}"; shift || true
case "$cmd" in
  get)
    out=$(req GET "$BASE/features/${1:?flag}" 2>/dev/null) || { echo "$1: not found"; exit 3; }
    printf '%s' "$out" | jq -r '
      "\(.name)\(if .archived then " archived" else "" end)",
      (.environments[] | "  \(.name) \(if .enabled then "ON" else "off" end)",
        (.strategies[]? | "    - \(.name) \(.parameters.rollout // "") | " +
          ([.constraints[]? | "\(.contextName) \(if .inverted then "NOT IN" else .operator end) \((.values // []) | join(","))"] | join("; ") | if . == "" then "no constraints" else . end) +
          " | segments: \(.segments // [] | tostring)"))' ;;
  list)
    req GET "$BASE/features" | jq -r --arg q "${1:-}" '.features[] | select(.name | contains($q)) | "\(.name) " + ([.environments[] | "\(.name[0:4]):\(if .enabled then "ON" else "off" end)"] | join(" "))' ;;
  url) printf '%s\n' "${CFG_adapters_flags_uiUrl//\{flag\}/${1:?flag}}" ;;
  toggle)
    require_yes "$@"
    flag="${1:?flag}"; env="${2:?env}"; on="${3:?on|off}"
    case "$on" in on|off) ;; *) echo "toggle: state must be on|off, got \"$on\"" >&2; exit 1 ;; esac
    req POST "$BASE/features/$flag/environments/$env/$on" >/dev/null && echo "$flag $env -> $on" ;;
  *) echo "usage: unleash.sh get <flag> | list [query] | url <flag> | toggle <flag> <env> on|off --yes" >&2; exit 1 ;;
esac
