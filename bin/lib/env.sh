#!/usr/bin/env bash
# Sourced by every shell script in the package: loads config.yaml as CFG_* variables
# and defines the few helpers they share. Needs node ≥ 20 on PATH (or NODE_BIN).
set -u
# Homebrew folders are added after the caller's PATH (a precheck may run with a bare one); the
# caller's tools win.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
PKG="${COORDINATOR_PACKAGE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
eval "$("$NODE_BIN" "$PKG/bin/lib/config-shell.mjs" ${COORDINATOR_LENIENT:+--lenient})" || exit 3

STATE="${COORDINATOR_STATE:-$CFG_paths_state}"
ORCA="$CFG_paths_orca"
GH="${GH:-gh}"
STATE_DIR="$STATE/automations/state"
mkdir -p "$STATE_DIR" "$STATE/reports" "$STATE/archive" 2>/dev/null || true

# resolve_secret keychain:<service> | env:<NAME> | file:<path> → prints the credential.
# Fails (status 1, nothing printed) when the reference is empty or resolves to nothing, so a
# caller never sends an empty token.
resolve_secret() {
  local ref="${1:-}" value="" name
  case "$ref" in
    keychain:*) value=$(security find-generic-password -a "$USER" -s "${ref#keychain:}" -w 2>/dev/null) || return 1 ;;
    env:*)
      name="${ref#env:}"
      [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
      value="${!name:-}" ;;
    file:*) value=$(cat "${ref#file:}" 2>/dev/null) || return 1 ;;
    "") return 1 ;;
    *) value="$ref" ;;
  esac
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

# Writes are sensitive: an adapter refuses them unless the caller passes --yes
# (the coordinator does that only after the human's explicit go).
require_yes() {
  for arg in "$@"; do [ "$arg" = "--yes" ] && return 0; done
  echo "refused: this is a write (sensitive). Re-run with --yes after an explicit go." >&2
  exit 4
}

today() { date +%Y-%m-%d; }
