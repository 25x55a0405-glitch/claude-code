#!/usr/bin/env bash
# Runs the testing thread's API checks against the server code, in-process.
set -euo pipefail
cd "$(dirname "$0")/../server"
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 --test-reporter=spec ../qa/server/*.test.ts "$@"
