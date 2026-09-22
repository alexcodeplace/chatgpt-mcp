#!/usr/bin/env python3
"""Install one shared recovery controller while preserving profile/configuration state."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
from recovery import atomic_json


def install(runtime, profile, health_url, home, enable=True):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", profile):
        raise ValueError("invalid profile name")
    config_path = runtime / "config.local.json"
    config = json.loads(config_path.read_text())
    settings_path = home / ".config/chatgpt-mcp/recovery.json"
    try:
        settings = json.loads(settings_path.read_text())
    except FileNotFoundError:
        settings = {"profiles": []}
    state = home / ".local/state/chatgpt-mcp/recovery"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings.update({"backendUrl": f"http://127.0.0.1:{config.get('http', {}).get('port', 3210)}",
                     "backendUnit": "chatgpt-mcp.service", "configPath": str(config_path),
                     "stateDirectory": str(state), "canaryIntervalSeconds": 120,
                     "expectedConfigSha256": hashlib.sha256(config_path.read_bytes()).hexdigest()})
    settings.pop("expectedRuntime", None)
    settings.pop("shellCanary", None)
    allowed_commands = config.get("shell", {}).get("allowedCommands", [])
    if config.get("shell", {}).get("enabled") and ("*" in allowed_commands or "node" in allowed_commands):
        settings["shellCanary"] = {"command": "node", "args": ["-e", "process.stdout.write('mcp-shell-canary')"],
                                  "expectedStdout": "mcp-shell-canary"}
    settings["expectedCapabilities"] = {"filesystemWrite": config.get("filesystem", {}).get("write", False),
                                         "shell": config.get("shell", {}).get("enabled", False)}
    settings["expectedTools"] = ["system.info"]
    settings.pop("canaryDirectory", None)
    roots = config.get("filesystem", {}).get("roots", [])
    if settings["expectedCapabilities"]["filesystemWrite"] and roots:
        settings["expectedTools"].append("fs.write")
        canary = state / "canary"
        if any(canary.resolve().is_relative_to(pathlib.Path(root).resolve()) for root in roots):
            canary.mkdir(mode=0o700, exist_ok=True)
            settings["canaryDirectory"] = str(canary)
    else:
        settings.pop("canaryDirectory", None)
    if settings["expectedCapabilities"]["shell"]:
        settings["expectedTools"].append("shell.exec")
    settings["profiles"] = [p for p in settings["profiles"] if p["name"] != profile]
    settings["profiles"].append({"name": profile, "unit": f"chatgpt-mcp-tunnel-{profile}.service", "healthUrl": health_url.rstrip("/")})
    atomic_json(settings_path, settings)
    library = home / ".local/lib/chatgpt-mcp"
    library.mkdir(parents=True, exist_ok=True)
    temporary = library / "recovery.py.new"
    shutil.copyfile(pathlib.Path(__file__).with_name("recovery.py"), temporary)
    temporary.chmod(0o700)
    os.replace(temporary, library / "recovery.py")
    units = home / ".config/systemd/user"
    units.mkdir(parents=True, exist_ok=True)
    (units / "chatgpt-mcp-recovery.service").write_text(f'''[Unit]
Description=Coordinated MCP backend and tunnel recovery
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 "{library}/recovery.py" --config "{settings_path}"
TimeoutStartSec=90
UMask=0077
''')
    (units / "chatgpt-mcp-recovery.timer").write_text('''[Unit]
Description=Observe MCP control-plane progress and execution capabilities
[Timer]
OnBootSec=90s
OnUnitInactiveSec=30s
AccuracySec=1s
RandomizedDelaySec=3s
Unit=chatgpt-mcp-recovery.service
[Install]
WantedBy=timers.target
''')
    if enable:
        # All registered profiles share the backend. Retire competing legacy owners.
        for existing in settings["profiles"]:
            subprocess.run(["systemctl", "--user", "disable", "--now", f"chatgpt-mcp-watchdog-{existing['name']}.timer"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", "chatgpt-mcp-recovery.timer"], check=True)
    return settings_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True, type=pathlib.Path)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--health-url", required=True)
    parser.add_argument("--home", type=pathlib.Path, default=pathlib.Path.home())
    parser.add_argument("--no-enable", action="store_true")
    args = parser.parse_args()
    print(install(args.runtime.resolve(), args.profile, args.health_url, args.home.resolve(), not args.no_enable))
