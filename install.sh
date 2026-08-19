#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE_NAME="${CHATGPT_MCP_PROFILE:-chatgpt-computer}"
SERVICE_NAME="chatgpt-mcp-tunnel.service"
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

It stores them locally under .secrets/ with restrictive permissions and never
prints the values.

Options:
  --yes         accept the broad-control configuration without prompting
  --no-desktop  do not attempt to install xdotool/xdg-utils/screenshot helpers
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
  line="${line%$'\r'}"
  line="$(trim "$line")"
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

  if [[ -z "$tunnel_id" && -r "$TUNNEL_FILE" ]]; then
    tunnel_id="$(read_secret_file "$TUNNEL_FILE" || true)"
  fi
  if [[ -z "$api_key" && -r "$API_FILE" ]]; then
    api_key="$(read_secret_file "$API_FILE" || true)"
  fi

  # Compatibility with the first local activation package.
  if [[ -z "$tunnel_id" && -r "$SECRETS_DIR/chatgpt-mcp.tunnel" ]]; then
    tunnel_id="$(read_secret_file "$SECRETS_DIR/chatgpt-mcp.tunnel" || true)"
  fi
  if [[ -z "$api_key" ]]; then
    local legacy
    for legacy in "$SECRETS_DIR/chatgpt-mcp-tunnel.api" "$SECRETS_DIR/chatgpt-mtp-tunnel.api"; do
      if [[ -r "$legacy" ]]; then
        api_key="$(read_secret_file "$legacy" || true)"
        [[ -n "$api_key" ]] && break
      fi
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

ensure_git_ignores() {
  if [[ -f "$REPO/.gitignore" ]]; then
    grep -qxF '.secrets/' "$REPO/.gitignore" || printf '.secrets/\n' >> "$REPO/.gitignore"
    grep -qxF 'config.local.json' "$REPO/.gitignore" || printf 'config.local.json\n' >> "$REPO/.gitignore"
  fi
}

install_apt_packages() {
  (($#)) || return 0
  command -v apt-get >/dev/null 2>&1 || return 1
  if [[ $(id -u) -eq 0 ]]; then
    apt-get update
    apt-get install -y "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y "$@"
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
    install_apt_packages "${missing[@]}" || die "Missing ${missing[*]}. Install them and rerun ./install.sh."
  fi
}

install_tunnel_client() {
  if command -v tunnel-client >/dev/null 2>&1; then
    TUNNEL_CLIENT="$(command -v tunnel-client)"
    return 0
  fi

  ensure_base_tools
  local os arch target tmp metadata asset_url checksum_url archive found companion
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "Unsupported architecture for automatic tunnel-client install: $(uname -m)" ;;
  esac
  [[ "$os" == linux ]] || die "Automatic tunnel-client install currently supports Linux only. Download it from https://github.com/openai/tunnel-client/releases/latest"
  target="$os-$arch.zip"

  say "Installing the latest official OpenAI tunnel-client"
  tmp="$(mktemp -d)"
  metadata="$tmp/release.json"
  curl -fsSL -H 'Accept: application/vnd.github+json' \
    https://api.github.com/repos/openai/tunnel-client/releases/latest \
    -o "$metadata" || die "Could not query the official tunnel-client release. Download it from https://github.com/openai/tunnel-client/releases/latest"

  asset_url="$(python3 - "$metadata" "$target" <<'PY'
import json, sys
path, target = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    release = json.load(f)
for asset in release.get('assets', []):
    name = asset.get('name', '')
    if name == target or name.endswith('-' + target):
        print(asset.get('browser_download_url', ''))
        break
PY
)"
  checksum_url="$(python3 - "$metadata" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    release = json.load(f)
for asset in release.get('assets', []):
    if asset.get('name') == 'SHA256SUMS.txt':
        print(asset.get('browser_download_url', ''))
        break
PY
)"
  [[ -n "$asset_url" ]] || die "Latest release has no $target archive. Download tunnel-client manually from https://github.com/openai/tunnel-client/releases/latest"

  archive="$tmp/$target"
  curl -fL "$asset_url" -o "$archive"
  if [[ -n "$checksum_url" ]] && command -v sha256sum >/dev/null 2>&1; then
    curl -fsSL "$checksum_url" -o "$tmp/SHA256SUMS.txt"
    local checksum_line
    checksum_line="$(grep -E "[[:space:]]+\*?$target$" "$tmp/SHA256SUMS.txt" | head -n1 || true)"
    [[ -n "$checksum_line" ]] || die "Official SHA256SUMS.txt did not contain $target."
    (cd "$tmp" && printf '%s\n' "$checksum_line" | sha256sum -c -)
  fi

  unzip -q "$archive" -d "$tmp/unpacked"
  found="$(find "$tmp/unpacked" -type f -name tunnel-client -print -quit)"
  [[ -n "$found" ]] || die "Downloaded archive did not contain tunnel-client."

  mkdir -p "$USER_BIN"
  install -m 0755 "$found" "$USER_BIN/tunnel-client"
  companion="$(find "$tmp/unpacked" -type f -name cloudflared -print -quit)"
  if [[ -n "$companion" ]]; then
    install -m 0755 "$companion" "$USER_BIN/cloudflared"
  fi
  rm -rf "$tmp"

  TUNNEL_CLIENT="$USER_BIN/tunnel-client"
  export PATH="$USER_BIN:$PATH"
  "$TUNNEL_CLIENT" --version || "$TUNNEL_CLIENT" help quickstart >/dev/null
}

install_desktop_packages() {
  $INSTALL_DESKTOP || return 0
  local need=()
  command -v xdotool >/dev/null 2>&1 || need+=(xdotool)
  command -v xdg-open >/dev/null 2>&1 || need+=(xdg-utils)
  if ! command -v grim >/dev/null 2>&1 \
    && ! command -v gnome-screenshot >/dev/null 2>&1 \
    && ! command -v scrot >/dev/null 2>&1 \
    && ! command -v import >/dev/null 2>&1; then
    need+=(scrot)
  fi
  ((${#need[@]})) || return 0
  say "Installing optional desktop helpers: ${need[*]}"
  install_apt_packages "${need[@]}" || warn "Could not auto-install desktop helpers (${need[*]}). Core MCP/tunnel setup will continue."
}

write_full_config() {
  [[ -f "$FULL_CONFIG" ]] || die "Missing $FULL_CONFIG"
  if [[ -f "$LOCAL_CONFIG" ]]; then
    cp -p "$LOCAL_CONFIG" "$SECRETS_DIR/config.local.json.backup.$(date +%Y%m%d-%H%M%S)"
  fi
  cp "$FULL_CONFIG" "$LOCAL_CONFIG"
  chmod 600 "$LOCAL_CONFIG"
}

write_launcher() {
  local runtime_path="$1"
  mkdir -p "$USER_LIB"
  cat > "$USER_LIB/run-tunnel.sh" <<LAUNCHER
#!/usr/bin/env bash
set -Eeuo pipefail
REPO=$(printf '%q' "$REPO")
API_FILE=$(printf '%q' "$API_FILE")
TUNNEL_CLIENT=$(printf '%q' "$TUNNEL_CLIENT")
PROFILE_NAME=$(printf '%q' "$PROFILE_NAME")
PROFILE_DIR=$(printf '%q' "$PROFILE_DIR")

trim() {
  local value="\$1"
  value="\${value#"\${value%%[![:space:]]*}"}"
  value="\${value%"\${value##*[![:space:]]}"}"
  printf '%s' "\$value"
}
read_secret() {
  local line value
  line="\$(grep -m1 -vE '^[[:space:]]*(#|$)' "\$1" 2>/dev/null || true)"
  line="\$(trim "\${line%\$'\\r'}")"
  [[ -n "\$line" ]] || { echo 'runtime API key file is empty' >&2; exit 1; }
  [[ "\$line" == export\\ * ]] && line="\${line#export }"
  if [[ "\$line" == *=* ]]; then value="\${line#*=}"; else value="\$line"; fi
  value="\$(trim "\$value")"
  if [[ \${#value} -ge 2 ]]; then
    if [[ "\${value:0:1}" == '"' && "\${value: -1}" == '"' ]]; then value="\${value:1:\${#value}-2}"; fi
    if [[ "\${value:0:1}" == "'" && "\${value: -1}" == "'" ]]; then value="\${value:1:\${#value}-2}"; fi
  fi
  [[ -n "\$value" ]] || { echo 'runtime API key file is empty' >&2; exit 1; }
  printf '%s' "\$value"
}

export CONTROL_PLANE_API_KEY="\$(read_secret "\$API_FILE")"
export CHATGPT_MCP_CONFIG="\$REPO/config.local.json"
export TUNNEL_CLIENT_PROFILE_DIR="\$PROFILE_DIR"
export PATH=$(printf '%q' "$runtime_path")

if [[ -z "\${DISPLAY:-}" && -S /tmp/.X11-unix/X0 ]]; then export DISPLAY=:0; fi
if [[ -z "\${XAUTHORITY:-}" && -f "\$HOME/.Xauthority" ]]; then export XAUTHORITY="\$HOME/.Xauthority"; fi

exec "\$TUNNEL_CLIENT" run --profile "\$PROFILE_NAME"
LAUNCHER
  chmod 700 "$USER_LIB/run-tunnel.sh"
}

write_service() {
  mkdir -p "$SYSTEMD_DIR"
  cat > "$SYSTEMD_DIR/$SERVICE_NAME" <<SERVICE
[Unit]
Description=OpenAI Secure MCP Tunnel for chatgpt-mcp
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
ExecStart=$USER_LIB/run-tunnel.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE
}

main() {
  [[ "$(uname -s)" == Linux ]] || die "The current LocalComputerAdapter and this installer target Linux."
  [[ -f "$REPO/package.json" && -f "$REPO/src/stdio.ts" ]] || die "Run this script from a chatgpt-mcp checkout."

  say "chatgpt-mcp one-command installer"
  info "Repository: $REPO"
  printf '\nThis installer enables broad owner-controlled access by default:\n'
  printf '  filesystem read/write: /\n'
  printf '  shell executables:     *\n'
  printf '  process list/kill:     enabled\n'
  printf '  systemd services:      enabled\n'
  printf '  browser/screenshot/input: enabled when host tools support them\n'
  if ! $ASSUME_YES; then
    [[ -t 0 ]] || die "Non-interactive install requires --yes."
    printf '\nType YES to continue: '
    local answer
    IFS= read -r answer
    [[ "$answer" == YES ]] || die "Installation cancelled."
  fi

  ensure_git_ignores
  load_credentials

  command -v node >/dev/null 2>&1 || die "Node.js 22+ is required. Install Node 22 or newer and rerun."
  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(`.`)[0])')"
  (( node_major >= 22 )) || die "Node.js 22+ is required; found $(node --version)."

  local -a pnpm_cmd=()
  if command -v corepack >/dev/null 2>&1; then
    # Do not run `corepack enable`: distro Corepack packages often cannot write
    # their shim into /usr/bin as a normal user. Invoke pnpm through Corepack.
    if corepack pnpm --version >/dev/null 2>&1; then
      pnpm_cmd=(corepack pnpm)
    elif corepack prepare pnpm@9.7.0 --activate >/dev/null 2>&1 \
      && corepack pnpm --version >/dev/null 2>&1; then
      pnpm_cmd=(corepack pnpm)
    fi
  fi
  if ((${#pnpm_cmd[@]} == 0)); then
    if command -v npx >/dev/null 2>&1; then
      pnpm_cmd=(npx -y pnpm@9.7.0)
    else
      die "Need working Corepack or npx to run pnpm 9.7.0."
    fi
  fi

  install_tunnel_client
  command -v systemctl >/dev/null 2>&1 || die "systemd/systemctl is required for the persistent user service."
  systemctl --user show-environment >/dev/null 2>&1 || die "A working systemd user session is required."

  say "Installing dependencies and running the full gate"
  cd "$REPO"
  "${pnpm_cmd[@]}" install --frozen-lockfile
  "${pnpm_cmd[@]}" gate

  say "Writing broad local capability configuration"
  write_full_config
  install_desktop_packages

  say "Checking the MCP stdio entrypoint"
  [[ -f "$REPO/dist/src/stdio.js" ]] || die "Build did not produce dist/src/stdio.js"
  local stdio_rc
  set +e
  CHATGPT_MCP_CONFIG="$LOCAL_CONFIG" timeout 1s node "$REPO/dist/src/stdio.js" >/dev/null 2>"$SECRETS_DIR/stdio-check.err"
  stdio_rc=$?
  set -e
  if [[ $stdio_rc -ne 124 && $stdio_rc -ne 0 ]]; then
    cat "$SECRETS_DIR/stdio-check.err" >&2 || true
    die "Local MCP stdio process exited unexpectedly (status $stdio_rc)."
  fi
  rm -f "$SECRETS_DIR/stdio-check.err"

  say "Creating tunnel-client profile '$PROFILE_NAME'"
  mkdir -p "$PROFILE_DIR"
  chmod 700 "$PROFILE_DIR"
  if [[ -f "$PROFILE_FILE" ]]; then
    mv "$PROFILE_FILE" "$PROFILE_FILE.backup.$(date +%Y%m%d-%H%M%S)"
  fi
  export CHATGPT_MCP_CONFIG="$LOCAL_CONFIG"
  export TUNNEL_CLIENT_PROFILE_DIR="$PROFILE_DIR"
  "$TUNNEL_CLIENT" init \
    --sample sample_mcp_stdio_local \
    --profile "$PROFILE_NAME" \
    --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
    --mcp-command "$(command -v node) $REPO/dist/src/stdio.js"

  say "Running tunnel diagnostics"
  "$TUNNEL_CLIENT" doctor --profile "$PROFILE_NAME" --explain

  say "Installing persistent systemd user service"
  local runtime_path="$USER_BIN:$PATH"
  write_launcher "$runtime_path"
  write_service
  systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR XDG_SESSION_TYPE 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
  sleep 3
  if ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
    journalctl --user -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
    die "Tunnel service did not stay active."
  fi

  say "Final verification"
  "$TUNNEL_CLIENT" doctor --profile "$PROFILE_NAME" --explain

  local screenshot_backend=unavailable
  if command -v grim >/dev/null 2>&1; then screenshot_backend=grim
  elif command -v gnome-screenshot >/dev/null 2>&1; then screenshot_backend=gnome-screenshot
  elif command -v scrot >/dev/null 2>&1; then screenshot_backend=scrot
  elif command -v import >/dev/null 2>&1; then screenshot_backend=import
  fi

  printf '\n============================================================\n'
  printf 'LOCAL SETUP COMPLETE\n'
  printf '============================================================\n'
  printf 'Profile:          %s\n' "$PROFILE_NAME"
  printf 'Tunnel service:   ACTIVE\n'
  printf 'Screen capture:   %s\n' "$screenshot_backend"
  printf 'Desktop input:    %s (session=%s)\n' "$(command -v xdotool >/dev/null 2>&1 && echo enabled || echo unavailable)" "${XDG_SESSION_TYPE:-unknown}"
  printf '\nRemaining ChatGPT steps:\n'
  printf '  1. Enable ChatGPT Developer mode.\n'
  printf '  2. Open https://chatgpt.com/plugins\n'
  printf '  3. Click +, create a developer-mode app, choose Connection = Tunnel.\n'
  printf '  4. Select this tunnel, enable the app in a chat, and call system.info.\n'
  printf '\nCheck later with: ./scripts/tunnel-status.sh\n'
}

main
