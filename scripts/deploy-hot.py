#!/usr/bin/env python3
"""Overdeck-managed backend replacement without changing the tunnel or its listener.

The routing CAS, not active.json, is the commit point. Uncertain and interrupted
attempts retain every published generation and are reconciled from the router.
Only an explicitly private, unpublished candidate may be restarted or removed.
"""
import argparse
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
from hot_control import (ControlError, atomic_json, backend, control, executable_identity,
                         load_state, private_file, publish_selection, read_json, select, state_path, status)
from recovery import backend_probe, rpc
from release import verify
from canary import validate

_spec = importlib.util.spec_from_file_location('mcp_existing_stager', Path(__file__).with_name('deploy-release.py'))
stager = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(stager)


def unit_state(name):
    stager.validate_service_name(name)
    result = stager.systemctl('show', name, '-p', 'MainPID', '-p', 'ActiveState', '-p', 'FragmentPath', '-p', 'DropInPaths', check=False)
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)


def quote(value):
    value = str(value)
    if any(c in value for c in '\r\n\0'):
        raise ValueError('unsafe systemd argument')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def write_unit(path, text):
    path = Path(path)
    if path.exists() and path.read_text() == text:
        return False
    stager.atomic_text(path, text, 0o644)
    stager.run('systemd-analyze', '--user', 'verify', str(path if path.name.endswith('.service') else path.parent.parent / path.parent.name[:-2]))
    return True


def profiles_snapshot(home, profiles, ingress_url):
    observations = []
    for profile in profiles:
        unit = unit_state(profile['unit'])
        pid = int(unit.get('MainPID', '0'))
        if unit.get('ActiveState') != 'active' or not pid:
            raise ControlError('EXISTING_TUNNEL_NOT_RUNNING')
        path = home / '.config/tunnel-client' / (profile['name'] + '.yaml')
        data = path.read_bytes()
        if data.count((ingress_url + '/mcp').encode()) != 1:
            raise ControlError('TUNNEL_INGRESS_CONFIGURATION_CHANGED')
        files = [unit['FragmentPath'], *unit.get('DropInPaths', '').split()]
        version = stager.run(str(Path('/proc', str(pid), 'exe')), '--version').stdout.strip()
        if not version.startswith('0.0.14+'):
            raise ControlError('UNSUPPORTED_TUNNEL_VERSION')
        observations.append({'name': profile['name'], 'unit': profile['unit'], 'pid': pid,
                             'profileSha256': hashlib.sha256(data).hexdigest(),
                             'unitSha256': {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in files}})
    return observations


def wait_control(router, timeout=35):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            return control(router['controlSocket'])
        except (ControlError, OSError):
            time.sleep(0.1)
    raise ControlError('ROUTER_DID_NOT_START')


def _route_identity(status):
    return {
        'schema': status.get('schema'),
        'epoch': status.get('epoch'),
        'active': status.get('active'),
        'previous': status.get('previous'),
        'legacyOwner': status.get('legacyOwner'),
        'generations': [_generation_descriptor(item) for item in status.get('generations', [])],
    }


def _router_command(pid):
    return Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\0')


def _deleted_expected_executable(pid, expected):
    try:
        raw = os.readlink(Path('/proc', str(pid), 'exe'))
    except OSError:
        return False
    return raw == str(Path(expected).resolve()) + ' (deleted)'


def _reconcile_deleted_router_executable(home, state, snapshot):
    router = state['router']
    pid = snapshot.get('routerPid')
    if not isinstance(pid, int) or pid <= 0 or not _deleted_expected_executable(pid, router['node']):
        raise ControlError('ROUTER_PROCESS_PROVENANCE_MISMATCH')
    command = _router_command(pid)
    entry = str(Path(router['releaseDirectory']) / 'dist/src/hotswap/main.js').encode()
    if entry not in command:
        raise ControlError('ROUTER_PROCESS_PROVENANCE_MISMATCH')

    expected = _route_identity(snapshot)
    tunnel_owners = []
    ingress_owner = None
    try:
        for profile in state.get('profiles', []):
            tunnel_owners.append(_pause_unit(profile['unit']))
        drained = _wait_router_idle(state)
        if _route_identity(drained) != expected:
            raise ControlError('ROUTER_RECONCILE_ROUTE_CHANGED')
        ingress_owner = _pause_unit(state['ingress']['unit'])
        drained = _wait_router_idle(state)
        if _route_identity(drained) != expected:
            raise ControlError('ROUTER_RECONCILE_ROUTE_CHANGED')
        stager.systemctl('restart', router['unit'])
        current = wait_control(router)
        if _route_identity(current) != expected:
            raise ControlError('ROUTER_RECONCILE_ROUTE_CHANGED')
        return current
    finally:
        if ingress_owner is not None:
            _resume_unit(ingress_owner)
        for item in tunnel_owners:
            _resume_unit(item)


def ensure_router(home, state):
    router = state['router']
    unit = home / '.config/systemd/user' / router['unit']
    release = Path(router['releaseDirectory'])
    # A backend release never changes the running router implementation or key.
    text = f'''[Unit]
Description=Persistent MCP generation router
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=3
[Service]
Type=simple
WorkingDirectory={str(home).replace('%', '%%')}
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStartPre=/usr/bin/python3 {quote(release / 'scripts/release.py')} verify {quote(release)}
ExecStart=/usr/bin/python3 {quote(release / 'scripts/router-run.py')} --settings {quote(router['settingsPath'])} --node {quote(router['node'])} --entry {quote(release / 'dist/src/hotswap/main.js')}
Restart=on-failure
RestartSec=3
RestartPreventExitStatus=78
TimeoutStopSec=120
KillMode=control-group
TasksMax=256
LimitNOFILE=65536
MemoryHigh=512M
MemoryMax=2G
CPUWeight=100
UMask=0077
[Install]
WantedBy=default.target
'''
    current = unit_state(router['unit'])
    if current.get('ActiveState') == 'active':
        if not unit.is_file() or unit.read_text() != text:
            raise ControlError('RUNNING_ROUTER_DEFINITION_DRIFT')
    else:
        if current.get('MainPID') not in [None, '0']:
            raise ControlError('ROUTER_IS_STILL_TRANSITIONING')
        write_unit(unit, text)
        stager.systemctl('daemon-reload')
        stager.systemctl('reset-failed', router['unit'], check=False)
        stager.systemctl('enable', '--now', router['unit'])
    result = wait_control(router)
    current = unit_state(router['unit'])
    command = _router_command(result['routerPid'])
    expected_node = str(Path(router['node']).resolve())
    entry = str(release / 'dist/src/hotswap/main.js').encode()
    if current.get('MainPID') != str(result['routerPid']) or entry not in command:
        raise ControlError('ROUTER_PROCESS_PROVENANCE_MISMATCH')
    try:
        identity = executable_identity(result['routerPid'])
    except FileNotFoundError:
        identity = None
    if identity is None or identity['executable'] != expected_node:
        result = _reconcile_deleted_router_executable(home, state, result)
        current = unit_state(router['unit'])
        command = _router_command(result['routerPid'])
        identity = executable_identity(result['routerPid'])
        if current.get('MainPID') != str(result['routerPid']) or identity['executable'] != expected_node or entry not in command:
            raise ControlError('ROUTER_PROCESS_PROVENANCE_MISMATCH')
    return result


def describe_original(home, active, target, policy):
    config = read_json(active['configPath'])
    result = rpc(active['backendUrl'] + '/mcp', 'tools/call', {'name': 'system.info', 'arguments': {}}, config.get('http', {}).get('token'))
    runtime = result.get('structuredContent', {}).get('runtime', {})
    if result.get('isError') or runtime.get('release') != active['revision']:
        raise ControlError('LEGACY_RUNTIME_CHANGED')
    service = unit_state(active['backendUnit'])
    pid = runtime.get('pid')
    if not isinstance(pid, int) or service.get('MainPID') != str(pid):
        raise ControlError('LEGACY_SERVICE_IDENTITY_MISMATCH')
    identity = executable_identity(pid)
    original_release = Path(active['releaseDirectory']).resolve(strict=True)
    verify(original_release)
    original_entry = original_release / 'dist/src/http.js'
    argv = Path('/proc', str(pid), 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    if len(argv) != 2 or argv[1] != str(original_entry).encode() or identity['executable'] != str(Path(target['nodePath']).resolve()):
        raise ControlError('UNSUPPORTED_LEGACY_LAUNCH_SHAPE')
    generation = {'id': uuid.uuid4().hex, 'url': active['backendUrl'], 'revision': active['revision'], 'unit': active['backendUnit'],
                  'policyFingerprint': policy, 'legacy': {key: runtime[key] for key in ['pid', 'startedAt', 'configFingerprint']}}
    settings = {key: active[key] for key in ['backendUrl', 'backendUnit', 'configPath', 'canaryDirectory', 'workingDirectory',
                                            'expectedTools', 'expectedCapabilities', 'shellCanary'] if key in active}
    return {'generation': generation, 'settings': settings, 'runtime': runtime, 'identity': identity,
            'releaseDirectory': str(original_release), 'deploymentDirectory': active['deploymentDirectory']}


def initialize_state(home, release, node, active, target, policy):
    directory = state_path(home).parent
    router_port = stager.free_port()
    router = {'unit': 'chatgpt-mcp-router.service', 'url': f'http://127.0.0.1:{router_port}',
              'revision': verify(release)['revision'],
              'manifestSha256': hashlib.sha256((release / 'release-manifest.json').read_bytes()).hexdigest(),
              'stateDirectory': str(directory), 'controlSocket': str(directory / 'control.sock'),
              'settingsPath': str(directory / 'router.json'), 'keyFile': str(directory / 'router.key'),
              'configPath': str(directory / 'capabilities.json'), 'releaseDirectory': str(release), 'node': str(node)}
    original = describe_original(home, active, target, policy)
    bridge = directory / 'legacy-bridge.json'
    state = {'schema': 1, 'home': str(home), 'router': router, 'phase': 'router-staging',
             'profiles': active['profiles'], 'recoveryBaseline': read_json(home / '.config/chatgpt-mcp/recovery.json'),
             'ingress': {'url': active['backendUrl'], 'unit': active['backendUnit'], 'bridgeConfig': str(bridge),
                         'generation': original['generation']['id'], 'original': original},
             'generations': {original['generation']['id']: original}}
    atomic_json(router['configPath'], read_json(active['configPath']))
    atomic_json(router['settingsPath'], {'port': router_port, 'statePath': str(directory / 'registry.json'),
                                       'controlSocket': router['controlSocket'], 'keyFile': router['keyFile'], 'configPath': router['configPath']})
    identity = original['identity']
    atomic_json(bridge, {'schema': 1, 'id': original['generation']['id'], 'port': int(active['backendUrl'].rsplit(':', 1)[1]),
                        'routerUrl': router['url'], 'expectedPid': identity['pid'], 'expectedIdentity': identity['processIdentity'],
                        'expectedExecutable': identity['executable'], 'expectedCommandSha256': identity['commandSha256'],
                        'keyFile': router['keyFile'], 'configPath': router['configPath']})
    atomic_json(state_path(home), state)
    return state


def register(state, record):
    snapshot = control(state['router']['controlSocket'])
    return control(state['router']['controlSocket'], '/register', {'generation': record['generation'], 'expectedEpoch': snapshot['epoch']})


def ensure_bridge(home, state):
    router = state['router']
    ingress = state['ingress']
    original = ingress['original']
    settings = read_json(ingress['bridgeConfig'])
    release = Path(router['releaseDirectory'])
    unit = home / '.config/systemd/user' / (ingress['unit'] + '.d/90-hot-swap-ingress.conf')
    text = f'''[Unit]
Wants={router['unit']}
After={router['unit']}
[Service]
Environment={quote('CHATGPT_MCP_BRIDGE_CONFIG=' + ingress['bridgeConfig'])}
ExecStartPre=/usr/bin/python3 {quote(release / 'scripts/release.py')} verify {quote(release)}
ExecStart=
ExecStart={quote(original['identity']['executable'])} --import {quote(release / 'dist/src/hotswap/bridge-preload.js')} {quote(Path(original['releaseDirectory']) / 'dist/src/http.js')}
'''
    current = unit_state(ingress['unit'])
    if unit.exists() and unit.read_text() != text:
        raise ControlError('LEGACY_INGRESS_DEFINITION_DRIFT')
    if not unit.exists():
        stager.atomic_text(unit, text, 0o644)
        stager.run('systemd-analyze', '--user', 'verify', str(home / '.config/systemd/user' / ingress['unit']))
        stager.systemctl('daemon-reload')
    stager.systemctl('enable', ingress['unit'])  # No --now: retain the running process.
    try:
        installed = backend(original['generation'], router['keyFile'], '/__hotswap/bridge')
    except (ControlError, OSError):
        installed = None
    if installed and installed.get('inspectorOpen') is not False:
        raise ControlError('LEGACY_INSPECTOR_CLOSURE_NOT_CONFIRMED')
    if installed and installed.get('bridgeAbi') == 1 and installed.get('generation') == ingress['generation'] and str(installed.get('pid')) == current.get('MainPID'):
        pass  # Includes a cold-started ingress with legacyAvailable=false.
    elif current.get('ActiveState') != 'active':
        if current.get('MainPID') not in [None, '0']:
            raise ControlError('INGRESS_IS_STILL_TRANSITIONING')
        stager.systemctl('start', ingress['unit'])
    else:
        # The helper refuses a pre-existing debugger and verifies exact PID,
        # executable, argv digest, birth identity and owned listener before attach.
        # It is idempotent, and never receives arbitrary debugger expressions.
        result = stager.run(str(router['node']), str(release / 'dist/src/hotswap/attach-legacy.js'), ingress['bridgeConfig'],
                            check=False, timeout=45)
        if result.returncode:
            # Never undo an uncertain listener adoption. Keep the router, legacy
            # selection, persistent preload and all backend owners for reconcile.
            state['phase'] = 'adoption-needs-reconciliation'
            atomic_json(state_path(home), state)
            raise ControlError('LIVE_ADOPTION_NOT_CONFIRMED')
    receipt = backend(original['generation'], router['keyFile'], '/__hotswap/bridge')
    if receipt.get('bridgeAbi') != 1 or receipt.get('generation') != ingress['generation'] or receipt.get('inspectorOpen') is not False:
        raise ControlError('INGRESS_BRIDGE_IDENTITY_MISMATCH')
    # A cold-started ingress is valid for forwarding but cannot recover the old
    # backend's in-memory ownership. That legacy generation remains unavailable.
    if receipt.get('pid') != int(unit_state(ingress['unit']).get('MainPID', '0')):
        raise ControlError('INGRESS_PROCESS_PROVENANCE_MISMATCH')
    state['ingress']['observed'] = receipt
    if state.get('phase') != 'active':
        state['phase'] = 'router-adopted'
    atomic_json(state_path(home), state)
    return receipt


def desired_config(target):
    path = Path(target['configPath'])
    if not path.is_absolute():
        raise ControlError('TARGET_CONFIG_PATH_INVALID')
    return read_json(path)


def stage_candidate(home, release, node, active, target, key_file, canary_directory):
    revision = verify(release)['revision']
    directory = home / '.local/state/chatgpt-mcp/deployments' / (revision[:12] + '-' + uuid.uuid4().hex[:8])
    directory.mkdir(parents=True, mode=0o700)
    config = desired_config(target)
    if config.get('http', {}).get('host', '127.0.0.1') != '127.0.0.1':
        raise ControlError('HOT_SWAP_REQUIRES_LOOPBACK_BACKEND')
    config.setdefault('http', {})['port'] = stager.free_port()
    config_path = directory / 'config.local.json'
    candidate = stager.staging_config(config, directory)
    atomic_json(config_path, candidate)
    unit = 'chatgpt-mcp-runtime-' + directory.name + '.service'
    cwd = stager.working_directory(Path(active['configPath']), active['backendUnit'], active.get('workingDirectory'))
    settings = {'backendUrl': f"http://127.0.0.1:{config['http']['port']}", 'backendUnit': unit, 'configPath': str(config_path),
                'workingDirectory': str(cwd), 'canaryDirectory': str(canary_directory),
                'expectedTools': ['system.info'], 'expectedCapabilities': {'filesystemWrite': config.get('filesystem', {}).get('write', False),
                                                                          'shell': config.get('shell', {}).get('enabled', False)}}
    if config.get('shell', {}).get('enabled') and any(c in config['shell'].get('allowedCommands', []) for c in ['*', 'node']):
        settings['shellCanary'] = {'command': 'node', 'args': ['-e', "process.stdout.write('mcp-shell-canary')"], 'expectedStdout': 'mcp-shell-canary'}
    if config.get('jobs', {}).get('enabled') and config.get('shell', {}).get('enabled'):
        settings['expectedTools'] += ['exec.start', 'exec.status', 'exec.output', 'exec.cancel']
    atomic_json(directory / 'candidate-settings.json', settings)
    atomic_json(directory / 'hot-attempt.json', {'revision': revision, 'backendUnit': unit, 'phase': 'unpublished-staging'})
    unit_path = home / '.config/systemd/user' / unit
    if unit_path.exists():
        raise ControlError('CANDIDATE_UNIT_COLLISION')
    unit_text = stager.backend_unit_text(revision, release, cwd, config_path, node)
    unit_text = unit_text.replace('[Service]\n', '[Service]\nEnvironment=' + quote('CHATGPT_MCP_ROUTER_KEY_FILE=' + str(key_file)) + '\n', 1)
    write_unit(unit_path, unit_text)
    try:
        stager.systemctl('daemon-reload')
        stager.systemctl('start', unit)
        results = validate(settings, unit)
        if candidate != config:
            atomic_json(config_path, config)
            stager.systemctl('restart', unit)  # Still private and unpublished.
        results['finalBackend'] = stager.wait_backend(settings)
        runtime = results['finalBackend']['runtime']
        hot = runtime.get('hotSwap', {})
        generation = {'id': hot['instanceId'], 'url': settings['backendUrl'], 'revision': revision, 'unit': unit,
                      'policyFingerprint': hot['policyFingerprint']}
        observation = backend(generation, key_file)
        if observation.get('instanceId') != generation['id'] or observation.get('fenced') is not False:
            raise ControlError('CANDIDATE_INCARNATION_MISMATCH')
        atomic_json(directory / 'canary-results.json', {**results, 'stagingJobLedgerIsolated': candidate.get('jobs', {}).get('directory') != config.get('jobs', {}).get('directory')})
        return {'generation': generation, 'settings': settings, 'runtime': runtime, 'releaseDirectory': str(release),
                'deploymentDirectory': str(directory)}
    except BaseException:
        # No caller can have seen this endpoint through the routing plane yet.
        stager.systemctl('stop', unit, check=False)
        atomic_json(directory / 'hot-attempt.json', {'revision': revision, 'backendUnit': unit, 'phase': 'unpublished-failed'})
        raise


def ensure_recovery(home, release):
    path = home / '.config/systemd/user/chatgpt-mcp-recovery.service.d/90-hot-swap-controller.conf'
    text = f'''[Service]
ExecStart=
ExecStart=/usr/bin/python3 {quote(release / 'scripts/recovery.py')} --config {quote(home / '.config/chatgpt-mcp/recovery.json')}
'''
    if not path.exists() or path.read_text() != text:
        stager.atomic_text(path, text, 0o644)
        stager.systemctl('daemon-reload')
    stager.systemctl('enable', '--now', 'chatgpt-mcp-recovery.timer')


def assert_pin_current(home, revision):
    current = home / '.local/lib/overdeck-mcp-manager/current/pin.json'
    if current.exists() and json.loads(current.read_text()).get('revision') != revision:
        raise ControlError('OVERDECK_PIN_CHANGED_DURING_STAGING')


def deploy(home, release, target):
    release = release.resolve(strict=True)
    revision = verify(release)['revision']
    node = Path(target['nodePath']).resolve(strict=True)
    active_path = home / '.config/chatgpt-mcp/active.json'
    active = read_json(active_path)
    if {p['name']: p['unit'] for p in active['profiles']} != {p['name']: p['unit'] for p in target['profiles']}:
        raise ControlError('ENROLLED_PROFILES_CHANGED')
    root = state_path(home).parent
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    key_file = root / 'router.key'
    if not key_file.exists():
        with os.fdopen(os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as out:
            out.write(secrets.token_hex(32) + '\n'); out.flush(); os.fsync(out.fileno())
    private_file(key_file)
    previous_state = load_state(home) if state_path(home).exists() else None
    if previous_state:
        ensure_router(home, previous_state)
    before = profiles_snapshot(home, active['profiles'], previous_state['ingress']['url'] if previous_state else active['backendUrl'])
    record = stage_candidate(home, release, node, active, target, key_file, Path(target['canaryDirectory']))
    try:
        return activate_candidate(home, release, node, target, active, record, before)
    except BaseException:
        if not record.get('mayBePublished'):
            # This descriptor was never submitted to the router. There can be
            # no front-door owners, even if private staging or pin checks failed.
            stager.systemctl('stop', record['generation']['unit'], check=False)
        raise


def _selected_generation(snapshot):
    selected = snapshot.get('active')
    item = next((value for value in snapshot.get('generations', []) if value.get('id') == selected), None)
    if not item:
        raise ControlError('ACTIVE_GENERATION_METADATA_MISSING')
    return item


def _wait_router_idle(state, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = control(state['router']['controlSocket'])
        if all(item.get('inFlight', 0) == 0 for item in snapshot.get('generations', [])):
            return snapshot
        time.sleep(0.1)
    raise ControlError('POLICY_MAINTENANCE_DRAIN_TIMEOUT')


def _pause_unit(unit):
    current = unit_state(unit)
    pid = int(current.get('MainPID', '0'))
    if current.get('ActiveState') != 'active' or pid <= 0:
        raise ControlError('POLICY_MAINTENANCE_OWNER_NOT_RUNNING')
    stager.systemctl('kill', '--kill-whom=main', '--signal=SIGSTOP', unit)
    observed = unit_state(unit)
    if observed.get('ActiveState') != 'active' or observed.get('MainPID') != str(pid):
        raise ControlError('POLICY_MAINTENANCE_OWNER_CHANGED')
    return {'unit': unit, 'pid': pid}


def _resume_unit(item):
    current = unit_state(item['unit'])
    if current.get('ActiveState') != 'active' or current.get('MainPID') != str(item['pid']):
        raise ControlError('POLICY_MAINTENANCE_OWNER_CHANGED')
    stager.systemctl('kill', '--kill-whom=main', '--signal=SIGCONT', item['unit'])
    observed = unit_state(item['unit'])
    if observed.get('ActiveState') != 'active' or observed.get('MainPID') != str(item['pid']):
        raise ControlError('POLICY_MAINTENANCE_OWNER_CHANGED')


def _generation_descriptor(item):
    result = {key: copy.deepcopy(item[key]) for key in ['id', 'url', 'revision', 'unit', 'policyFingerprint']}
    if 'instanceId' in item:
        result['instanceId'] = copy.deepcopy(item['instanceId'])
    if 'legacy' in item:
        result['legacy'] = copy.deepcopy(item['legacy'])
    return result


def _policy_registry(snapshot, candidate):
    registry = {key: copy.deepcopy(snapshot[key]) for key in ['schema', 'epoch', 'active', 'previous', 'legacyOwner']}
    registry['generations'] = [_generation_descriptor(item) for item in snapshot['generations']]
    descriptor = _generation_descriptor(candidate)
    existing = next((item for item in registry['generations'] if item['id'] == descriptor['id']), None)
    if existing and existing != descriptor:
        raise ControlError('INCARNATION_ALREADY_REGISTERED')
    if not existing:
        if len(registry['generations']) >= 128:
            raise ControlError('RETAINED_GENERATION_LIMIT')
        registry['generations'].append(descriptor)
    registry['epoch'] += 1
    registry['active'] = descriptor['id']
    # Rollback across a policy boundary is a separate maintenance operation.
    # Retained old generations still own their opaque handles/resources.
    registry['previous'] = None
    return registry


def _pause_expected(item):
    observed = _pause_unit(item['unit'])
    if observed['pid'] != item['pid']:
        raise ControlError('POLICY_MAINTENANCE_OWNER_CHANGED')
    return observed


def _maintenance_plan(home, state, record, tunnel_owners, ingress_owner, old_registry, old_config):
    directory = Path(record['deploymentDirectory'])
    registry_backup = directory / 'policy-registry-backup.json'
    config_backup = directory / 'policy-router-config-backup.json'
    plan_path = directory / 'policy-maintenance-plan.json'
    atomic_json(registry_backup, old_registry)
    atomic_json(config_backup, old_config)
    guard = 'chatgpt-mcp-policy-rollback-' + record['generation']['id'][:12]
    plan = {'schema': 1, 'home': str(home), 'lockPath': str(home / '.local/state/chatgpt-mcp/recovery/recovery.lock'),
            'statePath': str(state_path(home)), 'registryPath': str(Path(state['router']['stateDirectory']) / 'registry.json'),
            'configPath': state['router']['configPath'], 'registryBackup': str(registry_backup),
            'configBackup': str(config_backup), 'routerUnit': state['router']['unit'],
            'ingress': ingress_owner, 'tunnels': tunnel_owners, 'guardUnit': guard,
            'committed': False, 'rolledBack': False}
    atomic_json(plan_path, plan)
    release = Path(record['releaseDirectory'])
    stager.run('systemd-run', '--user', '--unit=' + guard, '--on-active=180s',
               '/usr/bin/python3', str(release / 'scripts/deploy-hot.py'),
               'policy-rollback', '--plan', str(plan_path))
    return plan_path, plan


def rollback_policy_maintenance(plan_path, locked=False):
    plan_path = Path(plan_path)
    plan = read_json(plan_path)
    if plan.get('schema') != 1 or plan.get('committed') or plan.get('rolledBack'):
        return {'status': 'unchanged'}
    home = Path(plan['home'])
    lock_path = Path(plan['lockPath'])
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def restore():
        plan_now = read_json(plan_path)
        if plan_now.get('committed') or plan_now.get('rolledBack'):
            return {'status': 'unchanged'}
        state = load_state(home)
        for item in plan_now['tunnels']:
            _pause_expected(item)
        _wait_router_idle(state)
        _pause_expected(plan_now['ingress'])
        _wait_router_idle(state)
        try:
            stager.systemctl('stop', plan_now['routerUnit'], check=False)
            atomic_json(plan_now['configPath'], read_json(plan_now['configBackup']))
            atomic_json(plan_now['registryPath'], read_json(plan_now['registryBackup']))
            ensure_router(home, state)
            current = control(state['router']['controlSocket'])
            publish_selection(home, state, current)
            state['phase'] = 'active'
            atomic_json(state_path(home), state)
            plan_now['rolledBack'] = True
            atomic_json(plan_path, plan_now)
        finally:
            _resume_unit(plan_now['ingress'])
            for item in plan_now['tunnels']:
                _resume_unit(item)
        return {'status': 'rolled-back'}

    if locked:
        return restore()
    with lock_path.open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return restore()


def policy_maintenance(home, state, active, record, before, ingress):
    """Switch capability policy at a bounded, rollback-guarded maintenance boundary."""
    router = state['router']
    candidate = record['generation']
    snapshot = control(router['controlSocket'])
    current_generation = _selected_generation(snapshot)
    if current_generation['policyFingerprint'] == candidate['policyFingerprint']:
        raise ControlError('POLICY_MAINTENANCE_NOT_REQUIRED')

    tunnel_owners = [{'unit': profile['unit'], 'pid': next(item['pid'] for item in before if item['name'] == profile['name'])}
                     for profile in active['profiles']]
    ingress_owner = {'unit': state['ingress']['unit'], 'pid': ingress['pid']}
    registry_path = Path(router['stateDirectory']) / 'registry.json'
    old_registry = read_json(registry_path)
    old_config = read_json(router['configPath'])
    plan_path, plan = _maintenance_plan(home, state, record, tunnel_owners, ingress_owner, old_registry, old_config)
    traffic_paused = False
    committed = False
    try:
        for item in tunnel_owners:
            _pause_expected(item)
        snapshot = _wait_router_idle(state)
        if snapshot['active'] != current_generation['id']:
            raise ControlError('POLICY_MAINTENANCE_ROUTE_CHANGED')
        _pause_expected(ingress_owner)
        traffic_paused = True
        snapshot = _wait_router_idle(state)
        if snapshot['active'] != current_generation['id']:
            raise ControlError('POLICY_MAINTENANCE_ROUTE_CHANGED')

        desired = read_json(record['settings']['configPath'])
        next_registry = _policy_registry(snapshot, candidate)
        router_pid_before = snapshot['routerPid']
        stager.systemctl('stop', router['unit'])
        atomic_json(router['configPath'], desired)
        atomic_json(registry_path, next_registry)
        restarted = ensure_router(home, state)
        current = control(router['controlSocket'])
        if current.get('active') != candidate['id']:
            raise ControlError('POLICY_MAINTENANCE_SELECTION_MISMATCH')
        inventory = control(router['controlSocket'], '/inventory', {'id': candidate['id']})
        if inventory.get('instanceId') != candidate['id']:
            raise ControlError('POLICY_MAINTENANCE_CANDIDATE_MISMATCH')

        selected = publish_selection(home, state, current)
        if selected['revision'] != candidate['revision']:
            raise ControlError('POLICY_MAINTENANCE_SELECTION_MISMATCH')
        state['phase'] = 'active'
        atomic_json(state_path(home), state)

        # The independent timer may restore old policy only until this durable
        # commit. After admissions reopen, cross-policy rollback is forbidden.
        plan['committed'] = True
        atomic_json(plan_path, plan)
        committed = True
        stager.systemctl('stop', plan['guardUnit'] + '.timer', check=False)

        _resume_unit(ingress_owner)
        for item in tunnel_owners:
            _resume_unit(item)
        traffic_paused = False
        for profile in active['profiles']:
            stager.wait_poll(profile['healthUrl'])

        after = profiles_snapshot(home, active['profiles'], state['ingress']['url'])
        if after != before or ingress['pid'] != int(unit_state(state['ingress']['unit']).get('MainPID', '0')):
            raise ControlError('POLICY_MAINTENANCE_OWNER_CHANGED')
        result = {'status': 'policy-maintenance-cutover', 'revision': candidate['revision'],
                  'activeGeneration': current['active'], 'previousGeneration': None, 'epoch': current['epoch'],
                  'routerPidBefore': router_pid_before, 'routerPid': restarted['routerPid'],
                  'routerRestarted': restarted['routerPid'] != router_pid_before,
                  'ingressPid': ingress['pid'], 'tunnels': after, 'oldBackendsRetained': True,
                  'finalCanaries': {'privateCandidate': 'passed', 'routerInventory': 'passed'}}
        atomic_json(Path(record['deploymentDirectory']) / 'hot-attempt.json', {'phase': 'active', **result})
        atomic_json(Path(router['stateDirectory']) / 'last-upgrade.json', result)
        return result
    except BaseException as failure:
        if not committed:
            rollback_policy_maintenance(plan_path, locked=True)
            traffic_paused = False
            stager.systemctl('stop', plan['guardUnit'] + '.timer', check=False)
        elif traffic_paused:
            # A committed policy is never rewound. Resume exact owners and
            # surface the post-commit convergence failure for reconciliation.
            _resume_unit(ingress_owner)
            for item in tunnel_owners:
                _resume_unit(item)
        raise failure



def activate_candidate(home, release, node, target, active, record, before):
    revision = record['generation']['revision']
    root = state_path(home).parent
    lock_path = home / '.local/state/chatgpt-mcp/recovery/recovery.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with lock_path.open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        assert_pin_current(home, revision)
        state = load_state(home) if state_path(home).exists() else initialize_state(home, release, node, active, target, record['generation']['policyFingerprint'])
        current = ensure_router(home, state)
        router_pid = current['routerPid']
        if current.get('active') is None:
            original = state['ingress']['original']
            register(state, original)
            snapshot = control(state['router']['controlSocket'])
            control(state['router']['controlSocket'], '/activate', {'id': original['generation']['id'], 'expectedEpoch': snapshot['epoch']})
        # Save candidate provenance BEFORE registration or selection. Every
        # possibly exposed generation remains reconstructable after interruption.
        record['mayBePublished'] = True
        state['generations'][record['generation']['id']] = record
        atomic_json(state_path(home), state)
        snapshot = control(state['router']['controlSocket'])
        policy_change = _selected_generation(snapshot)['policyFingerprint'] != record['generation']['policyFingerprint']
        if not policy_change:
            # Same-policy publication keeps the original ordering: once
            # registration is attempted, uncertain bridge adoption retains the
            # candidate rather than treating it as private staging.
            register(state, record)
        ingress = ensure_bridge(home, state)
        stager.systemctl('enable', record['generation']['unit'])
        ensure_recovery(home, release)
        if profiles_snapshot(home, active['profiles'], state['ingress']['url']) != before:
            raise ControlError('TUNNEL_CHANGED_DURING_STAGING')
        if policy_change:
            assert_pin_current(home, revision)
            return policy_maintenance(home, state, active, record, before, ingress)
        snapshot = control(state['router']['controlSocket'])
        assert_pin_current(home, revision)
        try:
            control(state['router']['controlSocket'], '/activate', {'id': record['generation']['id'], 'expectedEpoch': snapshot['epoch']})
        except ControlError:
            # Read-only reconciliation, never a second activation submission.
            current = control(state['router']['controlSocket'])
            publish_selection(home, state, current)
            raise
        current = control(state['router']['controlSocket'])
        selected = publish_selection(home, state, current)
        state['phase'] = 'active'
        atomic_json(state_path(home), state)
        recovery = read_json(home / '.config/chatgpt-mcp/recovery.json')
        health, evidence = backend_probe(recovery, canary=True)
        if health != 'HEALTHY' or selected['revision'] != revision:
            # Calls or handles may already exist on the new backend. Keep it.
            select(home, 'rollback')
            raise ControlError('POST_ACTIVATION_CANARY_FAILED_ROLLED_BACK')
        after = profiles_snapshot(home, active['profiles'], state['ingress']['url'])
        if after != before or current['routerPid'] != router_pid:
            raise ControlError('PERSISTENT_INGRESS_CHANGED_DURING_UPGRADE')
        result = {'status': 'hot-swapped', 'revision': revision, 'activeGeneration': current['active'],
                  'previousGeneration': current['previous'], 'epoch': current['epoch'], 'routerPid': router_pid,
                  'ingressPid': ingress['pid'], 'tunnels': after, 'oldBackendsRetained': True,
                  'finalCanaries': {key: evidence[key] for key in ['writeCanary', 'shellCanary'] if key in evidence}}
        atomic_json(Path(record['deploymentDirectory']) / 'hot-attempt.json', {'phase': 'active', **result})
        atomic_json(root / 'last-upgrade.json', result)
        return result


def reconcile_router(home):
    path = state_path(home)
    if not path.exists():
        return {'status': 'not-configured'}
    lock_path = home / '.local/state/chatgpt-mcp/recovery/recovery.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with lock_path.open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = load_state(home)
        before = control(state['router']['controlSocket'])
        before_pid = before['routerPid']
        current = ensure_router(home, state)
        return {
            'status': 'reconciled',
            'routerPid': current['routerPid'],
            'routerRestarted': current['routerPid'] != before_pid,
            'activeGeneration': current.get('active'),
            'epoch': current.get('epoch'),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['deploy', 'status', 'rollback', 'activate', 'policy-rollback', 'reconcile-router'])
    parser.add_argument('--release', type=Path)
    parser.add_argument('--target', type=Path)
    parser.add_argument('--generation')
    parser.add_argument('--plan', type=Path)
    args = parser.parse_args()
    home = Path.home()
    if args.action == 'status':
        result = status(home)
    elif args.action == 'reconcile-router':
        result = reconcile_router(home)
    elif args.action == 'policy-rollback':
        if not args.plan:
            parser.error('policy-rollback requires --plan')
        result = rollback_policy_maintenance(args.plan)
    elif args.action == 'deploy':
        if not args.release or not args.target:
            parser.error('deploy requires --release and --target')
        result = deploy(home, args.release, read_json(args.target))
    else:
        lock_path = home / '.local/state/chatgpt-mcp/recovery/recovery.lock'
        with lock_path.open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = select(home, args.action, args.generation)
    print(json.dumps(result, sort_keys=True), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, ControlError, subprocess.SubprocessError) as error:
        # No argv-bearing CalledProcessError, token, profile content, command
        # output or application data is exposed in deployment diagnostics.
        code = error.code if isinstance(error, ControlError) and re.fullmatch(r'[A-Z0-9_]{1,100}', error.code) else 'DEPLOYMENT_VALIDATION_OR_OS_FAILURE'
        print(json.dumps({'status': 'hot-swap-refused', 'error': code,
                          'action': 'retain-all-published-owners-and-reconcile'}), file=sys.stderr)
        raise SystemExit(1)
