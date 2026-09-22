#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE_NAME="${CHATGPT_MCP_PROFILE:-chatgpt-computer}"
TUNNEL_SERVICE_NAME="chatgpt-mcp-tunnel-${PROFILE_NAME}.service"
LEGACY_TUNNEL_SERVICE_NAME="chatgpt-mcp-tunnel.service"
WATCHDOG_SERVICE_NAME="chatgpt-mcp-watchdog-${PROFILE_NAME}.service"
WATCHDOG_TIMER_NAME="chatgpt-mcp-watchdog-${PROFILE_NAME}.timer"
USER_LIB="$HOME/.local/lib/chatgpt-mcp"
SYSTEMD_DIR="$HOME/.config/systemd/user"
PROFILE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client"
PROFILE_FILE="$PROFILE_DIR/$PROFILE_NAME.yaml"

[[ "$PROFILE_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Invalid CHATGPT_MCP_PROFILE: $PROFILE_NAME" >&2; exit 2; }

# Serialize removal with both recovery and blue/green deployment.
RECOVERY_STATE="$HOME/.local/state/chatgpt-mcp/recovery"
mkdir -p "$RECOVERY_STATE"
exec 9>"$RECOVERY_STATE/recovery.lock"
flock -x 9
python3 - "$PROFILE_NAME" <<'PY'
import json, os, pathlib, sys, uuid
path = pathlib.Path.home() / '.config/chatgpt-mcp/recovery.json'
if path.exists():
    settings = json.loads(path.read_text())
    settings['profiles'] = [profile for profile in settings.get('profiles', []) if profile['name'] != sys.argv[1]]
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as out:
        json.dump(settings, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)
PY

systemctl --user disable --now "$WATCHDOG_TIMER_NAME" 2>/dev/null || true
systemctl --user stop "$WATCHDOG_SERVICE_NAME" 2>/dev/null || true
systemctl --user disable --now "$TUNNEL_SERVICE_NAME" 2>/dev/null || true
rm -f "$SYSTEMD_DIR/$WATCHDOG_TIMER_NAME" "$SYSTEMD_DIR/$WATCHDOG_SERVICE_NAME" "$SYSTEMD_DIR/$TUNNEL_SERVICE_NAME"
rm -f "$USER_LIB/watchdog-$PROFILE_NAME.sh"
rm -f "$SYSTEMD_DIR/$TUNNEL_SERVICE_NAME.d/60-reliability.conf"

if [[ -f "$SYSTEMD_DIR/$LEGACY_TUNNEL_SERVICE_NAME" ]] \
  && grep -Fqx "Environment=CHATGPT_MCP_PROFILE=$PROFILE_NAME" "$SYSTEMD_DIR/$LEGACY_TUNNEL_SERVICE_NAME"; then
  systemctl --user disable --now "$LEGACY_TUNNEL_SERVICE_NAME" 2>/dev/null || true
  rm -f "$SYSTEMD_DIR/$LEGACY_TUNNEL_SERVICE_NAME"
fi
systemctl --user daemon-reload 2>/dev/null || true

if [[ -f "$PROFILE_FILE" ]]; then
  mv "$PROFILE_FILE" "$PROFILE_FILE.disabled.$(date +%Y%m%d-%H%M%S)"
fi

echo "Removed tunnel service for profile '$PROFILE_NAME' and disabled its profile."
echo "The shared chatgpt-mcp HTTP service, recovery controller, other profiles, launchers, repository files, config.local.json, and .secrets were left untouched."
