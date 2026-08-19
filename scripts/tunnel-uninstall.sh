#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE_NAME="${CHATGPT_MCP_PROFILE:-chatgpt-computer}"
SERVICE_NAME="chatgpt-mcp-tunnel.service"
SYSTEMD_UNIT="$HOME/.config/systemd/user/$SERVICE_NAME"
USER_LIB="$HOME/.local/lib/chatgpt-mcp"
PROFILE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client"
PROFILE_FILE="$PROFILE_DIR/$PROFILE_NAME.yaml"

systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
rm -f "$SYSTEMD_UNIT"
rm -rf "$USER_LIB"
systemctl --user daemon-reload 2>/dev/null || true

if [[ -f "$PROFILE_FILE" ]]; then
  mv "$PROFILE_FILE" "$PROFILE_FILE.disabled.$(date +%Y%m%d-%H%M%S)"
fi

echo "Removed the persistent tunnel service and disabled profile '$PROFILE_NAME'."
echo "Repository files, config.local.json, and .secrets were left untouched."
