#!/usr/bin/env bash
# GitHub issues through `gh`. Ids are "owner/repo#123" (or "repo#123" with github.org). See adapters/README.md.
source "$(dirname "${BASH_SOURCE[0]}")/../../bin/lib/env.sh"
ORG="$CFG_github_org"
split() { local id="$1"; REPO="${id%%#*}"; NUM="${id##*#}"; [[ "$REPO" == */* ]] || REPO="$ORG/$REPO"; }
cmd="${1:-}"; shift || true
case "$cmd" in
  get) split "${1:?id}"; "$GH" issue view "$NUM" --repo "$REPO" --comments --json number,title,body,state,labels,assignees,comments,url ;;
  list)
    out=$("$GH" search issues --assignee=@me --state=open ${ORG:+--owner "$ORG"} --limit 100 --json number,repository,labels,state 2>/dev/null) || exit 4
    if [ "${1:-}" = "--todo" ]; then
      printf '%s' "$out" | jq -r --arg states "$CFG_adapters_ticketing_todoStates" '
        ($states | split(", ")) as $todo | .[] | select(([.labels[].name] | map(. as $l | $todo | index($l)) | any) or ($todo | index("open"))) | "\(.repository.nameWithOwner)#\(.number)"'
    else
      printf '%s' "$out" | jq -r '.[] | "\(.repository.nameWithOwner)#\(.number)"'
    fi ;;
  url) split "${1:?id}"; printf 'https://github.com/%s/issues/%s\n' "$REPO" "$NUM" ;;
  comment) require_yes "$@"; split "${1:?id}"; "$GH" issue comment "$NUM" --repo "$REPO" --body "${2:?text}" ;;
  status) require_yes "$@"; split "${1:?id}"; case "${2:?state}" in closed|done) "$GH" issue close "$NUM" --repo "$REPO" ;; *) "$GH" issue reopen "$NUM" --repo "$REPO" ;; esac ;;
  create)
    require_yes "$@"
    json="${1:?json}"
    repo=$(printf '%s' "$json" | jq -r '.repo // ""'); [[ "$repo" == */* ]] || repo="$ORG/$repo"
    title=$(printf '%s' "$json" | jq -r .title); desc=$(printf '%s' "$json" | jq -r '.description // ""')
    labels=$(printf '%s' "$json" | jq -r '(.labels // []) | join(",")')
    "$GH" issue create --repo "$repo" --title "$title" --body "$desc" ${labels:+--label "$labels"} ;;
  *) echo "usage: github.sh get <id> | list [--todo] | url <id> | comment <id> <text> --yes | status <id> <state> --yes | create <json> --yes" >&2; exit 1 ;;
esac
