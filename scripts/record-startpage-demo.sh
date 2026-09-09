#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_MCP_DIR="${LIVE_MCP_DIR:-$HOME/.local/share/chatgpt-mcp}"
DISPLAY_TARGET="${DISPLAY_TARGET:-:0}"
SEARCH_QUERY="${SEARCH_QUERY:-vibeil community}"
OUTPUT="${OUTPUT:-$HOME/Projects/overdeck/inbox/vibeil-community-startpage-demo.mp4}"
PLAYBACK_SPEED="${PLAYBACK_SPEED:-0.5}"
FRAME_RATE="${FRAME_RATE:-20}"
CRF="${CRF:-24}"
PRESET="${PRESET:-veryfast}"
PROFILE_DIR="${PROFILE_DIR:-$(mktemp -d /tmp/chatgpt-startpage-demo-profile.XXXXXX)}"
PROFILE_DIR_IS_TEMP=0
[[ "$PROFILE_DIR" == /tmp/chatgpt-startpage-demo-profile.* ]] && PROFILE_DIR_IS_TEMP=1
MCP_URL="${MCP_URL:-http://127.0.0.1:3210/mcp}"

if [[ "$PLAYBACK_SPEED" != "0.5" ]]; then
  echo "This demo script currently requires PLAYBACK_SPEED=0.5" >&2
  exit 2
fi

for cmd in node ffmpeg ffprobe xdpyinfo xdotool; do
  command -v "$cmd" >/dev/null || { echo "missing dependency: $cmd" >&2; exit 1; }
done
[[ -d "$LIVE_MCP_DIR/node_modules/@modelcontextprotocol" ]] || {
  echo "live MCP dependencies not found at $LIVE_MCP_DIR" >&2
  exit 1
}

mkdir -p "$(dirname "$OUTPUT")" "$PROFILE_DIR"
RAW="${OUTPUT%.mp4}.raw.mp4"
META="${OUTPUT%.mp4}.json"
rm -f "$RAW" "$OUTPUT" "$META"

cat > "$PROFILE_DIR/user.js" <<'EOF'
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.startup.homepage_override.buildID", "");
user_pref("browser.startup.firstrunSkipsHomepage", true);
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.policy.firstRunURL", "");
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
EOF

if ! DISPLAY="$DISPLAY_TARGET" xdpyinfo >/dev/null 2>&1; then
  if [[ "$DISPLAY_TARGET" != ":0" ]]; then
    echo "display $DISPLAY_TARGET is not available" >&2
    exit 1
  fi
  echo "DISPLAY :0 is absent; starting a local 1280x720 Xvfb/Openbox demo display" >&2
  systemd-run --user --unit=chatgpt-demo-x0 --property=Restart=no \
    /usr/bin/Xvfb :0 -screen 0 1280x720x24 -ac -nolisten tcp >/dev/null
  for _ in $(seq 1 40); do
    DISPLAY=:0 xdpyinfo >/dev/null 2>&1 && break
    sleep 0.1
  done
  DISPLAY=:0 xdpyinfo >/dev/null 2>&1 || { echo "failed to start DISPLAY :0" >&2; exit 1; }
  if ! DISPLAY=:0 xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q WINDOW; then
    systemd-run --user --unit=chatgpt-demo-openbox-x0 --property=Environment=DISPLAY=:0 \
      /usr/bin/openbox >/dev/null
    sleep 0.5
  fi
fi

export DISPLAY_TARGET SEARCH_QUERY RAW META FRAME_RATE MCP_URL PROFILE_DIR LIVE_MCP_DIR

cd "$LIVE_MCP_DIR"
node --input-type=module <<'NODE'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const display = process.env.DISPLAY_TARGET;
const query = process.env.SEARCH_QUERY;
const raw = process.env.RAW;
const metaPath = process.env.META;
const frameRate = Number(process.env.FRAME_RATE || '20');
const profile = process.env.PROFILE_DIR;
const mcpUrl = process.env.MCP_URL;

const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
const client = new Client(
  { name: 'record-startpage-demo', version: '1.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
};
const currentTitle = () => {
  try {
    return execFileSync('sh', ['-lc',
      `DISPLAY=${JSON.stringify(display)} xdotool search --onlyvisible --class Firefox-esr 2>/dev/null | tail -1 | xargs -r -I{} sh -c 'DISPLAY=${display} xdotool getwindowname {}'`,
    ], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

await client.connect(transport);
let recording;
let app;
try {
  recording = await call('screen.record.start', { display, path: raw, frameRate });
  app = await call('app.launch', {
    name: 'firefox',
    display,
    args: ['--no-remote', '--profile', profile, 'about:blank'],
  });

  for (let i = 0; i < 30; i++) {
    await sleep(150);
    if (/firefox/i.test(currentTitle())) break;
  }
  await sleep(500);

  await call('input.key', { display, key: 'ctrl+l' });
  await call('input.type', { display, text: 'www.startpage.com', delayMs: 45 });
  await call('input.key', { display, key: 'Return' });

  let homeTitle = '';
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    homeTitle = currentTitle();
    if (/Startpage - Private Search Engine/i.test(homeTitle)) break;
  }
  if (!/Startpage/i.test(homeTitle)) {
    throw new Error(`Startpage home did not load: ${homeTitle}`);
  }
  await sleep(700);

  // Coordinates verified against Startpage's 1280x720 layout.
  await call('input.click', { display, button: 'left', x: 600, y: 330 });
  await call('input.type', { display, text: query, delayMs: 55 });
  await sleep(350);
  await call('input.click', { display, button: 'left', x: 921, y: 330 });

  let resultTitle = '';
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    resultTitle = currentTitle();
    if (/Search Results/i.test(resultTitle)) break;
  }
  if (!/Search Results/i.test(resultTitle)) {
    throw new Error(`Startpage results did not appear: ${resultTitle}`);
  }

  const resultsVisibleAt = Date.now();
  await sleep(2000);
  const stopped = await call('screen.record.stop', { handle: recording.handle });
  const stoppedAt = Date.now();

  await call('app.close', { handle: app.handle });
  app = undefined;

  await writeFile(metaPath, JSON.stringify({
    display,
    query,
    homeTitle,
    resultTitle,
    resultsVisibleForMs: stoppedAt - resultsVisibleAt,
    recording: stopped,
  }, null, 2) + '\n');
} catch (error) {
  if (recording?.handle) {
    try { await call('screen.record.stop', { handle: recording.handle }); } catch {}
  }
  throw error;
} finally {
  if (app?.handle) {
    try { await call('app.close', { handle: app.handle }); } catch {}
  }
  await client.close().catch(() => {});
}
NODE

# 50% playback speed = 2x timestamps. Keep a speed-oriented H.264 encode
# with medium demo quality and readable UI text.
ffmpeg -hide_banner -loglevel error -y \
  -i "$RAW" \
  -an \
  -vf 'setpts=2.0*PTS' \
  -r "$FRAME_RATE" \
  -fps_mode cfr \
  -c:v libx264 \
  -preset "$PRESET" \
  -crf "$CRF" \
  -pix_fmt yuv420p \
  -movflags +faststart \
  "$OUTPUT"

RAW_DURATION="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$RAW")"
FINAL_DURATION="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUTPUT")"

python3 - "$RAW_DURATION" "$FINAL_DURATION" <<'PY'
import sys
raw = float(sys.argv[1])
final = float(sys.argv[2])
ratio = final / raw if raw else 0
if not (1.90 <= ratio <= 2.10):
    raise SystemExit(f'50% speed verification failed: raw={raw:.3f}s final={final:.3f}s ratio={ratio:.3f}')
print(f'50% speed verified: raw={raw:.3f}s final={final:.3f}s')
PY

ffprobe -v error \
  -show_entries format=duration,size,bit_rate \
  -show_entries stream=codec_name,width,height,r_frame_rate \
  -of json "$OUTPUT"

if [[ "$PROFILE_DIR_IS_TEMP" == 1 ]]; then rm -rf "$PROFILE_DIR"; fi

echo "$OUTPUT"
