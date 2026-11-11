#!/usr/bin/env bash
# Jira through jira-cli (https://github.com/ankitpokhrel/jira-cli). See adapters/README.md.
source "$(dirname "${BASH_SOURCE[0]}")/../../bin/lib/env.sh"
JIRA="${JIRA:-jira}"
PROJECT="${CFG_adapters_ticketing_team:-}"
cmd="${1:-}"; shift || true
case "$cmd" in
  get) "$JIRA" issue view "${1:?id}" --comments 20 --raw ;;
  list)
    if [ "${1:-}" = "--todo" ]; then
      IFS=', ' read -r -a states <<< "$CFG_adapters_ticketing_todoStates"
      for s in "${states[@]}"; do "$JIRA" issue list -a"$("$JIRA" me)" -s"$s" ${PROJECT:+-p"$PROJECT"} --plain --no-headers --columns key 2>/dev/null; done | awk 'NF' | sort -u
    else
      "$JIRA" issue list -a"$("$JIRA" me)" ${PROJECT:+-p"$PROJECT"} --plain --no-headers --columns key | awk 'NF'
    fi ;;
  url) printf '%s\n' "${CFG_adapters_ticketing_issueUrl//\{id\}/${1:?id}}" ;;
  comment) require_yes "$@"; "$JIRA" issue comment add "${1:?id}" "${2:?text}" --no-input ;;
  status) require_yes "$@"; "$JIRA" issue move "${1:?id}" "${2:?state}" ;;
  create)
    require_yes "$@"
    json="${1:?json}"
    title=$(printf '%s' "$json" | jq -r .title); desc=$(printf '%s' "$json" | jq -r '.description // ""')
    parent=$(printf '%s' "$json" | jq -r '.parent // ""'); labels=$(printf '%s' "$json" | jq -r '(.labels // []) | join(",")')
    "$JIRA" issue create ${PROJECT:+-p"$PROJECT"} -tTask -s"$title" -b"$desc" ${parent:+-P"$parent"} ${labels:+-l"$labels"} --no-input ;;
  *) echo "usage: jira.sh get <id> | list [--todo] | url <id> | comment <id> <text> --yes | status <id> <state> --yes | create <json> --yes" >&2; exit 1 ;;
esac
