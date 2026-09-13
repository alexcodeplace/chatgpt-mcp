#!/usr/bin/env python3
"""Read-only operator status: capability proof, polling age, recovery budgets, release identity."""
import argparse
import json
import pathlib
import subprocess
import sys
import time
sys.dont_write_bytecode = True
from recovery import backend_probe, metric_value, request


def status(settings_path):
    settings = json.loads(settings_path.read_text())
    backend, evidence = backend_probe(settings)
    report = {"backend": {"status": backend, "unit": settings.get("backendUnit"), **evidence}, "profiles": []}
    for profile in settings.get("profiles", []):
        current = {"name": profile["name"], "unit": profile["unit"]}
        try:
            metrics = request(profile["healthUrl"].rstrip("/") + "/metrics")
            stamp = metric_value(metrics, "commands_poll_last_successful_timestamp_seconds")
            age = None if stamp is None else round(time.time() - stamp, 2)
            current.update({"pollAgeSeconds": age, "workers": metric_value(metrics, "dispatcher_worker_pool_occupancy"),
                            "queued": metric_value(metrics, "commands_queue_length"),
                            "status": "HEALTHY" if age is not None and -5 <= age <= settings.get("policy", {}).get("stalePollSeconds", 90) else "POLL_NOT_FRESH"})
        except (OSError, ValueError):
            current["status"] = "TUNNEL_UNAVAILABLE"
        try:
            unit = subprocess.run(["systemctl", "--user", "show", profile["unit"], "-p", "MainPID", "-p", "NRestarts", "-p", "ActiveState"], capture_output=True, text=True, timeout=5)
            current["service"] = dict(line.split("=", 1) for line in unit.stdout.splitlines() if "=" in line)
        except subprocess.SubprocessError:
            current["service"] = {"status": "UNAVAILABLE"}
        report["profiles"].append(current)
    try:
        state = json.loads((pathlib.Path(settings["stateDirectory"]) / "state.json").read_text())
        report["recovery"] = {name: {key: value for key, value in component.items() if key in ["phase", "status", "observedAt", "restarts", "incidentOpen", "incidentId"]} for name, component in state.get("components", {}).items()}
    except FileNotFoundError:
        report["recovery"] = {"status": "not_yet_observed"}
    report["scope"] = "Local backend and control-plane polling verified independently. Client-visible delivery must be confirmed from the ChatGPT connector."
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=pathlib.Path, default=pathlib.Path.home() / ".config/chatgpt-mcp/recovery.json")
    args = parser.parse_args()
    try:
        print(json.dumps(status(args.settings), indent=2))
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"status": "DIAGNOSTICS_UNAVAILABLE", "exceptionType": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
