#!/usr/bin/env bash
# Exit 0 when lessons.md gained lines since the last run AND the last run is 6+ days old.
# State: eval-weekly-last.txt = "<lesson line count> <epoch of last run>", written only on exit 0.
source "$(dirname "${BASH_SOURCE[0]}")/../bin/lib/precheck.sh"
LESSONS="$STATE/lessons.md"
FILE="$STATE_DIR/eval-weekly-last.txt"
[ -f "$LESSONS" ] || exit 3
count=$(grep -c '^- 20' "$LESSONS" || true)
last_count=0; last_epoch=0
[ -f "$FILE" ] && read -r last_count last_epoch < "$FILE"
now=$(date +%s)
[ "$count" -gt "$last_count" ] || { echo "no new lessons ($count)"; exit 1; }
[ $((now - last_epoch)) -ge $((6 * 24 * 3600)) ] || { echo "last run $(( (now - last_epoch) / 86400 ))d ago"; exit 1; }
printf '%s %s\n' "$count" "$now" > "$FILE"
echo "new lessons: $((count - last_count))"
exit 0
