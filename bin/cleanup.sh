#!/usr/bin/env bash
# Zero-model cleanup: release settled worker terminals, remove clean worktrees whose PR is
# merged or closed. Only worktrees under paths.worktreeRoot are candidates; never the coordinator
# terminal, never a live worker, never a dirty worktree, never --force or --delete-branch.
#   cleanup.sh [-n|--dry-run]   (dry run: lists what it would do as "would release …" /
#   "would remove …" lines and the same summary line; changes nothing)
source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"
COORDINATOR=$(cat "$STATE/coordinator-terminal" 2>/dev/null || true)
ROOT="${CFG_paths_worktreeRoot%/}/"
[ "$ROOT" != "/" ] || { echo "paths.worktreeRoot is not configured: worktrees are left alone" >&2; ROOT="/nonexistent/"; }
DRY=0
case "${1:-}" in -n|--dry-run) DRY=1 ;; esac
RELEASED=released REMOVED=removed
[ "$DRY" = 1 ] && RELEASED="would release" REMOVED="would remove"
run() { if [ "$DRY" = 1 ]; then echo "dry-run: $*" >&2; else "$@" >/dev/null 2>&1; fi; }

released=0; removed=0; kept=0

for dispatch in $("$ORCA" orchestration worker-list --json 2>/dev/null | jq -r --arg c "$COORDINATOR" \
  '.result.workers[] | select((.state != "ready" and .state != "running") and .terminalState == "retained" and .terminal != null and .terminal != $c) | .dispatchId'); do
  run "$ORCA" orchestration worker-release --dispatch "$dispatch" && released=$((released + 1)) && echo "$RELEASED $dispatch"
done

while IFS=$'\t' read -r path branch; do
  [ -n "$branch" ] || continue
  prs=$(cd "$path" && "$GH" pr list --head "${branch#refs/heads/}" --state all --json state,headRefOid -q '.[] | "\(.state) \(.headRefOid)"' 2>/dev/null)
  if [ -z "$prs" ] || grep -q '^OPEN ' <<<"$prs"; then kept=$((kept + 1)); continue; fi
  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then kept=$((kept + 1)); continue; fi
  # Commits after the PR's head were never merged: keep the worktree unless they are on a remote.
  in_pr=0
  while read -r _ sha; do
    [ -n "$sha" ] && git -C "$path" merge-base --is-ancestor HEAD "$sha" 2>/dev/null && { in_pr=1; break; }
  done <<<"$prs"
  if [ "$in_pr" = 0 ] && [ -n "$(git -C "$path" rev-list -n 1 HEAD --not --remotes 2>/dev/null || echo unknown)" ]; then
    kept=$((kept + 1)); echo "kept ${path#"$ROOT"}: commits not in its PR nor on a remote"; continue
  fi
  run "$ORCA" worktree rm --worktree "path:$path" --json && removed=$((removed + 1)) && echo "$REMOVED ${path#"$ROOT"}"
done < <("$ORCA" worktree list --json 2>/dev/null | jq -r --arg root "$ROOT" \
  '.result.worktrees[] | select(.isMainWorktree | not) | select(.path | startswith($root)) | [.path, .branch] | @tsv')

echo "released $released sessions, removed $removed worktrees, kept $kept (dirty/open/unpushed)"

[ "$DRY" = 1 ] || "$PKG/bin/metrics.sh" >/dev/null 2>&1 || true
