# Desktop MCP update handoff

## Instruction to the desktop agent

Update the desktop's chatgpt-mcp to the tested reliability release identified in the VM completion report. Work in a separate worktree. Preserve the current configuration, credentials, profile identities, display routing, browsers and running tasks. Do not run an old installer that replaces configuration or simply trusts the existing tunnel-client binary.

The remote desktop connector was offline during preparation of this release: `tunnel_client_not_seen`. This establishes a connectivity failure, not disabled write permissions. A local agent must inspect the actual desktop before selecting an update method. The VM's tunnel IDs, API keys and filesystem paths must not be copied to the desktop.

## 1. Inspect the actual host and deployment

Identify the operating system and the current MCP service, executable, working directory, configuration and tunnel profile names. On Linux:

```sh
uname -a
systemctl --user list-units --all --no-pager | grep -E 'chatgpt-mcp|tunnel'
systemctl --user cat chatgpt-mcp.service
systemctl --user show chatgpt-mcp.service -p MainPID -p ExecStart -p WorkingDirectory
```

For a previously upgraded installation, read `~/.config/chatgpt-mcp/active.json` and use its `backendUnit`, `configPath` and `releaseDirectory` instead of assuming the service is still called `chatgpt-mcp.service`. Inspect the tunnel service definitions and launchers locally to find each existing runtime-key file. Do not print key contents in chat, logs or shell history. Resolve any old stdout/stdio-only deployment separately; the tested rollout expects the existing tunnel profiles to point at a loopback HTTP MCP backend.

The automated service rollout below is for Linux with systemd user services. On Windows or macOS, the core source and pinned downloader are available, but the supervisor/recovery integration requires a native implementation and local validation. Do not run the systemd commands or claim the desktop update is complete on those systems.

### When the old desktop service/profile no longer exists

The existing-service upgrade below requires an actual installed profile and service. Do not fabricate a previous service, reuse a VM identity, or repurpose a separate `overdeck-host` deployment. Follow [Fresh desktop bootstrap](DESKTOP-BOOTSTRAP.md) instead, using a commit that includes the explicit `--bootstrap` option. The original August-19 installer launched stdio beneath `chatgpt-mcp-tunnel.service`; the separate HTTP backend arrived on August 24. Those source defaults are not proof of what a particular desktop installed or removed.

## 2. Prepare a separate worktree at the validated revision

Use the existing repository and its authorized remote. The validated source is pushed to the private `platform-modules/chatgpt-mcp` repository. A desktop clone whose only remote is the public `alexcodeplace/chatgpt-mcp` mirror may not contain this commit; fetch it from the authorized private repository or obtain an owner-supplied source bundle instead of substituting an older public commit. Substitute the exact full commit from the VM completion report for `REVISION`; do not guess a hash or silently use a different branch.

```sh
REPO="$HOME/Projects/chatgpt-mcp"
REVISION="FULL_VALIDATED_COMMIT_FROM_COMPLETION_REPORT"
git -C "$REPO" status --short
git -C "$REPO" fetch origin
WORKTREE="$REPO/.worktrees/reliability-desktop-update"
git -C "$REPO" worktree add --detach "$WORKTREE" "$REVISION"
cd "$WORKTREE"
corepack pnpm@11.20.0 install --frozen-lockfile
python3 -m unittest discover -s test -p '*_test.py' -v
corepack pnpm@11.20.0 gate
```

If this host has a managed build/offload wrapper, use its approved build environment rather than disabling it globally. Verify that the final compiled artifacts correspond to the selected source commit and dependency lock.

## 3. Package an identified release

```sh
RELEASE="$HOME/.local/share/chatgpt-mcp-releases/$REVISION"
python3 scripts/release.py pack \
  --source "$WORKTREE" --destination "$RELEASE" --revision "$REVISION"
python3 "$RELEASE/scripts/release.py" verify "$RELEASE"
```

Packaging refuses a mismatched revision or uncommitted source inputs. Build artifacts must be copied back into the clean source worktree after an approved remote build; package from that worktree, not an unversioned extraction. The package excludes `config.local.json`, `.secrets` and Git state. Its content manifest is verified again at backend startup. Do not edit files in the packaged release. An existing destination must be verified, not overwritten. The runtime-key files stay in their original private locations.

## 4. Set host-specific values from the inspected installation

Set `CONFIG` to the current private configuration path, `PROFILE` to the desktop's existing tunnel profile name, and `KEY_FILE` to the runtime-key file already used by that profile's launcher. Set `BACKEND_UNIT` to the current backend unit. Resolve Node from that running backend rather than accidentally selecting a build/offload wrapper:

```sh
BACKEND_PID="$(systemctl --user show "$BACKEND_UNIT" -p MainPID --value)"
NODE_BIN="$(readlink "/proc/$BACKEND_PID/exe")"
```

If the backend is down, identify the approved native Node executable from the local installation and validate its version before using it. Node must be version 22 or newer. Select a `CANARY_DIR` under an existing permitted filesystem root where the configured policy allows creating and deleting a small diagnostics file. For example, an unprotected `.internal/mcp-canary` directory inside an existing worktree may be appropriate. Do not weaken filesystem roots or blocklists to make a test pass.

## 5. Deploy without killing the old backend's work

Run the deployment under an independent user service so a tunnel reconnect cannot terminate the deployment process:

```sh
ROLLOUT="chatgpt-mcp-desktop-rollout-${REVISION:0:12}"
systemd-run --user --unit="$ROLLOUT" --collect \
  --property=RuntimeMaxSec=600 --property=TimeoutStopSec=15 \
  /usr/bin/python3 "$RELEASE/scripts/deploy-release.py" deploy \
  --release "$RELEASE" --config "$CONFIG" --node "$NODE_BIN" \
  --profile "$PROFILE=$KEY_FILE" --canary-directory "$CANARY_DIR" \
  --enable-jobs
journalctl --user -u "$ROLLOUT" --no-pager
```

For multiple desktop accounts, repeat `--profile "NAME=/existing/private/key-file"` for every profile sharing this backend. The script preserves their existing tunnel identities, authentication settings and other YAML settings. It only changes the one expected loopback MCP URL per profile and installs the pinned launcher. It refuses unexpected layouts or profile edits made during staging.

The script first starts a separate candidate backend, runs filesystem and durable-job canaries in a private staging ledger, restarts that private candidate while a job is running, and verifies the retained result. It then loads the production job ledger without submitting candidate jobs to it and verifies the final configuration and real shell execution. The previous backend working directory is preserved automatically. Only then does it arm an independent rollback timer and switch tunnel profiles one at a time. Each switched profile must demonstrate a fresh successful control-plane poll. A failed rollout restores the original routes without killing either backend's user work.

Do not repeatedly submit the deployment command if its reply is lost. Inspect its independent service journal and deployment plan first. Reusing a release with an existing runtime unit deliberately fails instead of starting duplicate deployments.

## 6. Verify and report exact results

```sh
python3 "$RELEASE/scripts/status.py"
cat "$HOME/.config/chatgpt-mcp/active.json"
journalctl --user -u chatgpt-mcp-recovery.service --no-pager --lines=40
```

Confirm the active release revision matches the intended commit, the shell and filesystem canaries pass, both local capabilities and each profile's poll freshness pass, and the old per-profile watchdog timers are disabled. Confirm the shared recovery controller reaches a stable healthy phase without spending restart budgets. Its state is at `~/.local/state/chatgpt-mcp/recovery/state.json`.

From a fresh or refreshed ChatGPT connector, call `system.info`, perform a harmless allowed write/read/delete canary, and verify that long operations can use `exec.start`, `exec.status`, `exec.output` and `exec.cancel`. Do not equate a cached old catalog with disabled access. For an existing conversation, `scripts/mcp-job.py` bridges durable jobs through the old shell tool.

Report the full revision, active unit, tunnel-client version, fresh polling evidence, local and connector canary results, and any unverified platform-specific behavior. A short successful test is not a multi-day reliability soak.

The previous backend is deliberately left running but disabled for future boot. Keep it while it owns any live shell tasks, GUI applications or recordings. Stop it only after its owners have finished and its cgroup has no user resources to preserve. Do not reboot the desktop or restart its browsers as part of this update.
