#!/usr/bin/env bash
# Zero-model cleanup: release settled worker terminals, remove Orca worktrees that are done or
# unused, and prune stale git worktree entries. Orca decides what a worktree is (`orca worktree
# list`) and removes it (`orca worktree rm`); paths.worktreeRoot, when set, only narrows the list.
# A worktree is removed when its branch is merged into the default branch or its PR is merged
# (squash included) or closed, AND it is clean, has no commits that exist nowhere else, and has no
# live worker or open terminal. Merged tasks and answered decisions move to archive/done-YYYY-MM.md.
# Never the main checkout, the coordinator terminal, a live worker,
# --force or --delete-branch.
#   cleanup.sh [-n|--dry-run]   (dry run: "would release …" / "would remove …" / "kept <name>: <why>"
#   lines and the same summary line; changes nothing)
source "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"
COORDINATOR=$(cat "$STATE/coordinator-terminal" 2>/dev/null || true)
ROOT="${CFG_paths_worktreeRoot%/}/"
[ "$ROOT" != "/" ] || ROOT=""
DRY=0
case "${1:-}" in -n|--dry-run) DRY=1 ;; esac
RELEASED=released REMOVED=removed
[ "$DRY" = 1 ] && RELEASED="would release" REMOVED="would remove"
run() { if [ "$DRY" = 1 ]; then echo "dry-run: $*" >&2; else "$@" >/dev/null 2>&1; fi; }

released=0; removed=0; kept=0; archived=0

WORKERS=$("$ORCA" orchestration worker-list --json --limit 100 2>/dev/null || true)
RELEASING=" "
while IFS=$'\t' read -r dispatch terminal wstate; do
  [ -n "$dispatch" ] || continue
  run "$ORCA" orchestration worker-release --dispatch "$dispatch" && released=$((released + 1)) && RELEASING="$RELEASING$terminal " && echo "workers: $RELEASED $dispatch ($wstate)"
done < <(jq -r --arg c "$COORDINATOR" \
  '.result.workers[]? | select((.state != "ready" and .state != "running") and .liveness != "live" and .terminalState == "retained" and .terminal != null and .terminal != $c) | [.dispatchId, .terminal, .state] | @tsv' <<<"$WORKERS")

# Where work is still going on: a live worker's workspace ("<repo id>::<path>") or any open terminal
# (the ones this run just released do not count).
BUSY=$'\n'
BUSY+=$(jq -r '.result.workers[]? | select(.liveness == "live") | .workspace // empty | sub("^.*::"; "")' <<<"$WORKERS")$'\n'
while IFS=$'\t' read -r handle wpath; do
  case "$RELEASING" in *" $handle "*) continue ;; esac
  BUSY+="$wpath"$'\n'
done < <("$ORCA" terminal list --json 2>/dev/null | jq -r '.result.terminals[]? | [.handle, .worktreePath // ""] | @tsv')

LIST=$("$ORCA" worktree list --json 2>/dev/null || true)

default_ref() {
  local ref
  ref=$(git -C "$1" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null) && { echo "$ref"; return; }
  for ref in origin/main origin/master main master; do
    git -C "$1" rev-parse -q --verify "refs/remotes/$ref" >/dev/null 2>&1 && { echo "$ref"; return; }
    git -C "$1" rev-parse -q --verify "refs/heads/$ref" >/dev/null 2>&1 && { echo "$ref"; return; }
  done
}

while IFS=$'\t' read -r path branch; do
  [ -n "$path" ] || continue
  [ -z "$ROOT" ] || case "$path" in "$ROOT"*) ;; *) continue ;; esac
  if [ -n "$ROOT" ]; then name="${path#"$ROOT"}"; else name="$(basename "$(dirname "$path")")/$(basename "$path")"; fi
  keep() { kept=$((kept + 1)); echo "worktrees: kept $name: $1"; }
  [ -d "$path" ] || { keep "folder is gone (git worktree prune drops it)"; continue; }
  [ -n "$branch" ] || { keep "detached HEAD"; continue; }
  branch="${branch#refs/heads/}"

  # Is the work done? Merged into the default branch (merge commits), or its PR says so.
  reason="" pr_head="" pr_num="" pr_state="" open_pr=""
  while read -r state num sha; do
    [ -n "$state" ] || continue
    case "$state" in
      OPEN) open_pr="$num" ;;
      MERGED) [ "$pr_state" = MERGED ] || { pr_state=MERGED pr_num="$num" pr_head="$sha"; } ;;
      CLOSED) [ -n "$pr_state" ] || { pr_state=CLOSED pr_num="$num" pr_head="$sha"; } ;;
    esac
  done < <(cd "$path" && "$GH" pr list --head "$branch" --state all --json state,number,headRefOid -q '.[] | "\(.state) \(.number) \(.headRefOid)"' 2>/dev/null)
  if [ -n "$open_pr" ]; then keep "open PR #$open_pr"; continue; fi
  base=$(default_ref "$path")
  by_ancestry=0
  if [ -n "$base" ] && git -C "$path" merge-base --is-ancestor HEAD "$base" 2>/dev/null; then by_ancestry=1; fi
  if [ "$by_ancestry" = 1 ]; then reason="merged${pr_num:+ #$pr_num}"
  elif [ "$pr_state" = MERGED ]; then reason="merged #$pr_num"
  elif [ "$pr_state" = CLOSED ]; then reason="closed #$pr_num"
  else keep "no merged or closed PR"; continue; fi

  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then keep dirty; continue; fi
  # Commits after the PR's head were never merged: keep unless they exist on a remote.
  if [ "$by_ancestry" = 0 ]; then
    in_pr=0
    [ -n "$pr_head" ] && git -C "$path" merge-base --is-ancestor HEAD "$pr_head" 2>/dev/null && in_pr=1
    if [ "$in_pr" = 0 ] && [ -n "$(git -C "$path" rev-list -n 1 HEAD --not --remotes 2>/dev/null || echo unknown)" ]; then keep unpushed; continue; fi
  fi
  case "$BUSY" in *$'\n'"$path"$'\n'*) keep "live (worker or open terminal)"; continue ;; esac
  run "$ORCA" worktree rm --worktree "path:$path" --json && removed=$((removed + 1)) && echo "worktrees: $REMOVED $name ($reason)"
done < <(jq -r '.result.worktrees[]? | select(.isMainWorktree | not) | [.path, .branch] | @tsv' <<<"$LIST")

# Stale entries (a worktree folder that is gone, e.g. a temp scratchpad) are dropped from each repo.
while IFS= read -r repo; do
  [ -d "$repo/.git" ] || continue
  if [ "$DRY" = 1 ]; then flags=(--dry-run -v); verb="would prune"; else flags=(-v); verb="pruned"; fi
  while IFS= read -r line; do
    [ -n "$line" ] && echo "worktrees: $verb stale worktree entry: ${line#Removing }"
  done < <(git -C "$repo" worktree prune "${flags[@]}" 2>&1)
done < <(jq -r '.result.worktrees[]? | select(.isMainWorktree) | .path' <<<"$LIST")

# Finished work on the board (merged tasks, answered decisions) goes to the archive, never deleted.
board_flags=(); [ "$DRY" = 1 ] && board_flags=(--dry-run)
while IFS= read -r line; do
  case "$line" in "would archive "*|"archived "*) archived=$((archived + 1)); echo "board: $line" ;; esac
done < <(COORDINATOR_STATE="$STATE" COORDINATOR_PACKAGE="$PKG" "$NODE_BIN" "$PKG/bin/board.mjs" archive ${board_flags[@]+"${board_flags[@]}"} 2>/dev/null)

echo "released $released sessions, removed $removed worktrees, kept $kept (dirty/open/unpushed), archived $archived board items"

[ "$DRY" = 1 ] || "$PKG/bin/metrics.sh" >/dev/null 2>&1 || true
