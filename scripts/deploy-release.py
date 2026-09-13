#!/usr/bin/env python3
"""Blue/green local rollout. Keep the previous backend and its children alive."""
import argparse
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid
sys.dont_write_bytecode = True
from recovery import atomic_json, backend_probe, metric_value, request
from release import verify
from canary import validate


def run(*args, check=True, timeout=20):
    return subprocess.run(list(args), check=check, capture_output=True, text=True, timeout=timeout)


def systemctl(*args, **kwargs):
    return run('systemctl', '--user', *args, **kwargs)


def atomic_text(path, text, mode=0o600):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode), 'w') as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def backup(plan, path):
    path = pathlib.Path(path)
    if any(item['path'] == str(path) for item in plan['files']):
        return
    saved = pathlib.Path(plan['directory']) / ('backup-' + str(len(plan['files'])))
    if path.exists():
        shutil.copyfile(path, saved)
        saved.chmod(0o600)
        value = str(saved)
    else:
        value = None
    plan['files'].append({'path': str(path), 'backup': value})
    atomic_json(pathlib.Path(plan['directory']) / 'plan.json', plan)


def rollback(plan_path):
    plan = json.loads(pathlib.Path(plan_path).read_text())
    if plan.get('committed') or plan.get('rolledBack'):
        return
    lock_path = pathlib.Path(plan['lockPath'])
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        plan = json.loads(pathlib.Path(plan_path).read_text())
        if plan.get('committed') or plan.get('rolledBack'):
            return
        for item in reversed(plan['files']):
            target = pathlib.Path(item['path'])
            if item['backup'] is None:
                target.unlink(missing_ok=True)
            else:
                atomic_text(target, pathlib.Path(item['backup']).read_text())
        systemctl('daemon-reload')
        for profile in plan.get('touchedProfiles', []):
            systemctl('restart', f'chatgpt-mcp-tunnel-{profile}.service', check=False)
        for timer in plan.get('enabledLegacyTimers', []):
            systemctl('enable', '--now', timer, check=False)
        if plan.get('previousBackendWasEnabled'):
            systemctl('enable', plan['previousBackendUnit'], check=False)
        if plan.get('recoveryWasEnabled'):
            systemctl('enable', '--now', 'chatgpt-mcp-recovery.timer', check=False)
        else:
            systemctl('disable', '--now', 'chatgpt-mcp-recovery.timer', check=False)
        # Do not terminate commands that may have reached the new backend either.
        systemctl('disable', plan['backendUnit'], check=False)
        plan['rolledBack'] = True
        atomic_json(plan_path, plan)
        print(json.dumps({'status': 'rolled_back', 'plan': str(plan_path)}), flush=True)


def free_port():
    for port in range(3211, 3300):
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
                return port
            except OSError:
                pass
    raise RuntimeError('no unused candidate backend port')


def wait_idle(url, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        text = request(url + '/metrics')
        if metric_value(text, 'dispatcher_worker_pool_occupancy') == 0 and metric_value(text, 'commands_queue_length') == 0:
            return
        time.sleep(0.5)
    raise RuntimeError('tunnel did not drain; leaving rollback to restore the previous route')


def wait_poll(url):
    deadline = time.monotonic() + 70
    while time.monotonic() < deadline:
        try:
            stamp = metric_value(request(url + '/metrics'), 'commands_poll_last_successful_timestamp_seconds')
            if stamp and -5 <= time.time() - stamp < 60 and request(url + '/readyz').strip() == 'ready':
                return time.time() - stamp
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise RuntimeError('new tunnel did not demonstrate fresh control-plane polling')


def working_directory(config_path, previous_unit, explicit=None):
    if explicit is not None:
        path = pathlib.Path(explicit).resolve()
    else:
        result = systemctl('show', previous_unit, '-p', 'WorkingDirectory', '--value', check=False)
        value = result.stdout.strip() if result.returncode == 0 else ''
        path = pathlib.Path(value).resolve() if value else config_path.resolve().parent
    if not path.is_dir() or any(character in str(path) for character in '\r\n'):
        raise ValueError('backend working directory must be an existing directory')
    return path


def backend_unit_text(revision, release, cwd, config_path, node):
    # WorkingDirectory takes a path, not an ExecStart-style quoted argument.
    # Literal quotes make an absolute path invalid to systemd's path parser.
    return f'''[Unit]
Description=Identified MCP runtime {revision}
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=3
[Service]
Type=simple
WorkingDirectory={str(cwd).replace('%', '%%')}
Environment=CHATGPT_MCP_CONFIG={config_path}
Environment=CHATGPT_MCP_RELEASE={revision}
Environment=CHATGPT_MCP_TRACE=1
Environment=PYTHONDONTWRITEBYTECODE=1
UnsetEnvironment=DISPLAY WAYLAND_DISPLAY MIR_SOCKET
ExecStartPre=/usr/bin/python3 "{release}/scripts/release.py" verify "{release}"
ExecStart="{node}" "{release}/dist/src/http.js"
Restart=on-failure
RestartSec=10
TimeoutStopSec=5
KillMode=control-group
TasksMax=512
LimitNOFILE=65536
MemoryHigh=6G
MemoryMax=9G
CPUWeight=80
UMask=0077
LogRateLimitIntervalSec=30s
LogRateLimitBurst=1000
[Install]
WantedBy=default.target
'''


def staging_config(config, directory):
    """Candidate fault tests must never submit or expire jobs in the live ledger."""
    candidate = copy.deepcopy(config)
    if candidate.get('jobs', {}).get('enabled'):
        candidate['jobs']['directory'] = str(directory / 'canary-jobs')
    return candidate


def wait_backend(settings, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status, evidence = backend_probe(settings, canary=True)
            if status == 'HEALTHY':
                return evidence
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise RuntimeError('candidate failed final loaded-configuration and execution verification')


def deploy(args):
    home = pathlib.Path.home()
    release = args.release.resolve()
    manifest = verify(release)
    revision = manifest['revision']
    profiles = []
    for value in args.profile:
        name, separator, key = value.partition('=')
        if not separator or not re.fullmatch(r'[A-Za-z0-9_.-]+', name):
            raise ValueError('--profile requires NAME=/absolute/runtime-key-file')
        key_path = pathlib.Path(key).expanduser().resolve()
        if not key_path.is_file() or not key_path.read_text().strip():
            raise ValueError('runtime key file is missing or empty')
        profile_path = home / '.config/tunnel-client' / (name + '.yaml')
        text = profile_path.read_text()
        health = re.search(r'^\s*listen_addr:\s*[\"\']?(127\.0\.0\.1:[0-9]+)', text, re.M)
        if not health:
            raise ValueError('profile must expose an explicit loopback health port')
        profiles.append({'name': name, 'key': str(key_path), 'path': str(profile_path), 'healthUrl': 'http://' + health.group(1), 'original': text})
    state = home / '.local/state/chatgpt-mcp'
    directory = state / 'deployments' / (revision[:12] + '-' + uuid.uuid4().hex[:8])
    directory.mkdir(parents=True, mode=0o700)
    lock_path = state / 'recovery/recovery.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    recovery_config = home / '.config/chatgpt-mcp/recovery.json'
    previous_unit = 'chatgpt-mcp.service'
    if recovery_config.exists():
        previous_unit = json.loads(recovery_config.read_text()).get('backendUnit', previous_unit)
    config = json.loads(args.config.read_text())
    cwd = working_directory(args.config, previous_unit, getattr(args, 'working_directory', None))
    port = free_port()
    config.setdefault('http', {})['host'] = '127.0.0.1'
    config['http']['port'] = port
    if args.enable_jobs:
        jobs = config.setdefault('jobs', {})
        jobs.update({'enabled': True, 'launcher': 'systemd'})
        jobs.setdefault('directory', str(state / 'jobs'))
        jobs.setdefault('maxConcurrent', 2)
    config_path = directory / 'config.local.json'
    candidate = staging_config(config, directory)
    atomic_json(config_path, candidate)
    unit = f'chatgpt-mcp-runtime-{revision[:12]}.service'
    units = home / '.config/systemd/user'
    unit_path = units / unit
    if unit_path.exists():
        raise ValueError('this release already has a runtime unit; inspect active.json instead of redeploying it')
    node = args.node.resolve()
    if not node.is_file():
        raise ValueError('Node runtime executable is missing')
    settings = {'backendUrl': f'http://127.0.0.1:{port}', 'backendUnit': unit, 'configPath': str(config_path), 'workingDirectory': str(cwd),
                'canaryDirectory': str(args.canary_directory.resolve() if args.canary_directory else directory / 'canary'),
                'expectedTools': ['system.info'], 'expectedCapabilities': {'filesystemWrite': config.get('filesystem', {}).get('write', False), 'shell': config.get('shell', {}).get('enabled', False)}}
    if config.get('shell', {}).get('enabled') and any(command in config['shell'].get('allowedCommands', []) for command in ['*', 'node']):
        settings['shellCanary'] = {'command': 'node', 'args': ['-e', "process.stdout.write('mcp-shell-canary')"], 'expectedStdout': 'mcp-shell-canary'}
    atomic_json(directory / 'candidate-settings.json', settings)
    unit_text = backend_unit_text(revision, release, cwd, config_path, node)
    atomic_text(unit_path, unit_text, 0o644)
    try:
        run('systemd-analyze', '--user', 'verify', str(unit_path))
        systemctl('daemon-reload')
        systemctl('enable', '--now', unit)
        results = validate(settings, unit)
        results['stagingJobLedgerIsolated'] = candidate.get('jobs', {}).get('directory') != config.get('jobs', {}).get('directory') if config.get('jobs', {}).get('enabled') else 'not enabled'
        # All destructive/restart canaries have finished. Load the production
        # ledger only now, without issuing any candidate job submissions to it.
        if candidate != config:
            atomic_json(config_path, config)
            systemctl('restart', unit)
        results['finalBackend'] = wait_backend(settings)
        atomic_json(directory / 'canary-results.json', results)
    except Exception:
        systemctl('disable', '--now', unit, check=False)
        raise
    library = home / '.local/lib/chatgpt-mcp'
    library.mkdir(parents=True, exist_ok=True)
    tunnel = pathlib.Path(run('python3', str(release / 'scripts/install-tunnel.py'), timeout=100).stdout.strip())
    launcher = library / ('run-tunnel-' + revision[:12] + '.sh')
    atomic_text(launcher, '''#!/usr/bin/env bash
set -Eeuo pipefail
: "${TUNNEL_CLIENT_BIN:?}" "${TUNNEL_API_KEY_FILE:?}" "${CHATGPT_MCP_PROFILE:?}"
version="$("$TUNNEL_CLIENT_BIN" --version)"
[[ "$version" == 0.0.14+* || "$version" == 0.0.14\\ * || "$version" == 0.0.14 ]] || { echo TUNNEL_VERSION_MISMATCH >&2; exit 78; }
export CONTROL_PLANE_API_KEY="$(head -n1 "$TUNNEL_API_KEY_FILE" | tr -d '\\r\\n')"
exec "$TUNNEL_CLIENT_BIN" run --profile "$CHATGPT_MCP_PROFILE"
''', 0o700)
    plan = {'directory': str(directory), 'lockPath': str(lock_path), 'backendUnit': unit, 'revision': revision, 'files': [], 'touchedProfiles': [], 'enabledLegacyTimers': [],
            'previousBackendUnit': previous_unit, 'previousBackendWasEnabled': systemctl('is-enabled', previous_unit, check=False).returncode == 0,
            'recoveryWasEnabled': systemctl('is-enabled', 'chatgpt-mcp-recovery.timer', check=False).returncode == 0}
    plan_path = directory / 'plan.json'
    atomic_json(plan_path, plan)
    guard = 'chatgpt-mcp-rollback-' + revision[:12]
    # A separate systemd timer survives loss of this tool call or deployment process.
    run('systemd-run', '--user', '--unit=' + guard, '--on-active=360s', '/usr/bin/python3', str(release / 'scripts/deploy-release.py'), 'rollback', '--plan', str(plan_path))
    try:
        def deadline(_signum, _frame):
            raise TimeoutError('rollout deadline reached')
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(300)
        with open(lock_path, 'a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            for profile in profiles:
                timer = f"chatgpt-mcp-watchdog-{profile['name']}.timer"
                if systemctl('is-enabled', timer, check=False).returncode == 0:
                    plan['enabledLegacyTimers'].append(timer)
                atomic_json(plan_path, plan)
                systemctl('disable', '--now', timer, check=False)
                systemctl('stop', f"chatgpt-mcp-watchdog-{profile['name']}.service", check=False)
            for profile in profiles:
                name = profile['name']
                wait_idle(profile['healthUrl'])
                path = pathlib.Path(profile['path'])
                if path.read_text() != profile['original']:
                    raise RuntimeError('profile changed during staging; refusing to overwrite it')
                changed, count = re.subn(r'(?m)^(\s*url:\s*[\"\']?)http://(?:127\.0\.0\.1|localhost):[0-9]+/mcp([\"\']?\s*)$', r'\g<1>http://127.0.0.1:' + str(port) + r'/mcp\2', profile['original'])
                if count != 1:
                    raise ValueError('expected exactly one loopback MCP URL in the profile')
                backup(plan, path)
                base_unit = units / f'chatgpt-mcp-tunnel-{name}.service'
                backup(plan, base_unit)
                base = base_unit.read_text()
                rewritten = []
                for line in base.splitlines():
                    if line.startswith(('Wants=', 'Requires=', 'After=')):
                        key, value = line.split('=', 1)
                        line = key + '=' + ' '.join(unit if item == previous_unit else item for item in value.split())
                    rewritten.append(line)
                dropin = units / f'chatgpt-mcp-tunnel-{name}.service.d/60-reliability.conf'
                backup(plan, dropin)
                plan['touchedProfiles'].append(name)
                atomic_json(plan_path, plan)
                atomic_text(path, changed)
                atomic_text(base_unit, '\n'.join(rewritten) + '\n', 0o644)
                atomic_text(dropin, f'''[Unit]
Wants={unit}
After={unit}
StartLimitIntervalSec=300
StartLimitBurst=3
[Service]
Environment=TUNNEL_CLIENT_BIN={tunnel}
Environment=TUNNEL_API_KEY_FILE={profile['key']}
Environment=CHATGPT_MCP_PROFILE={name}
Environment=TUNNEL_CLIENT_PROFILE_DIR={home}/.config/tunnel-client
ExecStart=
ExecStart={launcher}
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=78
TimeoutStopSec=10
''', 0o644)
                systemctl('daemon-reload')
                systemctl('reset-failed', f'chatgpt-mcp-tunnel-{name}.service', check=False)
                systemctl('restart', f'chatgpt-mcp-tunnel-{name}.service')
                age = wait_poll(profile['healthUrl'])
                print(json.dumps({'profile': name, 'pollAgeSeconds': age, 'status': 'fresh_poll_after_upgrade'}), flush=True)
            for target in [recovery_config, library / 'recovery.py', units / 'chatgpt-mcp-recovery.service', units / 'chatgpt-mcp-recovery.timer', home / '.config/chatgpt-mcp/active.json']:
                backup(plan, target)
            for profile in profiles:
                run('python3', str(release / 'scripts/install-recovery.py'), '--runtime', str(directory), '--profile', profile['name'], '--health-url', profile['healthUrl'], '--no-enable')
            recovery_settings = json.loads(recovery_config.read_text())
            recovery_settings['backendUnit'] = unit
            recovery_settings['canaryDirectory'] = settings['canaryDirectory']
            recovery_settings['expectedRuntime'] = {key: results['finalBackend']['runtime'][key] for key in ('release', 'configFingerprint')}
            if config.get('jobs', {}).get('enabled') and config.get('shell', {}).get('enabled'):
                recovery_settings['expectedTools'] += ['exec.start', 'exec.status', 'exec.output', 'exec.cancel']
            atomic_json(recovery_config, recovery_settings)
            status, evidence = backend_probe(recovery_settings, canary=True)
            if status != 'HEALTHY':
                raise RuntimeError('final capability canary failed: ' + status)
            active = {**settings, 'releaseDirectory': str(release), 'revision': revision, 'previousBackendUnit': previous_unit, 'deploymentDirectory': str(directory), 'profiles': [{k: p[k] for k in ['name', 'healthUrl']} for p in profiles]}
            atomic_json(home / '.config/chatgpt-mcp/active.json', active)
            systemctl('daemon-reload')
            systemctl('enable', '--now', 'chatgpt-mcp-recovery.timer')
            systemctl('disable', previous_unit, check=False)  # deliberately NOT --now
            plan['committed'] = True
            plan['finalEvidence'] = evidence
            atomic_json(plan_path, plan)
        signal.alarm(0)
        systemctl('stop', guard + '.timer', check=False)
        print(json.dumps({'status': 'committed', 'revision': revision, 'backendUnit': unit, 'backendUrl': settings['backendUrl'], 'plan': str(plan_path), 'previousBackendLeftRunning': previous_unit}), flush=True)
    except BaseException:
        signal.alarm(0)
        rollback(plan_path)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    item = sub.add_parser('deploy')
    item.add_argument('--release', required=True, type=pathlib.Path)
    item.add_argument('--config', required=True, type=pathlib.Path)
    item.add_argument('--node', type=pathlib.Path, default=pathlib.Path(shutil.which('node') or '/usr/bin/node'))
    item.add_argument('--profile', action='append', required=True, help='NAME=/absolute/runtime-key-file')
    item.add_argument('--enable-jobs', action='store_true')
    item.add_argument('--canary-directory', type=pathlib.Path)
    item.add_argument('--working-directory', type=pathlib.Path, help='Defaults to the current backend working directory, not its configuration directory')
    item = sub.add_parser('rollback')
    item.add_argument('--plan', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.action == 'rollback':
        rollback(args.plan)
    else:
        deploy(args)
