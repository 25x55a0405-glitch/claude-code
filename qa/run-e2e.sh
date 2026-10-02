#!/usr/bin/env bash
# Builds the web app for same-origin use, starts two throwaway servers (one open,
# one with a password) and runs the browser tests against them.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd web && VITE_SKYS_API_URL= npx vite build >/dev/null)
tmp=$(mktemp -d)
cleanup() { kill $(jobs -p) 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
(cd server && exec node --disable-warning=ExperimentalWarning ../qa/e2e/server.ts >"$tmp/open" 2>"$tmp/open.err") &
(cd server && QA_PASSWORD=qa-secret exec node --disable-warning=ExperimentalWarning ../qa/e2e/server.ts >"$tmp/locked" 2>"$tmp/locked.err") &
for _ in $(seq 50); do [[ -s "$tmp/open" && -s "$tmp/locked" ]] && break; sleep 0.2; done
SKYS_URL=$(head -1 "$tmp/open") SKYS_LOCKED_URL=$(head -1 "$tmp/locked") \
  node --test --test-concurrency=1 --test-reporter=spec qa/e2e/ui.test.mjs "$@"
