#!/usr/bin/env bash
# Exit 0 when any rendered playbook's sha differs from playbook-sha.txt (or is new).
# On exit 0: writes the changed names to playbook-changed.txt and refreshes playbook-sha.txt.
source "$(dirname "${BASH_SOURCE[0]}")/../bin/lib/precheck.sh"
PLAYBOOKS="$STATE/playbooks"
SHAS="$STATE_DIR/playbook-sha.txt"; CHANGED="$STATE_DIR/playbook-changed.txt"
touch "$SHAS"
[ -d "$PLAYBOOKS" ] || exit 3
current=$(cd "$PLAYBOOKS" && shasum -a 256 *.md | awk '{sub(/\.md$/, "", $2); print $2, $1}' | sort)
changed=$(printf '%s\n' "$current" | while read -r name sha; do grep -qx "$name $sha" "$SHAS" || echo "$name"; done)
[ -n "$changed" ] || { echo "no playbook changed"; exit 1; }
printf '%s\n' "$changed" > "$CHANGED"
printf '%s\n' "$current" > "$SHAS"
echo "changed: $(printf '%s' "$changed" | tr '\n' ' ')"
exit 0
