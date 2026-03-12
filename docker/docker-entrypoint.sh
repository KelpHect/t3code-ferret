#!/bin/sh
set -eu

export DATA_ROOT="${DATA_ROOT:-/data}"
export T3_DEPLOYMENT_MODE="${T3_DEPLOYMENT_MODE:-self-hosted}"
export T3CODE_HOST="${T3CODE_HOST:-0.0.0.0}"
export T3CODE_PORT="${T3CODE_PORT:-3773}"
export T3CODE_NO_BROWSER="${T3CODE_NO_BROWSER:-true}"

command -v bun >/dev/null 2>&1 || {
  echo "bun is required but was not found in PATH." >&2
  exit 1
}

command -v git >/dev/null 2>&1 || {
  echo "git is required but was not found in PATH." >&2
  exit 1
}

command -v codex >/dev/null 2>&1 || {
  echo "codex is required but was not found in PATH." >&2
  exit 1
}

mkdir -p "$DATA_ROOT"
chown -R t3code:t3code "$DATA_ROOT" /home/t3code

exec gosu t3code:t3code bun /app/apps/server/dist/index.mjs --no-browser "$@"

