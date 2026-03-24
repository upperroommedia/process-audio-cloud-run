#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES="-f compose.yaml -f compose.youtube-test.yaml"

docker compose $COMPOSE_FILES up -d browser-fallback ytdlp-pot-provider
trap 'docker compose $COMPOSE_FILES down --remove-orphans' EXIT INT TERM

docker compose $COMPOSE_FILES run --rm server sh -lc 'pnpm build && node scripts/verify-youtube-local-loop.js'
