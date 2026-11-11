#!/usr/bin/env bash
# Coordinator metrics, no model. Appends one row to <state>/metrics.tsv and prints it.
source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"
LESSONS="$STATE/lessons.md"
STATE_MD="$STATE/state.md"
METRICS="$STATE/metrics.tsv"
today=$(today)
week_ago=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d)
run=$(grep -oE "run_[a-f0-9]+" "$STATE_MD" 2>/dev/null | head -1)

# grep -c prints 0 and exits 1 on no match: `|| echo 0` would add a second line to the row.
corrections_today=$(grep -c "^- $today" "$LESSONS" 2>/dev/null || true)
corrections_7d=$(awk -v w="$week_ago" '/^- 20/ && substr($2,1,10) >= w' "$LESSONS" 2>/dev/null | wc -l | tr -d ' ')
inbox=""
[ -n "$run" ] && inbox=$("$ORCA" orchestration inbox --terminal "run:$run" --limit 500 2>/dev/null || true)
escalations=$(printf '%s\n' "$inbox" | grep -cE "^msg_\S+ escalation" || true)
questions=$(printf '%s\n' "$inbox" | grep -cE "^msg_\S+ question" || true)
done_reports=$(printf '%s\n' "$inbox" | grep -cE "^msg_\S+ worker_done" || true)
workers_total=$("$ORCA" orchestration worker-list --json 2>/dev/null | jq '.result.workers | length' 2>/dev/null || echo 0)
stale_drops=$(cat "$STATE_MD" "$STATE"/archive/done-*.md 2>/dev/null | grep -ci "dropped" || true)
waiting=$(awk -v h="## Waiting for $CFG_person_name" 'index($0, h)==1{f=1;next} /^## /{f=0} f && /^[0-9]+\. /' "$STATE_MD" 2>/dev/null | wc -l | tr -d ' ')
state_bytes=$(wc -c < "$STATE_MD" 2>/dev/null | tr -d ' ' || echo 0)
reports=$(ls "$STATE/reports" 2>/dev/null | wc -l | tr -d ' ')

for v in corrections_today corrections_7d escalations questions done_reports workers_total stale_drops waiting state_bytes reports; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || printf -v "$v" '%s' 0
done
row="$today	$corrections_today	$corrections_7d	$escalations	$questions	$done_reports	$workers_total	$stale_drops	$waiting	$state_bytes	$reports"
[ -f "$METRICS" ] || printf 'date\tcorrections_today\tcorrections_7d\tescalations_run\tquestions_run\tworker_done_run\tworkers_run\tstale_drops\twaiting\tstate_bytes\treports\n' > "$METRICS"
printf '%s\n' "$row" >> "$METRICS"
printf '%s\n' "$row"
