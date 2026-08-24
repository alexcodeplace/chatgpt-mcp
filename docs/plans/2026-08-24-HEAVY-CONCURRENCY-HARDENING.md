# Heavy Concurrency Hardening Implementation Plan

Date: 2026-08-24  
Spec: `docs/specs/HEAVY-CONCURRENCY-HARDENING.md`

## Phase 1 — Implement without touching production

1. Add validated `concurrency` config with defaults 48 total / 8 reserved / 8 shell / 64 queued / 30s queue wait.
2. Add a process-wide admission controller with priority control queue, shell sub-limit, bounded queue, timeout/cancellation removal, counters, and snapshots.
3. Create one shared admission controller in the HTTP server and pass it through every stateless MCP server factory instance.
4. Route every tool execution through the controller; propagate MCP `ctx.signal`.
5. Extend `shell.exec` with cancellation and POSIX process-group termination for cancellation, timeout, and output-limit paths.
6. Add `/readyz` and `/metrics`; preserve `/healthz` response exactly.
7. Add systemd cgroup/file-descriptor/task guardrails plus bounded shutdown (`TimeoutStopSec=5`, two-second HTTP connection grace) to generated service units.
8. Update example config, README, and operational docs.

## Phase 2 — Automated validation on debian1/2/3

1. Install dependencies with the locked pnpm version.
2. Run `pnpm gate` and shell syntax checks.
3. Run concurrency tests that assert:
   - normal traffic never exceeds 40 active operations;
   - total traffic never exceeds 48;
   - shell traffic never exceeds 8;
   - control work enters reserved slots under normal saturation;
   - a shell-blocked queue does not head-of-line block a normal operation;
   - queue length never exceeds 64;
   - the 65th queued operation gets `OVERLOADED` immediately;
   - queue timeout gets `OVERLOADED`;
   - queued cancellation gets `CANCELLED` and frees its queue position.
4. Run shell cancellation/process-tree tests.
5. Run HTTP readiness/metrics tests.

## Phase 3 — Blue/green production-host canary

1. Build artifacts only on a buildbox.
2. Stage the candidate runtime separately from `/home/user/.local/share/chatgpt-mcp`.
3. Start candidate HTTP backend on `127.0.0.1:3211`; leave production backend/tunnels on 3210.
4. Verify candidate health/readiness/metrics.
5. Run direct MCP concurrency stress against 3211, including more than eight simultaneous shell commands and enough queued work to exercise load shedding.
6. Confirm production 3210 plus tunnel health is unchanged throughout canary testing.

## Phase 4 — Land and safe cutover

1. Commit the validated branch.
2. Fetch origin and confirm branch can be safely landed without overwriting concurrent work.
3. Push validated commit to `main` only after gates/canary pass.
4. Back up current stable runtime commit, `dist`, config, launcher, and systemd unit.
5. Stage new `dist` and config while the old backend remains running.
6. Arm an automatic rollback unit/timer before production backend restart.
7. Reload systemd with the new conservative resource guardrails.
8. Restart only `chatgpt-mcp.service`; do not restart tunnels as part of backend cutover.
9. Verify backend `/healthz`, `/readyz`, `/metrics`, both tunnel readiness endpoints, and tool calls through both connectors.
10. Run a bounded post-cutover concurrency probe and confirm PID/restart counters stay stable.
11. Disarm rollback only after all checks pass.

## Phase 5 — Final verification

1. Confirm installed runtime HEAD equals remote `main`.
2. Confirm the branch/worktree is clean.
3. Confirm no recent backend/tunnel/watchdog failures or 413 responses.
4. Record the final commit and live service state.
