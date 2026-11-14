#!/usr/bin/env bash
# Zero-model facts for the onboarding-scan playbook. Read-only: prints one tab-separated line per
# fact, `<kind>\t<fields…>`, and never writes the board. A failed tool prints "<kind>\tunavailable".
#   version     <installed> <latest|unknown> <current|outdated>
#   automation  <id> <enabled|disabled> <ours:<playbook>|other> <name>
#   review      <repo#n> <url> <title>      open PR asking for your review, not on the board yet
#   mine        <repo#n> <url> <comments>   your open PR with comments, not on the board yet
#   repo        <name> <branch> <dirty files> <commits not on a remote>
source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"
BOARD="$STATE/board.json"
ORG="$CFG_github_org"; ME="$CFG_person_github"
TAB=$'\t'

# A PR already on the board (any decision or task carrying its url) is not listed again.
on_board() { [ -f "$BOARD" ] && jq -e --arg u "$1" '[.decisions[]?.url, .tasks[]?.url] | index($u) != null' "$BOARD" >/dev/null 2>&1; }

installed=$(jq -r .version "$PKG/package.json" 2>/dev/null)
slug=$(jq -r '.repository.url // ""' "$PKG/package.json" 2>/dev/null | sed -E 's#^.*github\.com[/:]##; s#\.git$##')
latest=$([ -n "$slug" ] && "$GH" api "repos/$slug/tags" --jq '.[].name' 2>/dev/null | sed 's/^v//' | sort -V | tail -1)
if [ -z "$latest" ]; then echo "version${TAB}${installed:-unknown}${TAB}unknown${TAB}current"
elif [ "$(printf '%s\n%s\n' "$installed" "$latest" | sort -V | tail -1)" != "$installed" ]; then echo "version${TAB}$installed${TAB}$latest${TAB}outdated"
else echo "version${TAB}$installed${TAB}$latest${TAB}current"; fi

if list=$("$ORCA" automations list --json 2>/dev/null); then
  printf '%s' "$list" | jq -r '.result.automations[]? | [.id, (if .enabled then "enabled" else "disabled" end),
    (((.prompt // "") | capture("^\\[trigger\\] (?<p>[\\w-]+)$").p // empty) | "ours:" + .) // "other", .name] | @tsv' 2>/dev/null \
    | sed 's/^/automation\t/'
else echo "automation${TAB}unavailable"; fi

if [ -n "$ORG" ]; then
  if prs=$("$GH" search prs --review-requested=@me --state=open --owner "$ORG" --json number,repository,url,title,author --limit 50 2>/dev/null); then
    printf '%s' "$prs" | jq -r --arg me "$ME" '.[] | select(.author.login != $me) | ["\(.repository.name)#\(.number)", .url, .title] | @tsv' \
      | while IFS=$'\t' read -r key url title; do on_board "$url" || printf 'review\t%s\t%s\t%s\n' "$key" "$url" "$title"; done
  else echo "review${TAB}unavailable"; fi
  if prs=$("$GH" search prs --author=@me --state=open --owner "$ORG" --json number,repository,url,commentsCount --limit 50 2>/dev/null); then
    printf '%s' "$prs" | jq -r '.[] | select(.commentsCount > 0) | ["\(.repository.name)#\(.number)", .url, .commentsCount] | @tsv' \
      | while IFS=$'\t' read -r key url n; do on_board "$url" || printf 'mine\t%s\t%s\t%s\n' "$key" "$url" "$n"; done
  else echo "mine${TAB}unavailable"; fi
fi

"$NODE_BIN" "$PKG/bin/coordinator.mjs" config --json 2>/dev/null | jq -r '.repos[]? | [.name, .path] | @tsv' \
  | while IFS=$'\t' read -r name path; do
    branch=$(git -C "$path" branch --show-current 2>/dev/null)
    dirty=$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    ahead=$(git -C "$path" rev-list --count HEAD --not --remotes 2>/dev/null || echo "?")
    printf 'repo\t%s\t%s\t%s\t%s\n' "$name" "${branch:-detached}" "$dirty" "$ahead"
  done
