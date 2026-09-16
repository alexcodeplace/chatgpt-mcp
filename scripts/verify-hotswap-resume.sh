#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p .hotswap-results
pnpm exec tsx --test test/hotswap-gc.test.ts test/hotswap-adoption.test.ts test/hotswap.test.ts test/hotswap-deployment.test.ts 2>&1 | tee .hotswap-results/focused-resume.tap
pnpm typecheck 2>&1 | tee .hotswap-results/typecheck.log
