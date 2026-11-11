#!/usr/bin/env bash
# lessons.sh add "<what I missed>" "<rule that would have caught it>" | list [--days N]
# One line per correction the human makes: `- YYYY-MM-DD | miss | rule`. Read by the weekly
# eval worker, never by the coordinator on its own turns.
source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"
LESSONS="$STATE/lessons.md"
[ -f "$LESSONS" ] || printf '# Lessons\nOne line per correction: date | what I missed | rule that would have caught it.\n\n' > "$LESSONS"
case "${1:-}" in
  add)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "usage: lessons add \"<miss>\" \"<rule>\"" >&2; exit 1; }
    printf -- '- %s | %s | %s\n' "$(today)" "$2" "$3" >> "$LESSONS"
    tail -1 "$LESSONS"
    ;;
  list)
    days=0
    [ "${2:-}" = "--days" ] && days="${3:-7}"
    if [ "$days" -gt 0 ]; then
      since=$(date -v-"$days"d +%Y-%m-%d 2>/dev/null || date -d "$days days ago" +%Y-%m-%d)
      awk -v w="$since" '/^- 20/ && substr($2,1,10) >= w' "$LESSONS"
    else
      grep '^- 20' "$LESSONS" || true
    fi
    ;;
  *) echo "usage: lessons add \"<miss>\" \"<rule>\" | list [--days N]" >&2; exit 1 ;;
esac
