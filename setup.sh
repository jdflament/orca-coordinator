#!/usr/bin/env bash
# One-command install: ./setup.sh [init flags]   (same as: node bin/coordinator.mjs init ...)
# Needs node ≥ 20 on PATH. Add --dry-run to see what it would do, --yes to skip prompts.
set -eu
export ORCA_COORDINATOR_CWD="${ORCA_COORDINATOR_CWD:-$PWD}"
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "node ≥ 20 is required (https://nodejs.org)" >&2; exit 1; }
exec node bin/coordinator.mjs init "$@"
