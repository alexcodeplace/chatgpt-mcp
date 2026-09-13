#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE_NAME="${CHATGPT_MCP_PROFILE:-chatgpt-computer}"
TUNNEL_SERVICE_NAME="chatgpt-mcp-tunnel-${PROFILE_NAME}.service"
LEGACY_TUNNEL_SERVICE_NAME="chatgpt-mcp-tunnel.service"
MCP_SERVICE_NAME="chatgpt-mcp.service"
WATCHDOG_SERVICE_NAME="chatgpt-mcp-recovery.service"
WATCHDOG_TIMER_NAME="chatgpt-mcp-recovery.timer"
HEALTH_PORT="${CHATGPT_MCP_HEALTH_PORT:-}"
HEALTH_ADDR=""
PNPM_VERSION="11.20.0"
REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SECRETS_DIR="$REPO/.secrets"
TUNNEL_FILE="$SECRETS_DIR/tunnel-id"
API_FILE="$SECRETS_DIR/runtime-api-key"
FULL_CONFIG="$REPO/config.full.example.json"
LOCAL_CONFIG="$REPO/config.local.json"
USER_LIB="$HOME/.local/lib/chatgpt-mcp"
USER_BIN="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"
PROFILE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client"
PROFILE_FILE="$PROFILE_DIR/$PROFILE_NAME.yaml"
ASSUME_YES=false
INSTALL_DESKTOP=true

say()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: ./install.sh [--yes] [--no-desktop]

Installs and activates chatgpt-mcp through OpenAI Secure MCP Tunnel.

Before running, create:
  1. A tunnel at https://platform.openai.com/settings/organization/tunnels
  2. A runtime API key at https://platform.openai.com/settings/organization/api-keys

The installer asks for both values if they are not already supplied through:
  CONTROL_PLANE_TUNNEL_ID
  CONTROL_PLANE_API_KEY

Options:
  --yes         accept the broad-control configuration without prompting
  --no-desktop  do not attempt to install xdotool/xdg-utils/screenshot/recording helpers
  -h, --help    show this help
USAGE
}

while (($#)); do
  case "$1" in
    --yes) ASSUME_YES=true ;;
    --no-desktop) INSTALL_DESKTOP=false ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

read_secret_file() {
  local file="$1" line value
  [[ -r "$file" ]] || return 1
  line="$(grep -m1 -vE '^[[:space:]]*(#|$)' "$file" 2>/dev/null || true)"
  line="$(trim "${line%$'\r'}")"
  [[ -n "$line" ]] || return 1
  [[ "$line" == export\ * ]] && line="${line#export }"
  if [[ "$line" == *=* ]]; then value="${line#*=}"; else value="$line"; fi
  value="$(trim "$value")"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then value="${value:1:${#value}-2}"; fi
    if [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then value="${value:1:${#value}-2}"; fi
  fi
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

store_secret() {
  local file="$1" value="$2"
  umask 077
  printf '%s\n' "$value" > "$file"
  chmod 600 "$file"
}

load_credentials() {
  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"

  local tunnel_id="${CONTROL_PLANE_TUNNEL_ID:-}"
  local api_key="${CONTROL_PLANE_API_KEY:-}"
  local legacy

  [[ -n "$tunnel_id" ]] || tunnel_id="$(read_secret_file "$TUNNEL_FILE" 2>/dev/null || true)"
  [[ -n "$api_key" ]] || api_key="$(read_secret_file "$API_FILE" 2>/dev/null || true)"

  # Compatibility with the original local activation package.
  [[ -n "$tunnel_id" ]] || tunnel_id="$(read_secret_file "$SECRETS_DIR/chatgpt-mcp.tunnel" 2>/dev/null || true)"
  if [[ -z "$api_key" ]]; then
    for legacy in "$SECRETS_DIR/chatgpt-mcp-tunnel.api" "$SECRETS_DIR/chatgpt-mtp-tunnel.api"; do
      api_key="$(read_secret_file "$legacy" 2>/dev/null || true)"
      [[ -z "$api_key" ]] || break
    done
  fi

  if [[ -z "$tunnel_id" ]]; then
    [[ -t 0 ]] || die "Missing tunnel ID. Set CONTROL_PLANE_TUNNEL_ID or rerun interactively."
    printf 'OpenAI tunnel ID (tunnel_...): '
    IFS= read -r tunnel_id
    tunnel_id="$(trim "$tunnel_id")"
  fi
  [[ "$tunnel_id" =~ ^tunnel_[0-9a-f]{32}$ ]] || die "Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters."

  if [[ -z "$api_key" ]]; then
    [[ -t 0 ]] || die "Missing runtime API key. Set CONTROL_PLANE_API_KEY or rerun interactively."
    printf 'OpenAI runtime API key (input hidden): '
    IFS= read -rs api_key
    printf '\n'
    api_key="$(trim "$api_key")"
  fi
  [[ -n "$api_key" ]] || die "Runtime API key cannot be empty."

  store_secret "$TUNNEL_FILE" "$tunnel_id"
  store_secret "$API_FILE" "$api_key"
  export CONTROL_PLANE_TUNNEL_ID="$tunnel_id"
  export CONTROL_PLANE_API_KEY="$api_key"
}

install_apt_packages() {
  (($#)) || return 0
  command -v apt-get >/dev/null 2>&1 || return 1
  if [[ $(id -u) -eq 0 ]]; then
    apt-get update && apt-get install -y "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y "$@"
  else
    return 1
  fi
}

ensure_base_tools() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v unzip >/dev/null 2>&1 || missing+=(unzip)
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  if ((${#missing[@]})); then
    say "Installing installer prerequisites: ${missing[*]}"
    install_apt_packages "${missing[@]}" || die "Install these prerequisites and rerun: ${missing[*]}"
  fi
}

select_pnpm() {
  if command -v corepack >/dev/null 2>&1 && corepack "pnpm@$PNPM_VERSION" --version >/dev/null 2>&1; then
    PNPM_CMD=(corepack "pnpm@$PNPM_VERSION")
    return
  fi
  if command -v npx >/dev/null 2>&1; then
    PNPM_CMD=(npx -y "pnpm@$PNPM_VERSION")
    return
  fi
  die "Need Corepack or npx to run pnpm $PNPM_VERSION."
}

install_tunnel_client() {
  ensure_base_tools
  TUNNEL_CLIENT="$(python3 "$REPO/scripts/install-tunnel.py")"
  export PATH="$(dirname "$TUNNEL_CLIENT"):$PATH"
}

install_desktop_packages() {
  $INSTALL_DESKTOP || return 0
  local need=()
  command -v xdotool >/dev/null 2>&1 || need+=(xdotool)
  command -v xdg-open >/dev/null 2>&1 || need+=(xdg-utils)
  command -v ffmpeg >/dev/null 2>&1 || need+=(ffmpeg)
  if ! command -v grim >/dev/null 2>&1 && ! command -v gnome-screenshot >/dev/null 2>&1 \
    && ! command -v scrot >/dev/null 2>&1 && ! command -v import >/dev/null 2>&1; then
    need+=(scrot)
  fi
  ((${#need[@]})) || return 0
  say "Installing optional desktop helpers: ${need[*]}"
  install_apt_packages "${need[@]}" || warn "Could not auto-install desktop helpers; core MCP/tunnel setup will continue."
}

select_health_port() {
  local existing=""
  if [[ -z "$HEALTH_PORT" && -f "$PROFILE_FILE" ]]; then
    existing="$(sed -nE 's/^[[:space:]]*listen_addr:[[:space:]]*"127\.0\.0\.1:([0-9]+)".*/\1/p' "$PROFILE_FILE" | head -n1)"
    [[ "$existing" == 0 ]] || HEALTH_PORT="$existing"
  fi

  if [[ -z "$HEALTH_PORT" ]]; then
    HEALTH_PORT="$(python3 - <<'PY'
import socket
for port in range(8080, 8100):
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        sock.close()
        continue
    sock.close()
    print(port)
    break
else:
    raise SystemExit("no free tunnel health port in 8080-8099")
PY
)"
  fi

  [[ "$HEALTH_PORT" =~ ^[0-9]+$ ]] || die "CHATGPT_MCP_HEALTH_PORT must be numeric."
  (( HEALTH_PORT >= 1024 && HEALTH_PORT <= 65535 )) || die "CHATGPT_MCP_HEALTH_PORT must be between 1024 and 65535."
  HEALTH_ADDR="127.0.0.1:$HEALTH_PORT"
  info "Tunnel health endpoint: http://$HEALTH_ADDR"
}

write_launchers() {
  mkdir -p "$USER_LIB"
  cat > "$USER_LIB/run-mcp-http.sh" <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
: "${CHATGPT_MCP_REPO:?CHATGPT_MCP_REPO is required}"
: "${CHATGPT_MCP_NODE_BIN:?CHATGPT_MCP_NODE_BIN is required}"
export CHATGPT_MCP_CONFIG="${CHATGPT_MCP_CONFIG:-$CHATGPT_MCP_REPO/config.local.json}"
if [[ -z "${XAUTHORITY:-}" && -f "$HOME/.Xauthority" ]]; then export XAUTHORITY="$HOME/.Xauthority"; fi
exec "$CHATGPT_MCP_NODE_BIN" "$CHATGPT_MCP_REPO/dist/src/http.js"
LAUNCHER

  cat > "$USER_LIB/run-tunnel.sh" <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
: "${CHATGPT_MCP_REPO:?CHATGPT_MCP_REPO is required}"
: "${TUNNEL_CLIENT_BIN:?TUNNEL_CLIENT_BIN is required}"
: "${CHATGPT_MCP_PROFILE:?CHATGPT_MCP_PROFILE is required}"
API_FILE="$CHATGPT_MCP_REPO/.secrets/runtime-api-key"
[[ -r "$API_FILE" ]] || { echo "Missing runtime API key: $API_FILE" >&2; exit 1; }
export CONTROL_PLANE_API_KEY="$(head -n1 "$API_FILE" | tr -d '\r\n')"
version="$("$TUNNEL_CLIENT_BIN" --version)"
[[ "$version" == 0.0.14+* || "$version" == 0.0.14\ * || "$version" == 0.0.14 ]] || { echo 'TUNNEL_VERSION_MISMATCH: expected 0.0.14' >&2; exit 78; }
exec "$TUNNEL_CLIENT_BIN" run --profile "$CHATGPT_MCP_PROFILE"
LAUNCHER
  chmod 700 "$USER_LIB/run-mcp-http.sh" "$USER_LIB/run-tunnel.sh"
}

write_services() {
  mkdir -p "$SYSTEMD_DIR"
  cat > "$SYSTEMD_DIR/$MCP_SERVICE_NAME" <<SERVICE
[Unit]
Description=chatgpt-mcp local HTTP service
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
WorkingDirectory=$REPO
Environment=CHATGPT_MCP_REPO=$REPO
Environment=CHATGPT_MCP_NODE_BIN=$(command -v node)
UnsetEnvironment=DISPLAY WAYLAND_DISPLAY MIR_SOCKET
ExecStart=$USER_LIB/run-mcp-http.sh
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=78
TimeoutStopSec=5
TasksMax=512
LimitNOFILE=65536
MemoryHigh=6G
MemoryMax=9G
CPUWeight=80

[Install]
WantedBy=default.target
SERVICE

  cat > "$SYSTEMD_DIR/$TUNNEL_SERVICE_NAME" <<SERVICE
[Unit]
Description=OpenAI Secure MCP Tunnel for chatgpt-mcp ($PROFILE_NAME)
Wants=network-online.target $MCP_SERVICE_NAME
After=network-online.target $MCP_SERVICE_NAME
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
WorkingDirectory=$REPO
Environment=CHATGPT_MCP_REPO=$REPO
Environment=TUNNEL_CLIENT_BIN=$TUNNEL_CLIENT
Environment=CHATGPT_MCP_PROFILE=$PROFILE_NAME
Environment=TUNNEL_CLIENT_PROFILE_DIR=$PROFILE_DIR
ExecStart=$USER_LIB/run-tunnel.sh
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
SERVICE


}

write_watchdog() {
  python3 "$REPO/scripts/install-recovery.py" --runtime "$REPO" --profile "$PROFILE_NAME" --health-url "http://$HEALTH_ADDR"
}

legacy_service_is_this_profile() {
  local unit="$SYSTEMD_DIR/$LEGACY_TUNNEL_SERVICE_NAME"
  [[ -f "$unit" ]] || return 1
  grep -Fqx "Environment=CHATGPT_MCP_PROFILE=$PROFILE_NAME" "$unit"
}

wait_for_http_backend() {
  local attempt
  for attempt in {1..20}; do
    if curl -fsS http://127.0.0.1:3210/healthz >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  journalctl --user -u "$MCP_SERVICE_NAME" -n 80 --no-pager >&2 || true
  return 1
}

wait_for_tunnel_ready() {
  local attempt
  for attempt in {1..90}; do
    if curl -fsS --max-time 2 "http://$HEALTH_ADDR/readyz" >/dev/null 2>&1 && \
       python3 - "$HEALTH_ADDR" <<'POLL'
import sys, time, urllib.request, re
try:
    text = urllib.request.urlopen('http://' + sys.argv[1] + '/metrics', timeout=2).read().decode()
    match = re.search(r'^commands_poll_last_successful_timestamp_seconds(?:\{[^\n]*\})?\s+([0-9.eE+-]+)', text, re.M)
    age = time.time() - float(match.group(1)) if match else 999999
    sys.exit(0 if -5 <= age <= 60 else 1)
except Exception:
    sys.exit(1)
POLL
    then return 0; fi
    sleep 0.25
  done
  journalctl --user -u "$TUNNEL_SERVICE_NAME" -n 80 --no-pager >&2 || true
  return 1
}

main() {
  [[ "$(uname -s)" == Linux ]] || die "This installer currently targets Linux."
  [[ -f "$REPO/package.json" && -f "$REPO/src/stdio.ts" && -f "$REPO/src/http.ts" ]] || die "Run this script from a chatgpt-mcp checkout."
  [[ "$PROFILE_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || die "CHATGPT_MCP_PROFILE may contain only letters, numbers, dot, underscore, and dash."

  say "chatgpt-mcp one-command installer"
  info "Repository: $REPO"
  printf '\nThis installer enables broad owner-controlled access by default.\n'
  if ! $ASSUME_YES; then
    [[ -t 0 ]] || die "Non-interactive install requires --yes."
    printf 'Type YES to continue: '
    local answer
    IFS= read -r answer
    [[ "$answer" == YES ]] || die "Installation cancelled."
  fi

  mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
  load_credentials
  command -v node >/dev/null 2>&1 || die "Node.js 22+ is required."
  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(`.`)[0])')"
  (( node_major >= 22 )) || die "Node.js 22+ is required; found $(node --version)."
  select_pnpm
  install_tunnel_client
  ensure_base_tools
  select_health_port
  command -v systemctl >/dev/null 2>&1 || die "systemd/systemctl is required for the persistent user service."
  systemctl --user show-environment >/dev/null 2>&1 || die "A working systemd user session is required."

  say "Installing dependencies and running the full gate with pnpm $PNPM_VERSION"
  cd "$REPO"
  "${PNPM_CMD[@]}" install --frozen-lockfile
  "${PNPM_CMD[@]}" gate

  say "Preserving existing capability configuration (initializing only on first install)"
  [[ -f "$FULL_CONFIG" ]] || die "Missing $FULL_CONFIG"
  if [[ ! -f "$LOCAL_CONFIG" ]]; then cp "$FULL_CONFIG" "$LOCAL_CONFIG"; fi
  chmod 600 "$LOCAL_CONFIG"
  install_desktop_packages

  say "Checking the MCP HTTP entrypoint"
  [[ -f "$REPO/dist/src/http.js" ]] || die "Build did not produce dist/src/http.js"

  say "Creating tunnel-client profile '$PROFILE_NAME'"
  mkdir -p "$PROFILE_DIR"; chmod 700 "$PROFILE_DIR"
  # An update must not replace existing per-account transport/auth settings.
  if [[ ! -f "$PROFILE_FILE" ]]; then
  export TUNNEL_CLIENT_PROFILE_DIR="$PROFILE_DIR"
  "$TUNNEL_CLIENT" init \
    --sample sample_mcp_remote_no_auth \
    --profile "$PROFILE_NAME" \
    --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
    --health-listen-addr "$HEALTH_ADDR" \
    --mcp-server-url "http://127.0.0.1:3210/mcp"
  fi

  say "Installing persistent systemd user services"
  write_launchers
  write_services
  write_watchdog
  systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR XDG_SESSION_TYPE 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable "$MCP_SERVICE_NAME"
  systemctl --user restart "$MCP_SERVICE_NAME"
  wait_for_http_backend || die "Local MCP HTTP service did not become healthy."

  say "Running tunnel diagnostics against the supervised HTTP backend"
  "$TUNNEL_CLIENT" doctor --profile "$PROFILE_NAME" --explain || warn "Tunnel doctor reported a diagnostic failure; runtime readiness will be authoritative."

  if legacy_service_is_this_profile; then
    systemctl --user disable --now "$LEGACY_TUNNEL_SERVICE_NAME" 2>/dev/null || true
  fi
  systemctl --user enable "$TUNNEL_SERVICE_NAME"
  systemctl --user restart "$TUNNEL_SERVICE_NAME"
  wait_for_tunnel_ready || die "Tunnel service did not become ready."
  systemctl --user enable --now "$WATCHDOG_TIMER_NAME"

  say "Final verification"
  wait_for_http_backend || die "Local MCP HTTP service is not healthy."
  wait_for_tunnel_ready || die "Tunnel readiness check failed."
  "$TUNNEL_CLIENT" doctor --profile "$PROFILE_NAME" --explain || warn "Tunnel doctor reported a diagnostic failure even though live readiness passed."

  printf '\n============================================================\n'
  printf 'LOCAL SETUP COMPLETE\n'
  printf '============================================================\n'
  printf 'Profile:        %s\n' "$PROFILE_NAME"
  printf 'MCP HTTP service: ACTIVE\n'
  printf 'Tunnel service:  %s ACTIVE\n' "$TUNNEL_SERVICE_NAME"
  printf 'Health endpoint: http://%s/readyz\n' "$HEALTH_ADDR"
  printf 'Watchdog timer:  %s ACTIVE\n' "$WATCHDOG_TIMER_NAME"
  printf '\nRemaining ChatGPT steps:\n'
  printf '  1. Enable ChatGPT Developer mode.\n'
  printf '  2. Open https://chatgpt.com/plugins\n'
  printf '  3. Create a developer-mode app with Connection = Tunnel.\n'
  printf '  4. Select this tunnel, enable the app, and call system.info.\n'
  printf '\nCheck later with: ./scripts/tunnel-status.sh\n'
}

main
