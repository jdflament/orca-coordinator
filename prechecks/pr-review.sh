#!/usr/bin/env bash
# Exit 0 when an open, non-draft PR in github.org requests review from the human or one of
# github.reviewTeams, or is assigned to them, is not theirs, and its head commit was not reviewed yet.
source "$(dirname "${BASH_SOURCE[0]}")/../bin/lib/precheck.sh"
ORG="$CFG_github_org"; ME="$CFG_person_github"
[ -n "$ORG" ] && [ -n "$ME" ] || { echo "github.org / person.github not configured" >&2; exit 3; }
SEEN="$(seen_file pr-reviewed)"
search() { "$GH" search prs "$@" --state=open --owner "$ORG" --json number,repository,author --limit 50 2>/dev/null; }
results="$(search --review-requested=@me; search --assignee=@me)"
IFS=', ' read -r -a teams <<< "${CFG_github_reviewTeams:-}"
for team in "${teams[@]:-}"; do [ -n "$team" ] && results="$results$(search --review-requested="$team")"; done
prs="$(printf '%s' "$results" | jq -rs --arg me "$ME" 'add // [] | map(select(.author.login != $me)) | unique_by(.repository.name, .number) | .[] | "\(.repository.name) \(.number)"')" || exit 4
[ -n "$prs" ] || exit 1

pending=""
while read -r repo num; do
  [ -n "$repo" ] || continue
  tr ',' '\n' <<< "${CFG_github_skipRepos:-}" | sed 's/^ *//; s/ *$//' | grep -qxF -- "$repo" && continue
  sha=$("$GH" pr view "$num" --repo "$ORG/$repo" --json headRefOid,isDraft --jq 'select(.isDraft|not) | .headRefOid' 2>/dev/null) || continue
  [ -n "$sha" ] || continue
  key="$repo#$num@$sha"
  grep -qxF "$key" "$SEEN" || pending="$pending $key"
done <<< "$prs"

[ -n "$pending" ] || exit 1
echo "to review:$pending"
exit 0
