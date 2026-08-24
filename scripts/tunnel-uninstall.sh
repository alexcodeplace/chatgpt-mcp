#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE_NAME="${CHATGPT_MCP_PROFILE:-chatgpt-computer}"
TUNNEL_SERVICE_NAME="chatgpt-mcp-tunnel-${PROFILE_NAME}.service"
LEGACY_TUNNEL_SERVICE_NAME="chatgpt-mcp-tunnel.service"
SYSTEMD_DIR="$HOME/.config/systemd/user"
PROFILE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client"
PROFILE_FILE="$PROFILE_DIR/$PROFILE_NAME.yaml"

[[ "$PROFILE_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Invalid CHATGPT_MCP_PROFILE: $PROFILE_NAME" >&2; exit 2; }

systemctl --user disable --now "$TUNNEL_SERVICE_NAME" 2>/dev/null || true
rm -f "$SYSTEMD_DIR/$TUNNEL_SERVICE_NAME"

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
echo "The shared chatgpt-mcp HTTP service, launchers, repository files, config.local.json, and .secrets were left untouched so other tunnel profiles keep working."
