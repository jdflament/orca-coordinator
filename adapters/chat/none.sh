#!/usr/bin/env bash
# No chat tool configured: drafts still work (they are files); everything else exits 2.
source "$(dirname "${BASH_SOURCE[0]}")/../../bin/lib/env.sh"
if [ "${1:-}" = "draft" ]; then
  mkdir -p "$STATE/drafts"; file="$STATE/drafts/$(date +%Y%m%d-%H%M%S)-${2:?channel}.md"
  printf '# Draft for %s\n\n%s\n' "$2" "${3:?text}" > "$file"; echo "$file"; exit 0
fi
echo "no chat adapter configured (adapters.chat.kind: none)" >&2
exit 2
