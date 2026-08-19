#!/usr/bin/env bash
set -Eeuo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROFILE_NAME="${CHATGPT_MCP_PROFILE:-chatgpt-computer}"
SERVICE_NAME="chatgpt-mcp-tunnel.service"
API_FILE="$REPO/.secrets/runtime-api-key"

trim() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

read_secret() {
  local l v
  l="$(grep -m1 -vE '^[[:space:]]*(#|$)' "$1" 2>/dev/null || true)"
  l="$(trim "${l%$'\r'}")"
  [[ "$l" == export\ * ]] && l="${l#export }"
  if [[ "$l" == *=* ]]; then v="${l#*=}"; else v="$l"; fi
  v="$(trim "$v")"
  v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
  printf '%s' "$v"
}

printf 'Tunnel service: '
if systemctl --user is-active --quiet "$SERVICE_NAME"; then
  echo ACTIVE
else
  echo NOT_ACTIVE
fi
systemctl --user status "$SERVICE_NAME" --no-pager --lines=15 || true

if [[ -r "$API_FILE" ]]; then
  export CONTROL_PLANE_API_KEY="$(read_secret "$API_FILE")"
  export CHATGPT_MCP_CONFIG="$REPO/config.local.json"
  export HEALTH_LISTEN_ADDR="127.0.0.1:0"
  printf '\nTunnel doctor:\n'
  tunnel-client doctor --profile "$PROFILE_NAME" --explain || true
else
  printf '\nCannot run tunnel doctor: %s is missing.\n' "$API_FILE" >&2
fi
