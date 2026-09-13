#!/usr/bin/env python3
"""One locked recovery owner. No permission changes, config restores or command replay."""
import argparse
import fcntl
import hashlib
import json
import math
import os
import pathlib
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid

RESTARTABLE = {"BACKEND_UNAVAILABLE", "TUNNEL_UNAVAILABLE", "TUNNEL_STALE", "METRICS_UNAVAILABLE"}
DEFAULT_POLICY = {"confirmations": 2, "startupGraceSeconds": 90, "stalePollSeconds": 90,
                  "stableSeconds": 120, "cooldownSeconds": 60, "maxRestartsPerHour": 3}


def atomic_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as out:
            json.dump(value, out, sort_keys=True)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def decision(previous, status, now, policy=None):
    """Pure state transition. Restart budgets survive transient success and daemon restarts."""
    policy = {**DEFAULT_POLICY, **(policy or {})}
    state = dict(previous)
    state["status"] = status
    state["observedAt"] = now
    restarts = [t for t in state.get("restarts", []) if 0 <= now - t < 3600]
    state["restarts"] = restarts
    action = "none"
    if status == "HEALTHY":
        state["failureStreak"] = 0
        state.setdefault("healthySince", now)
        if now - state["healthySince"] >= policy["stableSeconds"]:
            state["phase"] = "healthy"
            if state.get("incidentOpen"):
                state["incidentOpen"] = False
                action = "resolved"
        else:
            state["phase"] = "verifying"
        return state, action
    state.pop("healthySince", None)
    if status in {"OVERLOADED", "STARTING", "DEPENDENCY_UNAVAILABLE"}:
        state["phase"] = "degraded"
        state["failureStreak"] = 0
        return state, action
    state["failureStreak"] = state.get("failureStreak", 0) + 1
    state["phase"] = "suspect"
    if state["failureStreak"] < policy["confirmations"]:
        return state, action
    if not state.get("incidentOpen"):
        state["incidentOpen"] = True
        state["incidentId"] = uuid.uuid4().hex
        state["incidentStartedAt"] = now
        action = "incident"
    if status not in RESTARTABLE:
        state["phase"] = "requires_attention"
        return state, action
    if len(restarts) >= policy["maxRestartsPerHour"]:
        state["phase"] = "circuit_open"
        return state, action
    cooldown = min(900, policy["cooldownSeconds"] * 2 ** max(0, len(restarts) - 1))
    if restarts and now - restarts[-1] < cooldown:
        state["phase"] = "cooldown"
        return state, action
    state["restarts"] = restarts + [now]
    state["failureStreak"] = 0
    state["phase"] = "recovering"
    return state, "restart"


def metric_value(text, name):
    values = []
    for line in text.splitlines():
        match = re.fullmatch(re.escape(name) + r'(?:\{[^\n]*\})?\s+([-+0-9.eE]+)(?:\s+\d+)?\s*', line)
        if match:
            value = float(match.group(1))
            if math.isfinite(value):
                values.append(value)
    return max(values) if values else None


def poll_status(text, now, uptime, policy=None):
    policy = {**DEFAULT_POLICY, **(policy or {})}
    stamp = metric_value(text, "commands_poll_last_successful_timestamp_seconds")
    if uptime < policy["startupGraceSeconds"] and (stamp is None or stamp <= 0):
        return "STARTING", None
    if stamp is not None and stamp > now + 5:
        return "CLOCK_SKEW", None
    if stamp is None or stamp <= 0:
        return "METRICS_UNAVAILABLE", None
    age = max(0, now - stamp)
    return ("TUNNEL_STALE" if age > policy["stalePollSeconds"] else "HEALTHY"), age


def request(url, body=None, token=None):
    headers = {"Accept": "application/json, text/event-stream"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=3) as response:
        # Health checks never need multi-megabyte payloads.
        data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError("probe response too large")
        return data.decode()


def rpc(url, method, params=None, token=None):
    body = {"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method}
    if params is not None:
        body["params"] = params
    text = request(url, body, token)
    if text.startswith(("event:", "data:")):
        text = next(line[5:].strip() for line in text.splitlines() if line.startswith("data:"))
    result = json.loads(text)
    if "error" in result:
        raise ValueError("MCP protocol error")
    return result["result"]


def error_status(result):
    if not result.get("isError"):
        return None
    for item in result.get("content", []):
        try:
            code = json.loads(item.get("text", ""))["error"]["code"]
            if code == "OVERLOADED":
                return "OVERLOADED"
            if code in {"CAPABILITY_DISABLED", "PATH_NOT_ALLOWED", "COMMAND_NOT_ALLOWED"}:
                return "POLICY_MISMATCH"
            return "EXECUTION_FAILURE"
        except (ValueError, KeyError, TypeError):
            pass
    return "EXECUTION_FAILURE"


def backend_probe(settings, canary=False):
    base = settings["backendUrl"].rstrip("/")
    config = json.loads(pathlib.Path(settings["configPath"]).read_text())
    token = config.get("http", {}).get("token")
    endpoint = base + "/mcp"
    try:
        health = json.loads(request(base + "/healthz"))
        if not health.get("ok"):
            return "BACKEND_UNAVAILABLE", {}
        catalog = rpc(endpoint, "tools/list", token=token)
        names = {tool["name"] for tool in catalog["tools"]}
        result = rpc(endpoint, "tools/call", {"name": "system.info", "arguments": {}}, token)
        status = error_status(result)
        if status:
            return status, {}
        info = result.get("structuredContent", {})
        expected = settings.get("expectedCapabilities", {})
        for name, required in expected.items():
            if info.get("capabilities", {}).get(name) != required:
                return "POLICY_MISMATCH", {"capability": name}
        for name in settings.get("expectedTools", []):
            if name not in names:
                return "POLICY_MISMATCH", {"missingTool": name}
        evidence = {"catalogCount": len(names), "runtime": info.get("runtime", {})}
        if canary and settings.get("canaryDirectory") and config.get("filesystem", {}).get("write"):
            target = str(pathlib.Path(settings["canaryDirectory"]) / ("probe-" + uuid.uuid4().hex))
            payload = uuid.uuid4().hex
            created = False
            try:
                result = rpc(endpoint, "tools/call", {"name": "fs.write", "arguments": {"path": target, "content": payload, "mode": "create"}}, token)
                status = error_status(result)
                if status:
                    return status, evidence
                created = True
                if config.get("filesystem", {}).get("read"):
                    result = rpc(endpoint, "tools/call", {"name": "fs.read", "arguments": {"path": target}}, token)
                    status = error_status(result)
                    if status:
                        return status, evidence
                    if result.get("structuredContent", {}).get("content") != payload:
                        return "EXECUTION_FAILURE", evidence
                evidence["writeCanary"] = "passed"
            finally:
                # Only remove the uniquely named file created by this probe.
                if created:
                    result = rpc(endpoint, "tools/call", {"name": "fs.delete", "arguments": {"path": target}}, token)
                    if error_status(result):
                        evidence["cleanup"] = "failed"
            if evidence.get("cleanup") == "failed":
                return "EXECUTION_FAILURE", evidence
        return "HEALTHY", evidence
    except urllib.error.HTTPError as error:
        return ("AUTH_FAILURE" if error.code in (401, 403) else "BACKEND_UNAVAILABLE"), {"httpStatus": error.code}
    except (OSError, ValueError, KeyError, StopIteration, TypeError):
        return "BACKEND_UNAVAILABLE", {}


def service_uptime(unit):
    out = subprocess.run(["systemctl", "--user", "show", unit, "-p", "ActiveEnterTimestampMonotonic", "--value"], capture_output=True, text=True, timeout=5)
    try:
        stamp = int(out.stdout.strip()) / 1_000_000
        return max(0, time.monotonic() - stamp) if stamp else float("inf")
    except ValueError:
        return float("inf")


def tick(settings, dry_run=False):
    state_dir = pathlib.Path(settings["stateDirectory"])
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(state_dir / "recovery.lock", "a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "already_running"}
        # Deployment holds this same lock, so rollback and recovery cannot race.
        state_file = state_dir / "state.json"
        try:
            state = json.loads(state_file.read_text())
        except FileNotFoundError:
            state = {"components": {}}
        now = time.time()
        # Backwards wall-clock jumps invalidate timers, but never erase restart budgets.
        if state.get("lastTick", 0) > now + 5:
            return {"status": "CLOCK_SKEW", "action": "none"}
        canary = now - state.get("lastCanary", 0) >= settings.get("canaryIntervalSeconds", 120)
        try:
            backend, evidence = backend_probe(settings, canary=canary)
        except (OSError, ValueError):
            backend, evidence = "CONFIG_INVALID", {}
        if canary and backend == "HEALTHY":
            state["lastCanary"] = now
        samples = [("backend", settings.get("backendUnit", "chatgpt-mcp.service"), backend, evidence)]
        policy = {**DEFAULT_POLICY, **settings.get("policy", {})}
        for profile in settings.get("profiles", []):
            evidence = {}
            try:
                uptime = service_uptime(profile["unit"])
                text = request(profile["healthUrl"].rstrip("/") + "/metrics")
                status, age = poll_status(text, now, uptime, policy)
                evidence = {"pollAgeSeconds": age, "uptimeSeconds": uptime,
                            "workers": metric_value(text, "dispatcher_worker_pool_occupancy"),
                            "queued": metric_value(text, "commands_queue_length")}
            except (OSError, ValueError, subprocess.SubprocessError):
                status = "TUNNEL_UNAVAILABLE"
            if backend == "BACKEND_UNAVAILABLE":
                status = "DEPENDENCY_UNAVAILABLE"
            samples.append((profile["name"], profile["unit"], status, evidence))
        reports = []
        for name, unit, status, evidence in samples:
            previous = state["components"].get(name, {})
            component, action = decision(previous, status, now, policy)
            component["evidence"] = evidence
            state["components"][name] = component
            report = {"component": name, "status": status, "phase": component["phase"], "action": action}
            reports.append(report)
            if dry_run:
                continue
            # Persist the restart budget BEFORE an external action (crash-safe).
            atomic_json(state_file, state)
            if component.get("incidentId"):
                incident = {"id": component["incidentId"], "component": name, "unit": unit,
                            "startedAt": component["incidentStartedAt"], "updatedAt": now,
                            "open": component["incidentOpen"], "status": status, "phase": component["phase"],
                            "restarts": component["restarts"], "evidence": evidence}
                atomic_json(state_dir / "incidents" / (incident["id"] + ".json"), incident)
            if action == "restart":
                try:
                    subprocess.run(["systemctl", "--user", "reset-failed", unit], capture_output=True, timeout=5)
                    proc = subprocess.run(["systemctl", "--user", "restart", "--no-block", unit], capture_output=True, timeout=5)
                    component["restartAccepted"] = proc.returncode == 0
                except subprocess.SubprocessError:
                    component["restartAccepted"] = False
            if action != "none" or previous.get("phase") != component["phase"]:
                print(json.dumps(report, sort_keys=True), flush=True)
        if not dry_run:
            state["lastTick"] = now
            atomic_json(state_file, state)
            # Incidents contain no credentials or tool arguments. Keep the most recent 100.
            incidents = sorted((state_dir / "incidents").glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
            for old in incidents[100:]:
                old.unlink(missing_ok=True)
        return {"status": "observed", "components": reports}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    settings = json.loads(pathlib.Path(args.config).read_text())
    print(json.dumps(tick(settings, args.dry_run), sort_keys=True))


if __name__ == "__main__":
    main()
