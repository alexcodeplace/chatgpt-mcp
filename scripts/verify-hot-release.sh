#!/usr/bin/env bash
# Full upstream gate and an additional compiled-runtime acceptance pass.
# Run only through the existing K3s executor.
set -Eeuo pipefail
mkdir -p .hotswap-results
python3 -B -m unittest discover -s test -p "*_test.py" -v 2>&1 | tee .hotswap-results/python-gate.log
pnpm gate 2>&1 | tee .hotswap-results/full-gate.log
node --test dist/test/hotswap-recording.test.js dist/test/hotswap-gc.test.js dist/test/hotswap-identity.test.js dist/test/hotswap-sse.test.js dist/test/hotswap.test.js dist/test/hotswap-adoption.test.js 2>&1 | tee .hotswap-results/compiled-acceptance.log
