#!/usr/bin/env bash
# Full upstream gate and an additional compiled-runtime acceptance pass.
# Run only through the existing K3s executor.
set -Eeuo pipefail
mkdir -p .hotswap-results
pnpm gate 2>&1 | tee .hotswap-results/full-gate.log
node --test dist/test/hotswap-identity.test.js dist/test/hotswap-sse.test.js dist/test/hotswap.test.js dist/test/hotswap-adoption.test.js 2>&1 | tee .hotswap-results/compiled-acceptance.log
