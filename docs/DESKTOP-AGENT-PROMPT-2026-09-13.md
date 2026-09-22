# Desktop agent: install the VM-validated MCP reliability release

Update my desktop's chatgpt-mcp using the exact validated source revision below. Work autonomously through local validation and guarded deployment. Do not claim success until the desktop's own acceptance checks pass.

Validated revision: `8ebbb709ad907938a59baddfbaba2b4b6449bf3b`

Authorized source repository: `https://github.com/platform-modules/chatgpt-mcp.git`

The VM has deployed this release with tunnel-client 0.0.14. Fresh verification passed 142 TypeScript tests and 28 Python behavioral tests. Candidate canaries verified retained job results, duplicate-operation handling, cancellation, atomic file conflicts, and a job surviving a backend restart. The desktop itself has NOT been updated or tested remotely.

## Preserve existing work and access

Always use a separate Git worktree. Keep the main checkout clean and synchronized with its authorized main branch, without overwriting existing work. Preserve desktop capability configuration, filesystem roots/blocklists, tunnel profile IDs, runtime keys, DISPLAY/XAUTHORITY behavior, running browsers, displays, recordings, and user commands. Do not copy VM credentials or VM profile definitions. Do not reboot the machine.

Do not use an old install.sh as an upgrade shortcut. The older installer can replace configuration and silently reuse an outdated tunnel-client. Use the validated staged-release procedure instead.

## Inspect the local installation first

Identify the actual operating system, user service manager, backend service/executable/working directory/configuration, and every tunnel profile sharing that backend. On an already upgraded installation, use `~/.config/chatgpt-mcp/active.json` as the entry point; do not assume the backend is still called `chatgpt-mcp.service`. Read service launchers locally to locate existing runtime-key files, without printing secret values.

The VM saw the desktop connector report `tunnel_client_not_seen`. The private-network e14 peer was online, but SSH port 22 refused connections and the short hostname did not resolve from the VM. Diagnose from the actual desktop. These observations do not establish disabled filesystem permissions.

The tested automatic rollout is for Linux with systemd user services. If this desktop is Windows or macOS, do not run Linux service commands or describe the Linux rollout as cross-platform. Stop before changing production and report the native supervisor work needed.

## Fetch the precise validated code

Use the existing authorized clone, normally `~/Projects/chatgpt-mcp`. Inspect its remotes and dirty state first. The public alexcodeplace mirror may not contain this revision. Fetch from the private repository using the desktop's own existing authorization; do not replace its origin or request/copy the VM's credentials.

For a clean clone with access to the private repository:

```sh
REPO="$HOME/Projects/chatgpt-mcp"
REVISION=8ebbb709ad907938a59baddfbaba2b4b6449bf3b
WORKTREE="$REPO/.worktrees/reliability-desktop-20260913"

git -C "$REPO" status --short
git -C "$REPO" remote -v
git -C "$REPO" fetch https://github.com/platform-modules/chatgpt-mcp.git main
git -C "$REPO" cat-file -e "$REVISION^{commit}"
# If WORKTREE already exists, inspect it and its durable deployment state first.
git -C "$REPO" worktree add --detach "$WORKTREE" "$REVISION"
cd "$WORKTREE"
```

Read `docs/DESKTOP-UPDATE.md` and `docs/RELIABILITY.md` from that worktree. Follow the full procedure in DESKTOP-UPDATE.md; this prompt identifies the exact release and required safeguards rather than substituting guessed host-specific settings.

## Build, test, package, and deploy

Use the approved build environment. Do not disable a managed offload wrapper globally. Install dependencies with `corepack pnpm@11.20.0 install --frozen-lockfile`. Run all Python behavioral tests and `corepack pnpm@11.20.0 gate`, then verify that the compiled artifacts correspond to this revision and lockfile.

Package an immutable release with `scripts/release.py pack` and verify its manifest. Resolve the actual approved native Node executable from the running backend, not just whichever wrapper is first on PATH.

Discover the real CONFIG, BACKEND_UNIT, PROFILE and KEY_FILE values locally. Select a diagnostics directory within already permitted filesystem roots and policies. Include every tunnel profile sharing the backend. Do not weaken permissions to make a canary pass.

Run `scripts/deploy-release.py deploy` in an independent user systemd service, using `--enable-jobs` and the locally discovered settings, as documented. It must stage a new backend, use a private candidate job ledger, run the fault canaries, verify the final production configuration, arm its independent rollback guard, and switch profiles one at a time only after observed drain. Each profile must demonstrate a fresh successful control-plane poll.

If the deployment reply disappears, inspect its service journal, active.json and plan.json. Do not repeatedly submit deployment commands or replay mutations because their response was lost.

## Verify before declaring completion

Confirm that active.json and live system.info.runtime identify the exact validated revision. Verify the actual running tunnel executable is version 0.0.14; an old convenience executable's --version output is not proof of the running service version.

Require successful filesystem create/read/delete and real shell-execution canaries, the full expected tool catalog, and healthy fresh polling on every desktop profile. The obsolete per-profile watchdog timers must be disabled, with one coordinated recovery controller observing healthy components and no restart loop. Confirm rollback is disarmed only after a committed rollout.

Check from a fresh or refreshed ChatGPT desktop connector as well. Use exec.start/status/output/cancel for long operations. Where an existing conversation has a cached old catalog, use the documented scripts/mcp-job.py bridge through shell.exec; do not call cached discovery a permission failure. Reusing the same operation ID with identical arguments must retrieve the same job, not rerun it.

Keep the previous backend running while it owns any display processes, GUI applications, recordings or user commands. Disable it for future boot, but do not stop its cgroup blindly.

Report the exact revision, active backend unit/address, actual tunnel executable version, test results, staged and live canary results, recovery state and any remaining limitations. Store local acceptance evidence durably. A short validation period is not a multi-day soak, and local recovery cannot repair upstream refusal to dispatch requests.
