#!/usr/bin/env bash
set -Eeuo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROFILE_NAME="${CHATGPT_MCP_PROFILE:-chatgpt-computer}"
TUNNEL_SERVICE_NAME="chatgpt-mcp-tunnel-${PROFILE_NAME}.service"
LEGACY_TUNNEL_SERVICE_NAME="chatgpt-mcp-tunnel.service"
MCP_SERVICE_NAME="chatgpt-mcp.service"
API_FILE="$REPO/.secrets/runtime-api-key"

[[ "$PROFILE_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Invalid CHATGPT_MCP_PROFILE: $PROFILE_NAME" >&2; exit 2; }

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

service_exists() {
  systemctl --user cat "$1" >/dev/null 2>&1
}

ACTIVE_TUNNEL_SERVICE="$TUNNEL_SERVICE_NAME"
if ! service_exists "$ACTIVE_TUNNEL_SERVICE" && service_exists "$LEGACY_TUNNEL_SERVICE_NAME"; then
  ACTIVE_TUNNEL_SERVICE="$LEGACY_TUNNEL_SERVICE_NAME"
fi

printf 'MCP HTTP service: '
if systemctl --user is-active --quiet "$MCP_SERVICE_NAME"; then
  echo ACTIVE
else
  echo NOT_ACTIVE
fi
systemctl --user status "$MCP_SERVICE_NAME" --no-pager --lines=10 || true

printf '\nMCP HTTP health: '
if curl -fsS http://127.0.0.1:3210/healthz >/dev/null 2>&1; then
  echo OK
else
  echo FAILED
fi

printf '\nTunnel service (%s): ' "$ACTIVE_TUNNEL_SERVICE"
if systemctl --user is-active --quiet "$ACTIVE_TUNNEL_SERVICE"; then
  echo ACTIVE
else
  echo NOT_ACTIVE
fi
systemctl --user status "$ACTIVE_TUNNEL_SERVICE" --no-pager --lines=15 || true

if [[ -r "$API_FILE" ]]; then
  export CONTROL_PLANE_API_KEY="$(read_secret "$API_FILE")"
  export HEALTH_LISTEN_ADDR="127.0.0.1:0"
  printf '\nTunnel doctor (%s):\n' "$PROFILE_NAME"
  tunnel-client doctor --profile "$PROFILE_NAME" --explain || true
else
  printf '\nCannot run tunnel doctor: %s is missing.\n' "$API_FILE" >&2
fi
