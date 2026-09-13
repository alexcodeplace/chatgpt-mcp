# MCP reliability implementation

Status: implementation validated; production deployment evidence is recorded separately in the active deployment plan, 2026-09-13. Branch: fix/reliability-20260913.

## Verified baseline

- Source origin/main: 5f3c87a; incorporated existing shell-admission fixes through fed3045.
- VM runs a modified runtime at ~/.local/share/chatgpt-mcp, not the main source checkout.
- Both VM tunnels run 0.0.10. Both legacy per-profile watchdogs can restart and overwrite configuration of the shared backend.
- Desktop connector returned tunnel_client_not_seen; do not confuse this with denied permissions.

## Deliverables and acceptance

1. Enforced process-tree deadlines, immediate spool error handling, cancellation-race and bounded-cleanup tests.
2. Configuration-preserving, locked-dependency installer and checksum-verified tunnel-client 0.0.14 pin with startup assertion.
3. Stateful recovery controller: one backend owner, per-profile state, flock, poll freshness, bounded restart budget/cooldown, durable incidents, no automatic permission/config restoration.
4. MCP capability canary and runtime/config identity. Failure categories distinguish transport, overload, policy, backend and unknown delivery.
5. Durable job API with operation identifiers, bounded concurrency/output/retention, result retrieval and cancellation. Never replay a job with unknown outcome. Keep workers independent of planned backend restarts where systemd is available.
6. Atomic overwrite and expected-content checks without bypassing filesystem policy.
7. Identified staged releases, candidate canary, rollback guard, serialized safe cutover and post-cutover checks on both tunnel profiles.
8. Executable fault-injection tests and reproducible desktop update instructions.

## Safety rules

All source changes stay in this worktree. Preserve original runtime, configuration, credentials and service definitions. Do not log secrets. Do not restart browsers or the VM. Do not infer end-to-end recovery from a local ready endpoint. Do not replace an active configuration from a watchdog. Run heavy tests/builds on debian1, not the production MCP process. Desktop rollout only after host identity and update access are verified; otherwise publish an explicit local-agent handoff.

## Validation record

- Frozen dependency installation on debian1 succeeded with pnpm 11.20.0.
- Final `pnpm gate` on debian1: typecheck, 141 tests passed, build passed. Evidence: `/tmp/chatgpt-mcp-reliability-20260913/gate-final.log`, exit file 0.
- Python recovery/deployment behavioral tests: 17 passed (`python3 -m unittest discover -s test -p '*_test.py' -v`).
- `bash -n install.sh scripts/*.sh` and `git diff --check` passed.
- Real VM candidate on port 3211 exposed 28 tools. File lifecycle, atomic stale-hash rejection, durable duplicate-ID retrieval, result preservation across an actual candidate backend restart, and cancellation all passed at 2026-09-13 06:27 UTC. Original backend PID 852 and its GUI/workload resources were not restarted.
- Pinned tunnel-client 0.0.14 was downloaded with the reviewed archive SHA-256 and its installed executable version was verified. This staging action alone did not change the live tunnels.
- Deployment must run as an independent systemd unit. Its authoritative result is `~/.config/chatgpt-mcp/active.json` plus the private `plan.json` and `canary-results.json` under `~/.local/state/chatgpt-mcp/deployments/`. A committed plan includes the exact release revision and final backend capability evidence; an uncommitted or rolled-back plan must not be reported as deployed.
- Desktop connector returned `tunnel_client_not_seen` on repeated probes. No verified desktop management connection was available. The local-agent handoff is `docs/DESKTOP-UPDATE.md`.

A short validation window is not a multi-day soak. Linux/systemd worker and rollout behavior was tested; other operating systems require their own supervisor integration and tests.
