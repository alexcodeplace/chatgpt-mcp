# Fresh desktop MCP bootstrap with preserved activation

Use this path only when the desktop's chatgpt-mcp backend, controller, service and profile are absent. An existing independent Overdeck installation is not an old chatgpt-mcp backend and must remain untouched. For an installed chatgpt-mcp profile, use DESKTOP-UPDATE.md instead.

## Establish the local identity first

Inspect the actual desktop, its service definitions, profile files, processes and activation file dates. The August-19 installer source (`2fba8fc`) used a single `chatgpt-mcp-tunnel.service` which launched the MCP over stdio; `e0c2ede` introduced the separate HTTP backend on August 24. The old default local alias was `chatgpt-computer`, but a default is not evidence that the desktop used it. There is no need to guess that alias when the original desktop tunnel ID can be established independently.

The source recognizes `.secrets/chatgpt-mcp.tunnel`, `.secrets/chatgpt-mcp-tunnel.api`, and the historical typo `.secrets/chatgpt-mtp-tunnel.api`, in addition to normalized `tunnel-id` and `runtime-api-key`. Choose only files whose provenance belongs to this desktop's activation. Never select an overdeck-vm/account2 credential merely because it is nearby. Do not paste values into the coordination file, logs, chat or command history.

Verify locally that no other running tunnel, service or profile uses the desktop tunnel ID. Compare against the existing Overdeck profile without exposing either ID. Existing profile YAML containing the selected ID is rejected automatically; the explicit `--identity-verified-unused` assertion additionally requires the local agent to check processes and other configuration locations which the script cannot discover completely. This is an evidence check, not an instruction to guess or bypass verification. Missing, revoked, or unrelated credentials need an owner-authorized replacement, not another machine's key.

Use a new unoccupied local alias such as `desktop-restored`. The script will refuse an existing MCP installation, alias, service or active/recovery marker. It will not restart or repurpose `overdeck-mcp-tunnel.service` or `overdeck-host`.

## Build and package

Use the exact bootstrap-support commit reported by the release agent, from private `platform-modules/chatgpt-mcp`. Prepare a separate clean worktree, install with the frozen pnpm 11.20.0 lockfile, run Python behavioral tests and `pnpm gate`, then package and verify using `scripts/release.py`. The bootstrap helper must match the packaged release, because its independent rollback guard needs the matching first-install logic. Do not run the new helper against the old beaf62b or 8ebbb709 package.

The TypeScript runtime is unchanged from the VM-validated release. Bootstrap support changes only deployment orchestration and tests; the active VM does not need redeployment for a desktop first install.

## Inputs determined on the desktop

Set these shell variables from the verified local inspection, never from the VM's runtime paths or credentials:

- `RELEASE`: verified immutable release directory.
- `CONFIG`: existing desktop `config.local.json` to preserve.
- `NODE_BIN`: approved native Node executable, version 22 or newer.
- `PROFILE`: new unused local alias, for example `desktop-restored`.
- `KEY_FILE` and `TUNNEL_ID_FILE`: independently verified desktop activation files.
- `CANARY_DIR`: diagnostics directory under existing allowed filesystem roots and blocklist policy.

The helper selects an unused loopback backend port and an unused loopback health port in 8180 through 8279. `--health-port` can explicitly select another unprivileged port and fails if occupied. It does not stop a listener to acquire its port. Original capability configuration and credential files remain unchanged. A new private configuration is staged, and durable jobs are enabled only by the explicit flag below.

## Independently supervised bootstrap

Run under a separate user service so this operation survives loss of the connector response:

```sh
REVISION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["revision"])' "$RELEASE/release-manifest.json")"
ROLLOUT="chatgpt-mcp-desktop-bootstrap-${REVISION:0:12}"
systemd-run --user --unit="$ROLLOUT" --collect \
  --property=RuntimeMaxSec=600 --property=TimeoutStopSec=15 \
  /usr/bin/python3 "$RELEASE/scripts/deploy-release.py" deploy \
  --bootstrap --identity-verified-unused \
  --release "$RELEASE" --config "$CONFIG" --node "$NODE_BIN" \
  --profile "$PROFILE=$KEY_FILE" --tunnel-id-file "$TUNNEL_ID_FILE" \
  --canary-directory "$CANARY_DIR" --enable-jobs
journalctl --user -u "$ROLLOUT" --no-pager
```

The script stages a separate backend, runs its existing fault canaries using a private job ledger, and validates final settings before publishing the new profile. It generates the profile with the official pinned 0.0.14 binary. Legacy `export NAME=...` activation syntax is parsed as text without evaluating shell commands. A normalized runtime-key copy remains private to the deployment. Backend bearer authentication, when configured, remains enabled; the generated YAML uses private file references for both MCP discovery and runtime Authorization headers, not literal tokens. These references survive later profile-preserving upgrades. Changing the bearer token later also requires updating that credential reference as an explicit, tested authentication change.

An independent rollback timer is armed before profile/service publication. No fictional previous backend is assumed and no old tunnel drain is required. The new tunnel must prove fresh successful control-plane polling before it is enabled for future boot. If activation fails, rollback disables/removes only the newly created tunnel profile and restores any pre-existing helper files it touched. It does not restart another tunnel or stop user work in a backend. Private failed deployment evidence is retained for diagnosis; inspect it rather than resubmitting the same operation blindly.

## Acceptance, not just startup

Require a committed plan, matching active release identity, successful filesystem and shell execution canaries, and healthy fresh control-plane polling. Confirm the coordinated recovery timer is enabled. Verify the unrelated Overdeck process identity, service state and profile bytes were unchanged. Compare original config and activation file hashes before/after without publishing credentials.

Then test from the desktop connector itself: fresh system.info, an allowed write/read/delete and durable job start/status/output/cancellation. Local polling alone does not prove that the intended ChatGPT connector received a tool result. Record timestamps, exact revision, test counts, service names, canary results and any unverified checks in the shared coordination file, with no secret values.

## Validation of this addition

Automated bootstrap tests use fake service control and cover complete publication, failed-poll rollback, duplicate identity rejection, occupied health ports, legacy activation syntax, bearer-reference preservation and original Overdeck/config/credential preservation. The pinned 0.0.14 binary also generated and parsed a disposable profile with both Authorization references successfully. Neither that native profile check nor the mocked activation tests started a real tunnel or contacted the public control plane. Live desktop acceptance remains the desktop agent's responsibility.
