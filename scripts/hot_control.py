#!/usr/bin/env python3
"""Private hot-swap control and crash-reconcilable deployment observations.

This module never retries a write, rewrites a tunnel profile, stops a resource
owner, or prints capability configuration and credentials.
"""
import errno
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import tempfile
import urllib.parse

MAX_RESPONSE = 1024 * 1024


class ControlError(RuntimeError):
    def __init__(self, code, status=503):
        super().__init__(code)
        self.code = code
        self.status = status


def private_file(path):
    path = Path(path)
    info = path.lstat()
    if not path.is_absolute() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ControlError('PRIVATE_STATE_REQUIRED')
    return path


def read_json(path):
    path = private_file(path)
    if path.stat().st_size > MAX_RESPONSE:
        raise ControlError('STATE_LIMIT')
    result = json.loads(path.read_text())
    if not isinstance(result, dict):
        raise ControlError('INVALID_STATE')
    return result


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, sort_keys=True)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=10)
        self.path = str(path)

    def connect(self):
        info = Path(self.path).lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ControlError('PRIVATE_CONTROL_SOCKET_REQUIRED')
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)
        _, uid, _ = struct.unpack('3i', self.sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        if uid != os.getuid():
            self.close()
            raise ControlError('CONTROL_PEER_MISMATCH')


def exchange(connection, path, data=None, headers=None):
    body = None if data is None else json.dumps(data).encode()
    headers = {'Accept': 'application/json', **(headers or {})}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    try:
        connection.request('GET' if body is None else 'POST', path, body, headers)
        response = connection.getresponse()
        text = response.read(MAX_RESPONSE + 1)
        if len(text) > MAX_RESPONSE:
            raise ControlError('CONTROL_RESPONSE_LIMIT')
        value = json.loads(text)
        if not isinstance(value, dict):
            raise ControlError('INVALID_CONTROL_RESPONSE')
        if response.status != 200:
            code = value.get('error', 'CONTROL_REQUEST_REFUSED')
            raise ControlError(code if isinstance(code, str) and len(code) < 100 else 'CONTROL_REQUEST_REFUSED', response.status)
        return value
    except (OSError, http.client.HTTPException, ValueError):
        # A failed acknowledgement is not permission to repeat a CAS or command.
        raise ControlError('CONTROL_OUTCOME_UNCERTAIN') from None
    finally:
        connection.close()


def control(socket_path, path='/status', data=None):
    return exchange(UnixConnection(socket_path), path, data)


def backend(generation, key_file, path='/__hotswap', data=None):
    url = urllib.parse.urlsplit(generation['url'])
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path not in ['', '/'] or url.query or url.fragment or url.username or url.password:
        raise ControlError('LOOPBACK_BACKEND_REQUIRED')
    key = private_file(key_file).read_text().strip()
    return exchange(http.client.HTTPConnection('127.0.0.1', url.port, timeout=5), path, data,
                    {'x-mcp-route-key': key, 'x-mcp-route-instance': generation['id']})


def state_path(home):
    return Path(home) / '.local/state/chatgpt-mcp/hotswap/deployment.json'


def load_state(home):
    state = read_json(state_path(home))
    if state.get('schema') != 1 or not isinstance(state.get('generations'), dict):
        raise ControlError('INVALID_DEPLOYMENT_STATE')
    return state


def selected_record(state, status):
    record = state['generations'].get(status.get('active'))
    if not record or record['generation'] not in status.get('generations', []):
        # Router status adds observational counters. Compare the authoritative
        # descriptor fields, not those transient status fields.
        record = state['generations'].get(status.get('active'))
        observed = next((g for g in status.get('generations', []) if g['id'] == status.get('active')), None)
        if not record or not observed or any(observed.get(key) != value for key, value in record['generation'].items()):
            raise ControlError('SELECTED_GENERATION_METADATA_MISSING')
    return record


def publish_selection(home, state, status):
    """Called under the shared deployment/recovery lock, after reading the router.

    Router CAS is the routing commit. These compatibility markers are derived
    observations and can always be reconstructed after an interrupted write.
    """
    home = Path(home)
    record = selected_record(state, status)
    generation = record['generation']
    settings = record['settings']
    hot = {'schema': 1, 'statePath': str(state_path(home)), 'controlSocket': state['router']['controlSocket'],
           'activeGeneration': generation['id'], 'epoch': status['epoch'], 'routerUnit': state['router']['unit'],
           'routerUrl': state['router']['url'], 'ingressUnit': state['ingress']['unit']}
    active = {**settings, 'backendUrl': state['ingress']['url'], 'backendDirectUrl': generation['url'],
              'backendUnit': generation['unit'], 'revision': generation['revision'], 'releaseDirectory': record['releaseDirectory'],
              'deploymentDirectory': record['deploymentDirectory'], 'profiles': state['profiles'], 'hotSwap': hot}
    recovery = {**state['recoveryBaseline'], **{key: settings[key] for key in (
        'configPath', 'canaryDirectory', 'shellCanary', 'expectedCapabilities', 'expectedTools', 'workingDirectory') if key in settings},
        'backendUrl': state['ingress']['url'], 'backendUnit': generation['unit'], 'profiles': state['profiles'], 'hotSwap': hot,
        'expectedConfigSha256': hashlib.sha256(Path(settings['configPath']).read_bytes()).hexdigest(),
        'expectedRuntime': {key: record['runtime'][key] for key in ['release', 'configFingerprint']}}
    atomic_json(home / '.config/chatgpt-mcp/active.json', active)
    atomic_json(home / '.config/chatgpt-mcp/recovery.json', recovery)
    atomic_json(Path(state['router']['stateDirectory']) / 'selection-observation.json',
                {'epoch': status['epoch'], 'active': generation['id'], 'previous': status.get('previous'),
                 'revision': generation['revision'], 'routerPid': status['routerPid']})
    return active


def select(home, operation='rollback', generation_id=None):
    """Caller owns the deployment/recovery lock. No transparent CAS retries."""
    state = load_state(home)
    snapshot = control(state['router']['controlSocket'])
    data = {'expectedEpoch': snapshot['epoch']}
    if operation == 'activate':
        data['id'] = generation_id
    elif operation != 'rollback':
        raise ControlError('INVALID_SELECTION_OPERATION')
    try:
        control(state['router']['controlSocket'], '/' + operation, data)
    except ControlError:
        # Reconcile a possibly committed selection before reporting uncertainty.
        publish_selection(home, state, control(state['router']['controlSocket']))
        raise
    current = control(state['router']['controlSocket'])
    active = publish_selection(home, state, current)
    return {'state': 'selected', 'revision': active['revision'], 'activeGeneration': current['active'],
            'previousGeneration': current['previous'], 'epoch': current['epoch'], 'routerPid': current['routerPid']}


def recover_backend(settings):
    """Recovery never restarts an owning backend or the persistent routing plane."""
    path = Path(settings['hotSwap']['statePath'])
    state = read_json(path)
    home = Path(state['home'])
    try:
        current = control(state['router']['controlSocket'])
        if current.get('previous'):
            result = select(home)
            return {'action': 'route_rollback', 'accepted': True, **result}
    except (ControlError, OSError, KeyError, ValueError):
        pass
    # Normal Overdeck reconciliation stages a replacement; it never restarts a
    # live backend to repair a failed generation. No duplicate controller loop.
    result = subprocess.run(['systemctl', '--user', 'start', '--no-block', 'overdeck-mcp-sync.service'],
                            capture_output=True, timeout=5, check=False)
    return {'action': 'overdeck_reconciliation', 'accepted': result.returncode == 0}


def process_identity(pid):
    try:
        text = Path('/proc', str(pid), 'stat').read_text()
        fields = text[text.rfind(')') + 2:].split()
        if not fields or fields[0] in ['Z', 'X', 'x']:
            return None
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        return boot + ':' + fields[19]
    except (OSError, IndexError):
        return None


def executable_identity(pid):
    base = Path('/proc', str(pid))
    return {'pid': pid, 'processIdentity': process_identity(pid), 'executable': str((base / 'exe').resolve(strict=True)),
            'commandSha256': hashlib.sha256((base / 'cmdline').read_bytes()).hexdigest()}


def status(home):
    state = load_state(home)
    route = control(state['router']['controlSocket'])
    return {'schema': 1, 'router': route, 'ingress': {key: state['ingress'][key] for key in ['unit', 'url', 'bridgeConfig']},
            'routerRelease': state['router']['releaseDirectory'], 'automaticOwnerTermination': False}
