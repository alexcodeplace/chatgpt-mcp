# Heavy Concurrency Hardening Specification

Status: implementation target  
Date: 2026-08-24  
Scope: `@platform-modules/chatgpt-mcp` local HTTP backend and its systemd deployment

## 1. Goal

Make the MCP backend remain responsive and recoverable under sustained concurrent use from many ChatGPT conversations. Overload must become a bounded, explicit condition (`OVERLOADED`) rather than unbounded subprocess creation, memory growth, request pile-up, tunnel instability, or host exhaustion.

This work must preserve the existing resilience properties:

- MCP backend lifetime is independent from each tunnel lifetime.
- `Overdeck` and `overdeck-vm` tunnels remain separately supervised.
- A backend restart must not require either tunnel to restart.
- Responses stay below the tunnel transport budget.
- The watchdog treats `/healthz` as liveness and must not restart a merely busy backend.

## 2. Required behavior

### 2.1 Shared admission controller

Admission control MUST be process-wide for the HTTP backend and shared by every stateless MCP server instance created for individual HTTP requests.

Default limits:

- Maximum active MCP tool operations: **48**.
- Reserved active slots for control/observability operations: **8**.
- Maximum active non-control operations: **40**.
- Maximum active `shell.exec` operations: **8**.
- Maximum queued operations: **64**.
- Maximum queue wait: **30 seconds**.

The limits MUST be configurable under a `concurrency` configuration object and validated at startup.

### 2.2 Priority and reserved capacity

Control operations MUST be able to use the reserved slots even when normal/heavy traffic has saturated its 40-slot allocation.

Control operations are:

- `system.info`
- `process.list`
- `service.status`
- `process.kill`
- `service.control`

All other tools use the normal allocation. `shell.exec` additionally consumes one shell slot.

Queued control work receives scheduling priority over queued normal work. A shell-saturated queue MUST NOT block startable non-shell work behind it.

### 2.3 Load shedding

When the bounded queue is full, a new tool operation MUST fail immediately with a structured `OVERLOADED` error. A queued request that exceeds the queue-wait timeout MUST also fail with `OVERLOADED`.

An overloaded request MUST NOT crash or restart the backend or either tunnel.

### 2.4 Cancellation

If the MCP request is cancelled while queued, it MUST be removed from the queue and fail as `CANCELLED` without consuming an execution slot.

For a running `shell.exec`, MCP cancellation MUST terminate the command. Timeout, output-limit, and cancellation termination MUST target the command's process group on POSIX so descendants do not survive an abandoned request.

### 2.5 Liveness, readiness, and metrics

- `GET /healthz` remains a lightweight liveness check and MUST continue to return success while the process is alive, including during overload.
- `GET /readyz` reports capacity state. It returns HTTP 503 when the admission queue is full and HTTP 200 otherwise.
- `GET /metrics` returns a compact JSON snapshot containing configured limits, active/queued counts, peak counts, and accepted/completed/rejected/timed-out/cancelled counters.
- The tunnel watchdog MUST continue to use `/healthz`, not `/readyz`, to avoid restarting a healthy but busy backend.

### 2.6 Deployment resource guardrails

The generated systemd backend unit MUST use conservative host guardrails:

- `TasksMax=512`
- `LimitNOFILE=65536`
- `MemoryHigh=6G`
- `MemoryMax=9G`
- `CPUWeight=80`
- `TimeoutStopSec=5`

HTTP transport shutdown MUST allow at most two seconds for in-flight connections to drain before force-closing them. This keeps supervised restart/rollback recovery bounded even when the service is saturated.

These are last-resort containment, not the primary concurrency mechanism. Admission control is expected to shed load before the cgroup limits are approached.

## 3. Compatibility

- Existing configuration files without `concurrency` remain valid and receive the defaults above.
- Existing tool schemas and successful result shapes remain unchanged.
- `healthz` response compatibility is preserved.
- STDIO transport receives its own admission controller instance; the shared-controller requirement applies to all requests within each running transport process.
- Existing 4 MiB per-operation output limits and 6 MiB final transport budget remain unchanged.

## 4. Failure semantics

New adapter-compatible error codes:

- `OVERLOADED`: admission queue has no capacity or queue wait expired.
- `CANCELLED`: request was cancelled by the MCP client.

Both errors are normal tool failures and MUST be returned locally rather than surfacing as tunnel/HTTP transport failures.

## 5. Safety and cutover requirements

The currently running production backend MUST NOT be modified during implementation or buildbox validation.

Before cutover:

1. Full typecheck/test/build gate passes on a buildbox.
2. Scheduler unit tests prove global, reserved-slot, shell, queue, timeout, cancellation, and non-head-of-line-blocking behavior.
3. HTTP tests prove `/healthz`, `/readyz`, and `/metrics` semantics.
4. Process tests prove cancellation/timeout removes descendant processes.
5. A blue/green canary of the candidate build runs on a different loopback port while production remains on 3210.
6. Canary concurrency stress demonstrates bounded shell concurrency and clean overload responses.

Cutover MUST preserve a rollback copy of the previous runtime/config/unit and arm an automatic rollback before restarting the production backend. The rollback is disarmed only after both tunnels, backend health, readiness, and representative tool calls are verified after cutover.

## 6. Acceptance criteria

The work is complete only when:

- All automated tests pass.
- The candidate canary survives concurrency/failure injection.
- Production runs the landed commit with configured defaults.
- Both tunnel `/readyz` endpoints are healthy.
- Both `Overdeck` and `overdeck-vm` execute a post-cutover command successfully.
- An intentional overload returns `OVERLOADED`/bounded failure without restarting the backend or tunnels.
- No legacy/duplicate supervisor is introduced.
- Changes are committed and pushed only after validation.
