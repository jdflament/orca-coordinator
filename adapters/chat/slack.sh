#!/usr/bin/env bash
# Slack through the Web API (credential from adapters.chat.secretRef). See adapters/README.md.
# When adapters.chat.via is mcp:<tool>, the agent reads chat through that tool; this
# script still handles drafts and (gated) posts.
source "$(dirname "${BASH_SOURCE[0]}")/../../bin/lib/env.sh"
set -o pipefail
# The credential is resolved here, not inside `api ... | jq`: an exit in a pipeline stage only
# leaves that stage, and the script would report success.
secret() { SECRET=$(resolve_secret "${CFG_adapters_chat_secretRef:-}") || { echo "no chat credential (adapters.chat.secretRef)" >&2; exit 3; }; }
api() { curl -sS -f -H "Authorization: Bearer $SECRET" "$@"; }
cmd="${1:-}"; shift || true
case "$cmd" in search|post) secret ;; esac
case "$cmd" in
  search) api -G "https://slack.com/api/search.messages" --data-urlencode "query=${1:?query}" --data-urlencode "count=50" | jq '.messages.matches[]? | {channel: .channel.name, user: .username, ts, text, permalink}' ;;
  draft)
    mkdir -p "$STATE/drafts"; file="$STATE/drafts/$(date +%Y%m%d-%H%M%S)-${1:?channel}.md"
    printf '# Draft for %s\n\n%s\n' "$1" "${2:?text}" > "$file"; echo "$file" ;;
  post)
    require_yes "$@"
    tr ',' '\n' <<< "${CFG_adapters_chat_draftOnlyChannels:-}" | sed 's/^ *//; s/ *$//' | grep -qxF -- "${1:?channel}" && { echo "refused: $1 is draft-only (adapters.chat.draftOnlyChannels)" >&2; exit 4; }
    api -X POST https://slack.com/api/chat.postMessage -H 'Content-Type: application/json; charset=utf-8' \
      -d "$(jq -n --arg c "$1" --arg t "${2:?text}" '{channel: $c, text: $t}')" | jq '{ok, ts, channel, error}' ;;
  *) echo "usage: slack.sh search <query> | draft <channel> <text> | post <channel> <text> --yes" >&2; exit 1 ;;
esac
