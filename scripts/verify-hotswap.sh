#!/usr/bin/env bash
# Invoke through k3s-build. This script never chooses a local build fallback.
set -Eeuo pipefail
mkdir -p .hotswap-results
pnpm typecheck 2>&1 | tee .hotswap-results/typecheck.log
if (($#)); then
  tests=("$@")
else
  tests=(test/hotswap*.test.ts test/http.test.ts test/extended-adapter.test.ts test/jobs.test.ts)
fi
pnpm exec tsx --test "${tests[@]}" 2>&1 | tee .hotswap-results/focused.tap
