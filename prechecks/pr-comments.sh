#!/usr/bin/env bash
# Exit 0 when at least one open PR authored by the human in github.org has something waiting:
# an unresolved review thread whose last comment is not theirs, or a conversation comment from
# someone else after their last one, and that set differs from the last trigger.
source "$(dirname "${BASH_SOURCE[0]}")/../bin/lib/precheck.sh"
ORG="$CFG_github_org"
[ -n "$ORG" ] || { echo "github.org not configured" >&2; exit 3; }
me="$("$GH" api user --jq .login 2>/dev/null)" || exit 4
prs="$("$GH" search prs --author=@me --state=open --owner "$ORG" --json number,repository --limit 50 2>/dev/null)" || exit 4
[ "$(printf '%s' "$prs" | jq 'length')" -gt 0 ] || exit 1

found=0; sig=""
while read -r repo num; do
  hits=$("$GH" api graphql \
    -f query='query($owner:String!,$name:String!,$n:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$n){
      reviewThreads(first:100){ nodes{ isResolved comments(last:1){ nodes{ createdAt author{ login } } } } }
      comments(last:100){ nodes{ createdAt author{ __typename login } } } } } }' \
    -f owner="$ORG" -f name="$repo" -F n="$num" 2>/dev/null \
    | jq -r --arg me "$me" '
      .data.repository.pullRequest as $pr
      | [$pr.reviewThreads.nodes[] | select(.isResolved|not) | .comments.nodes[0] | select(.author.login != $me) | .createdAt] as $threads
      | ([$pr.comments.nodes[] | select(.author.login == $me) | .createdAt] | max // "") as $mine
      | [$pr.comments.nodes[] | select(.author.__typename != "Bot") | select(.author.login != $me) | select(.createdAt > $mine) | .createdAt] as $convo
      | ($threads + $convo) | "\(length) \(max // "")"')
  if [ "${hits%% *}" -gt 0 ] 2>/dev/null; then
    sig="$sig$repo#$num $hits"$'\n'
    echo "$repo#$num items waiting: ${hits%% *}"
    found=1
  fi
done < <(printf '%s' "$prs" | jq -r '.[] | "\(.repository.name) \(.number)"')

[ "$found" -eq 1 ] || { sig_changed pr-comments "" >/dev/null; exit 1; }
sig_changed pr-comments "$sig" || exit 1
exit 0
