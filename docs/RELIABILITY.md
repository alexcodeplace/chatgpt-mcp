# Reliability operation and guarantees

The MCP transport remains stateless. Durable execution state belongs to explicit operation IDs, not to a ChatGPT conversation or an MCP session.

## What changed

The process runner enforces deadlines for descendants that still own output pipes after their parent exits. It handles output-spool errors from stream creation onward, clears delayed termination callbacks, and releases admission after bounded forced cleanup. POSIX process-group cleanup is tested. Termination also kills remaining process-group members when the leader closes all pipes before the delayed force-kill fires, including descendants that ignore SIGTERM. A deliberately detached process that escapes its group can still require OS supervision; the runner does not claim to be a sandbox.

Tunnel-client is pinned to 0.0.14. `scripts/install-tunnel.py` verifies the reviewed archive checksum, extracts only named executables, checks their version, and installs them beside old binaries. It verifies cached executable hashes on repeat installation. Tunnel launchers reject other versions. The initial installer uses the dependency lock and preserves existing capability configuration and tunnel profile settings.

One recovery controller owns backend recovery. Per-profile tunnel state shares the same lock with deployment and removal. Neither recovery nor deployment silently restores an older permission configuration. Each known-good release has an exact source revision, dependency lock fingerprint and complete file inventory. `system.info.runtime` reports the running release and loaded configuration fingerprint.

## Durable execution

Enable `jobs.enabled` explicitly. The Linux deployment helper's `--enable-jobs` switch enables the tested systemd worker launcher. Existing installations do not gain this capability merely by parsing their old configuration.

Use `exec.start` for long commands, keep its returned `jobId`, and use `exec.status`, `exec.output` and `exec.cancel`. `exec.list` recovers recent identifiers after a conversation or connection interruption. A job is reserved on disk before launch; the worker must acquire its one-time claim before executing.

An example start request:

```json
{
  "operationId": "build-v1-unique-owner-request-001",
  "command": "bash",
  "args": ["-lc", "pnpm test && pnpm build"],
  "cwd": "/path/to/existing/worktree",
  "timeoutMs": 300000
}
```

Reusing that same operation ID with the same effective arguments retrieves the job. Different arguments with the same ID return `CONFLICT`. Repeating a completed operation is deliberately not a retry. Use a new ID only for an intentionally new operation, not because a reply was lost.

The execution and launch boundary cannot guarantee exactly-once external side effects across every power-loss or OS failure. A lost launch acknowledgement or dead worker can produce `unknown` / `OUTCOME_UNKNOWN`. Inspect the retained operation and its effects. The server never automatically replays an unknown outcome. Transactional remote APIs and application-specific idempotency keys are still needed for payments, deployments, messages and other external mutations.

Systemd workers run in their own cgroups and survive tunnel and backend restarts. Their limits default to two concurrent jobs, 1 GiB memory and 128 tasks per worker. An explicit `detached` launcher exists for other environments, but service-manager termination semantics differ; backend-restart survival is only verified for the Linux systemd launcher. Workers are not automatically restarted. Host reboot or a killed worker can leave an unknown outcome. Cancellation is cooperative and cannot undo effects already performed.

Output is available after completion, in bounded character slices. `offset` and `nextOffset` are UTF-16 character offsets, not byte offsets. Defaults retain output for one day, the operation ledger for seven days, up to 2,048 records and 256 MiB of stored/reserved output. Retention cleanup runs on new submissions. Unknown outcomes remain reserved until explicitly reconciled by an operator. Operation IDs must be globally unique; do not reuse them after retention expires. A full ledger or output budget rejects new work rather than evicting active/unknown operations. Use one active backend owner for a job directory; multi-writer replicas are not supported.

Request arguments and environment are stored in private 0700 directories and 0600 files only until the worker loads them. The worker deletes its request before executing. Output can itself contain secrets printed by a command, so retained output remains private too. The durable API uses the same configured shell, path, environment and display policies as synchronous execution.

### Existing conversations with a cached tool catalog

A new backend catalog has `exec.*` and `fs.replace`, but an existing ChatGPT conversation may retain its older tool definitions. This is not a permission failure. Refresh tool discovery where supported. The local bridge works through the existing shell tool without requiring new tool definitions:

```sh
python3 /path/to/active/release/scripts/mcp-job.py start \
  --operation-id build-v1-unique-owner-request-001 \
  --cwd /path/to/worktree --timeout-ms 300000 -- bash -lc 'pnpm test && pnpm build'
python3 /path/to/active/release/scripts/mcp-job.py status JOB_ID
python3 /path/to/active/release/scripts/mcp-job.py output JOB_ID
```

Find the active release path in `~/.config/chatgpt-mcp/active.json`. The bridge obtains the active backend address and authentication from local private files. It does not automatically retry mutations.

## Conditional file replacement

`fs.replace` stages and syncs an entire replacement, then atomically replaces a regular file. Supply the SHA-256 of the current UTF-8 content, or null to create a new file. Cooperating MCP replacements serialize by canonical parent path. A stale hash returns `CONFLICT` without overwriting. Creation refuses an entry that appeared in the meantime.

This operation requires both read and write grants and preserves filesystem blocklist checks. It rejects symlinks and frozen directory-entry mutations. It checks write access to the existing file rather than bypassing it through directory rename permissions. Legacy `fs.write` retains its existing append/overwrite behavior, including writes inside directories whose entry set is frozen.

The expected-hash check is not a kernel compare-and-swap against an external editor. Replacement creates a new inode; special ACLs, hardlink identity and extended attributes are not preserved. Use legacy write or an application-specific transaction where those properties are required.

## Recovery policy

The controller checks the backend independently with fresh MCP `tools/list` and `system.info` requests. It compares configured capability expectations without granting new ones. A write/read/delete canary uses a uniquely named file in an explicitly allowed diagnostics directory. Where `node` is already granted, a separate one-second `shell.exec` probe verifies actual execution and exact output, not merely the shell capability flag. Failure of that execution probe is not evidence that the responsive HTTP backend is down; it never triggers a backend restart. A configuration, authentication, runtime identity or execution fault suppresses dependent tunnel restarts. It does not infer permission to every path from one successful write.

For each tunnel, the controller checks `commands_poll_last_successful_timestamp_seconds`. Local liveness or ready responses alone do not prove current control-plane progress. Defaults use a 90-second stale threshold, two failing observations and checks approximately every 30 seconds with jitter. A healthy but idle 30-second long poll is not treated as a failure. Recovery timing depends on poll deadlines, confirmation, systemd and upstream availability; it is not a universal one-minute guarantee.

Recovery state survives controller restarts. Repeated failures use exponential cooldown and a maximum of three attempted restarts per hour per component. A brief successful probe does not erase the budget. After the budget is spent, the circuit remains open while low-rate probes continue. Stable healthy observations resolve the incident; later bounded attempts become possible as the hourly history expires. The controller resets a systemd start-limit failure only as part of a budgeted recovery attempt.

`OVERLOADED`, explicit policy mismatches, authentication failures, invalid configuration, clock skew and an execution-canary failure are not grounds for repeatedly restarting a tunnel or modifying access. A failed backend suppresses dependent tunnel restarts. One private incident record tracks a failure and its subsequent recovery; retention is bounded. Logs contain phases, codes, durations and opaque correlation IDs, not tool arguments, credentials or output.

The recovery checkpoint pins both the source release and the loaded configuration fingerprint, plus the exact private configuration file digest. Editing that configuration out of band produces `CONFIG_CHANGED` rather than silently adopting or restoring permissions. Apply an intentional configuration change through a newly staged release, with fresh acceptance and checkpoint evidence.

A corrupt recovery state file no longer disables the controller or resets its restart budget. It is replaced with a conservative budget that reserves all restart attempts for one hour while health probes continue. A private `state-recovery.json` records the damaged state's SHA-256 and the hold period; arbitrary file contents are never logged. Stable service health is still observed normally, and later bounded recovery becomes possible when the conservative reservation expires. Atomic recovery writes sync both file contents and the containing directory before any restart is requested.

Use:

```sh
./scripts/tunnel-status.sh
python3 scripts/recovery.py --config ~/.config/chatgpt-mcp/recovery.json --dry-run
journalctl --user -u chatgpt-mcp-recovery.service --no-pager
```

Persistent state and incidents live under `~/.local/state/chatgpt-mcp/recovery/`. Local response completion is not proof of receipt by ChatGPT. Client-visible recovery must also be checked through the connector. Upstream tool-dispatch/safety-check failures and a conversation that stops issuing commands cannot be repaired by a local restart loop.

## Safe deployment

Build and test in a separate source worktree. Use frozen dependencies. `scripts/release.py pack` requires a Git worktree whose HEAD matches the supplied full revision and whose packaged source inputs are clean and committed. It accepts only release inputs, excluding local configuration and credentials. It writes a content manifest and read-only runtime files. Verify the package before starting it; release verification is also an `ExecStartPre` check.

`deploy-release.py deploy` starts a new identified backend on a free loopback port. It runs the capability, filesystem, conflict, durable-result and backend-restart canaries before routing any tunnel to it. Those candidate jobs use an isolated private ledger, never the live job directory or its retention cleanup. After staging completes, the candidate loads the production configuration and passes another capability/filesystem/shell probe before tunnel cutover. Upgrades preserve the previous backend's working directory by default; changing the configuration file's location must not change relative-path command behavior. An explicit `--working-directory` override is available when an intentional change is needed. It arms an independent rollback timer, acquires the recovery lock, retires the old competing watchdogs and switches profiles one at a time after their observed worker/queue counts reach zero. A fresh successful poll is required after each tunnel restart. A request can still arrive between the drain observation and restart; clients must reconcile any lost mutation reply rather than repeat it blindly.

The original backend is disabled for future boot only, not stopped. Existing GUI sessions, legacy shell commands and recordings remain with that process until their owners finish. After verifying that no such resources remain, an operator can stop the previous backend explicitly. Keeping that transitional process is intentional, not an unexplained duplicate deployment. New durable workers are independent of backend lifetime.

Deployment and recovery do not support concurrent active backend writers sharing the same job ledger. On a later upgrade, do not submit new jobs to the retired backend directly. Existing workers can finish in their isolated units and their results remain in the common ledger.

The guarded rollback restores original profiles and service files if cutover fails. It does not kill either backend's user work. Each deployment stores its private plan and canary evidence under `~/.local/state/chatgpt-mcp/deployments/`. A committed plan is not automatically rolled back by a delayed timer. Source commits, active deployment identity and operator evidence should be inspected separately; a dirty old checkout is never treated as the release identity.

## Validation boundaries

The implementation includes process fault tests, persistent-job tests, permission/conflict tests, executable recovery state-machine tests and deployment rollback/manifest tests. A real VM candidate also exercised a running systemd job across a backend restart and cancellation. These are targeted fault tests, not evidence of a multi-day soak or universal freedom from upstream interruptions.

See `DESKTOP-UPDATE.md` for a local desktop-agent handoff. The service deployment and recovery scripts require Linux, Python 3, flock, and systemd user services. The pinned tunnel downloader includes macOS and Windows binaries, but that does not make the Linux service rollout portable to those operating systems.
