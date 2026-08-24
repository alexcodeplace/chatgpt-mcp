# Plan: Optional Kubernetes Heavy-Execution Backend

## Safety premise

Implement entirely in `feat/k3s-executor-20260824`. Do not touch the user's diverged local `main`. Do not modify the live backend or either production tunnel until the candidate passes all pre-cutover gates. Heavy tests run on build/cluster nodes, not the workstation display.

## Phase 0 — baseline and invariants

- Record deployed commit, backend PID/restarts, health/readiness/metrics, tunnel readiness, and effective production config.
- Record current MCP tool schemas/capability surface for both connectors.
- Record current resource envelope.
- Confirm no stale cutover timers/services are active.

## Phase 1 — public configuration contract

- Add optional `execution` configuration with local-only defaults.
- Kubernetes support defaults disabled and performs zero cluster discovery/probing.
- Make kubeconfig/context/namespace/image/serviceAccount/routing/workspace/resources/selectors/tolerations/labels/TTL/timeouts/parity requirements fully configurable.
- Do not encode Tailscale, node names, cluster addresses, namespace, registry, storage, or any installation-specific values in code/defaults.
- Keep old configuration files valid and behaviorally identical.
- Add minimal and full example configurations plus README documentation.
- Add negative tests proving default config does not invoke Kubernetes and missing optional Kubernetes tooling does not affect local-only startup.

## Phase 2 — routing and separate admission pools

- Introduce an execution router for `shell.exec`.
- Explicit routing precedence: forced-local > explicit remote eligibility > local default.
- Split shell admission into local and remote classes.
- Add configurable remote-shell concurrency.
- Preserve global non-control ceiling and reserved control slots.
- Prevent head-of-line blocking between local and remote shell classes.
- Add metrics/counters for routing and both pools.
- Tests: saturation of either pool leaves the other startable; control calls still work under both kinds of saturation.

## Phase 3 — bounded output spooling

- Replace in-memory stdout/stderr chunk arrays with bounded temporary-file spooling for local and remote execution.
- Preserve exact `ExecResult` shape and `OUTPUT_LIMIT` behavior.
- Kill the local process group or remote pod on overflow.
- Guarantee cleanup under success/error/timeout/cancel/shutdown.
- Consider reducing recommended/default output limits after compatibility tests; do not silently reduce an explicitly configured existing limit.
- Stress-test multi-MiB concurrent output and verify MCP RSS remains bounded.

## Phase 4 — Kubernetes executor

- Implement against configurable Kubernetes client command/API contract, not K3s-specific hostnames or topology.
- Create isolated uniquely labeled pods and let Kubernetes schedule them.
- Transfer authorized `cwd` as a bounded snapshot into `/workspace` (configurable path).
- Execute without an implicit shell and preserve argument boundaries.
- Propagate selected environment variables under existing policy.
- Enforce runtime/output/cancellation limits.
- Delete pods in `finally`; configure TTL/labels for orphan recovery.
- Never sync mutations back by default. Mutating/host-sensitive commands remain local.
- Tests with a fake Kubernetes client for command construction, injection resistance, lifecycle, cancellation, timeout, output overflow, cleanup, and scheduler failures.

## Phase 5 — resource accounting and lightweight deadlines

- Add configurable lightweight deadlines.
- Record routing, output bytes, durations, pod lifecycle outcomes, active/queued local/remote shell metrics.
- Ensure no credentials or kubeconfig content appears in logs/metrics.

## Phase 6 — MCP allocation optimization

- Profile current per-request MCP server allocation.
- Share immutable router/adapter/concurrency/tool-definition state.
- Reuse protocol/server objects only if the MCP SDK explicitly supports it for stateless HTTP without session leakage.
- Otherwise retain one server per request and document why; optimize safe shared pieces only.
- Run protocol concurrency/isolation tests and benchmark allocations/RSS.

## Phase 7 — generic regression gate

On `debian1/2/3` or another buildbox:

- typecheck/build
- full test suite
- install-script syntax/resilience tests
- default local-only config test with no `kubectl` available
- legacy config compatibility
- tool-schema snapshot parity
- local shell timeout/cancel/process-tree cleanup
- output-limit tests
- concurrency saturation tests
- HTTP liveness/readiness/metrics tests
- shutdown-under-saturation test

No production cutover if any gate fails.

## Phase 8 — cluster-specific deployment config (not committed as public defaults)

For this installation only, create a private/local candidate config supplying:

- actual kubeconfig/context
- namespace
- execution image
- service account/RBAC
- routing allow-list
- resource requests/limits
- optional node selectors/tolerations
- workspace excludes/cache mounts if used
- required command/version parity manifest

Cluster-specific values remain outside generic defaults/source.

## Phase 9 — K3s/Kubernetes integration gate

Against the configured cluster:

- prove pod scheduling across available capacity without hard-coded node selection
- verify required tool inventory in the configured image
- verify configured versions
- verify workspace snapshot exactness, including uncommitted files
- verify no authoritative source mutation from remote jobs
- verify command args/env/cwd semantics
- verify cancellation deletes running pod
- verify timeout deletes running pod
- verify output overflow deletes running pod
- verify unschedulable/image-pull/API failures are bounded
- verify orphan/TTL cleanup
- load-test enough concurrent remote jobs to exercise cluster scheduling and MCP remote admission
- compare MCP VM RSS/CPU against equivalent local-heavy workload

## Phase 10 — configuration/tool parity gate

Start a candidate backend on an alternate local port. Compare candidate vs current production:

- exact MCP tool set and schemas
- `system.info` capability flags
- effective local filesystem/shell/process/service/application/browser/desktop config
- concurrency/output/timeout limits
- host-display protections
- remote-routing config
- required pod tool inventory/version checks

Any drift blocks cutover.

## Phase 11 — first cutover: `overdeck-vm` only

- Preserve current `Overdeck` tunnel -> stable backend.
- Back up `overdeck-vm` tunnel unit/config.
- Repoint only `overdeck-vm` to the candidate backend.
- Verify through the real connector: all tools, schemas, local host-control semantics, remote heavy execution, cancellation, metrics, readiness, no tunnel errors.
- Exercise real concurrent work and confirm VM resource reduction.
- Keep an explicit one-step rollback and one rollback timer only if automated rollback is used.
- Do not advance while any unexplained error/config drift remains.

## Phase 12 — final cutover: `Overdeck`

Only after `overdeck-vm` operates normally on the candidate:

- back up `Overdeck` tunnel config
- repoint it to the proven candidate backend
- verify both connectors independently
- run concurrent local + Kubernetes-heavy workloads
- verify reserved control calls succeed during saturation
- verify backend PID/restart count stable and tunnels ready
- verify no 413, unbounded queue, orphan pods, or resource spikes
- disarm rollback immediately after acceptance

## Phase 13 — landing and cleanup

- Commit coherent checkpoints on the feature branch.
- Fast-forward `main` only after all pre-cutover gates are green and no concurrent-main conflict exists.
- Keep public docs/config examples cluster-neutral and opt-in.
- Keep installation-specific Kubernetes config untracked/private.
- Remove candidate/transient services and test pods after successful cutover; retain a known-good rollback bundle.
- Final durable check: remote `main`, feature worktree HEAD, installed runtime HEAD, configs, and both tunnel targets are the intended versions with no drift.
