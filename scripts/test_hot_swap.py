#!/usr/bin/env python3
"""Private-file/control/deployment tests. All services and live homes are isolated."""
import contextlib
import copy
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import select as select_io
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import hot_control as hot
import recovery


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


deploy = module('tested_hot_deployer', 'deploy-hot.py')
runner = module('tested_router_runner', 'router-run.py')


class Route:
    def __init__(self, a, b):
        self.value = {'schema': 1, 'epoch': 1, 'active': a['id'], 'previous': None, 'legacyOwner': a['id'],
                      'generations': [copy.deepcopy(a)], 'routerPid': 73001}
        self.calls = []
        self.fail_after_selection = False

    def __call__(self, socket_path, path='/status', data=None):
        self.calls.append((path, copy.deepcopy(data)))
        if path == '/status':
            return copy.deepcopy(self.value)
        if data['expectedEpoch'] != self.value['epoch']:
            raise hot.ControlError('STALE_ROUTING_EPOCH', 409)
        if path == '/register':
            item = data['generation']
            if not any(g['id'] == item['id'] for g in self.value['generations']):
                self.value['generations'].append(copy.deepcopy(item))
                self.value['epoch'] += 1
        elif path in ['/activate', '/rollback']:
            selected = data['id'] if path == '/activate' else self.value['previous']
            if not selected:
                raise hot.ControlError('GENERATION_UNKNOWN')
            previous = self.value['active']
            self.value.update(active=selected, previous=previous, epoch=self.value['epoch'] + 1)
            if self.fail_after_selection:
                raise hot.ControlError('CONTROL_OUTCOME_UNCERTAIN')
        else:
            raise AssertionError('unexpected control operation: ' + path)
        return copy.deepcopy(self.value)


@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='mcp-hot-deployment-test-') as directory:
        home = Path(directory)
        root = hot.state_path(home).parent
        root.mkdir(parents=True, mode=0o700)
        (root / 'router.key').write_text('0' * 64 + '\n')
        (root / 'router.key').chmod(0o600)
        node = Path(os.environ.get('MCP_TEST_NODE', shutil.which('node'))).resolve()
        records = []
        for letter, port in [('a', 31001), ('b', 31002)]:
            release = home / 'releases' / (letter * 40)
            release.mkdir(parents=True)
            (release / 'release-manifest.json').write_text(json.dumps({'revision': letter * 40}))
            attempt = home / 'deployments' / letter
            attempt.mkdir(parents=True)
            config = attempt / 'config.json'
            hot.atomic_json(config, {'http': {'port': port}, 'filesystem': {'roots': [str(home)], 'read': True, 'write': True}})
            generation = {'id': letter * 32, 'url': f'http://127.0.0.1:{port}', 'unit': 'backend-' + letter + '.service',
                          'revision': letter * 40, 'policyFingerprint': '1' * 64}
            runtime = {'pid': 73010 + len(records), 'release': letter * 40, 'startedAt': '2026-09-15T00:00:00Z',
                       'configFingerprint': hashlib.sha256(config.read_bytes()).hexdigest()}
            if letter == 'a':
                generation['legacy'] = {key: runtime[key] for key in ['pid', 'startedAt', 'configFingerprint']}
            records.append({'generation': generation, 'settings': {'configPath': str(config), 'backendUrl': generation['url'],
                             'backendUnit': generation['unit'], 'workingDirectory': str(home), 'canaryDirectory': str(home)},
                            'runtime': runtime, 'releaseDirectory': str(release), 'deploymentDirectory': str(attempt),
                            'identity': {'pid': runtime['pid'], 'processIdentity': 'synthetic:1', 'executable': str(node), 'commandSha256': '2' * 64}})
        a, b = records
        active = {**a['settings'], 'revision': a['generation']['revision'], 'releaseDirectory': a['releaseDirectory'],
                  'deploymentDirectory': a['deploymentDirectory'], 'profiles': []}
        hot.atomic_json(home / '.config/chatgpt-mcp/active.json', active)
        state = {'schema': 1, 'home': str(home), 'phase': 'active', 'profiles': [],
                 'recoveryBaseline': {'stateDirectory': str(home / '.local/state/chatgpt-mcp/recovery'), 'profiles': []},
                 'router': {'url': 'http://127.0.0.1:31999', 'unit': 'chatgpt-mcp-router.service', 'stateDirectory': str(root),
                            'controlSocket': str(root / 'control.sock'), 'keyFile': str(root / 'router.key'),
                            'configPath': str(a['settings']['configPath']), 'settingsPath': str(root / 'router.json'),
                            'releaseDirectory': b['releaseDirectory'], 'node': str(node), 'revision': 'b' * 40,
                            'manifestSha256': hashlib.sha256((Path(b['releaseDirectory']) / 'release-manifest.json').read_bytes()).hexdigest()},
                 'ingress': {'unit': a['generation']['unit'], 'url': a['generation']['url'], 'generation': a['generation']['id'],
                             'bridgeConfig': str(root / 'bridge.json'), 'original': a},
                 'generations': {a['generation']['id']: a}}
        hot.atomic_json(hot.state_path(home), state)
        hot.atomic_json(home / '.config/chatgpt-mcp/recovery.json', state['recoveryBaseline'])
        hot.atomic_json(root / 'bridge.json', {'schema': 1})
        target = {'nodePath': str(node), 'canaryDirectory': str(home), 'profiles': []}
        yield SimpleNamespace(home=home, root=root, node=node, a=a, b=b, state=state, active=active, target=target,
                              release=Path(b['releaseDirectory']), route=Route(a['generation'], b['generation']))


@contextlib.contextmanager
def deployment_seams(f, bridge_error=None, health='HEALTHY'):
    def service(*args, **kwargs):
        if args[0] in ['restart', 'stop', 'disable'] and args[1] != f.b['generation']['unit']:
            raise AssertionError('attempted to disturb a published owner: ' + str(args))
        return SimpleNamespace(returncode=0, stdout='', stderr='')
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(deploy, 'verify', return_value={'revision': 'b' * 40}))
        stack.enter_context(mock.patch.object(deploy, 'ensure_router', side_effect=lambda *_: f.route('socket')))
        stack.enter_context(mock.patch.object(deploy, 'profiles_snapshot', return_value=[{'pid': 73099, 'profileSha256': '3' * 64}]))
        stack.enter_context(mock.patch.object(deploy, 'stage_candidate', return_value=f.b))
        stack.enter_context(mock.patch.object(deploy, 'ensure_bridge', side_effect=bridge_error,
                                             return_value={'pid': f.a['runtime']['pid'], 'legacyAvailable': True}))
        stack.enter_context(mock.patch.object(deploy, 'ensure_recovery'))
        stack.enter_context(mock.patch.object(deploy, 'control', side_effect=f.route))
        stack.enter_context(mock.patch.object(hot, 'control', side_effect=f.route))
        stack.enter_context(mock.patch.object(deploy, 'backend_probe', return_value=(health, {'writeCanary': 'passed', 'shellCanary': 'passed'})))
        calls = stack.enter_context(mock.patch.object(deploy.stager, 'systemctl', side_effect=service))
        yield calls


class LiveProofMetadataTests(unittest.TestCase):
    def test_desktop_metadata_uses_actual_grants_and_refuses_policy_drift(self):
        probe = module('tested_live_hotswap_proof', 'hot-live-proof.py')
        enabled = {key: True for key in ['application', 'browser', 'hostDisplayAccess', 'screenCapture', 'screenRecording', 'input']}
        note = probe.desktop_observation(enabled, enabled, False)
        self.assertEqual(note['granted'], enabled)
        self.assertNotIn('disabled', note['proof'])
        self.assertEqual(probe.desktop_observation(enabled, enabled, True)['proof'], 'passed')
        self.assertTrue(probe.desktop_observation({}, {}, False)['policyUnchanged'])
        with self.assertRaisesRegex(RuntimeError, 'capabilities changed'):
            probe.desktop_observation(enabled, {**enabled, 'screenCapture': False}, False)


class DeploymentTests(unittest.TestCase):
    def test_activation_changes_selection_not_tunnels_or_old_units(self):
        with fixture() as f, deployment_seams(f) as calls:
            old_config = Path(f.a['settings']['configPath']).read_bytes()
            result = deploy.deploy(f.home, f.release, f.target)
            self.assertEqual(result['status'], 'hot-swapped')
            self.assertEqual(result['routerPid'], 73001)
            self.assertEqual(result['previousGeneration'], f.a['generation']['id'])
            self.assertEqual(result['tunnels'][0]['pid'], 73099)
            active = hot.read_json(f.home / '.config/chatgpt-mcp/active.json')
            self.assertEqual(active['backendUrl'], f.a['generation']['url'])
            self.assertEqual(active['backendDirectUrl'], f.b['generation']['url'])
            self.assertEqual(active['hotSwap']['activeGeneration'], f.b['generation']['id'])
            self.assertEqual(Path(f.a['settings']['configPath']).read_bytes(), old_config)
            self.assertFalse(any(call.args[0] in ['restart', 'stop', 'disable'] for call in calls.call_args_list))
            self.assertEqual([path for path, _ in f.route.calls].count('/activate'), 1)

    def test_stale_overdeck_pin_stops_only_the_never_published_candidate(self):
        with fixture() as f, deployment_seams(f) as calls:
            hot.atomic_json(f.home / '.local/lib/overdeck-mcp-manager/current/pin.json', {'revision': 'c' * 40})
            with self.assertRaisesRegex(hot.ControlError, 'PIN_CHANGED'):
                deploy.deploy(f.home, f.release, f.target)
            self.assertEqual(f.route.value['active'], f.a['generation']['id'])
            self.assertFalse(any(path in ['/activate', '/register'] for path, _ in f.route.calls))
            calls.assert_called_once_with('stop', f.b['generation']['unit'], check=False)

    def test_uncertain_adoption_retains_every_possibly_published_owner(self):
        with fixture() as f, deployment_seams(f, bridge_error=hot.ControlError('LIVE_ADOPTION_NOT_CONFIRMED')) as calls:
            with self.assertRaises(hot.ControlError):
                deploy.deploy(f.home, f.release, f.target)
            self.assertEqual(f.route.value['active'], f.a['generation']['id'])
            self.assertIn(f.b['generation']['id'], [g['id'] for g in f.route.value['generations']])
            self.assertIn(f.b['generation']['id'], hot.load_state(f.home)['generations'])
            self.assertFalse(any(call.args[0] in ['restart', 'stop', 'disable'] for call in calls.call_args_list))

    def test_failed_post_activation_canary_rolls_back_without_killing_new_handles(self):
        with fixture() as f, deployment_seams(f, health='EXECUTION_FAILURE') as calls:
            with self.assertRaisesRegex(hot.ControlError, 'ROLLED_BACK'):
                deploy.deploy(f.home, f.release, f.target)
            self.assertEqual(f.route.value['active'], f.a['generation']['id'])
            self.assertEqual(f.route.value['previous'], f.b['generation']['id'])
            self.assertEqual(hot.read_json(f.home / '.config/chatgpt-mcp/active.json')['revision'], 'a' * 40)
            self.assertFalse(any(call.args[0] in ['restart', 'stop', 'disable'] for call in calls.call_args_list))
            self.assertEqual([path for path, _ in f.route.calls].count('/rollback'), 1)

    def test_uncertain_control_acknowledgement_reconciles_without_replay(self):
        with fixture() as f:
            f.state['generations'][f.b['generation']['id']] = f.b
            hot.atomic_json(hot.state_path(f.home), f.state)
            f.route.value['generations'].append(f.b['generation'])
            f.route.value['previous'] = f.b['generation']['id']
            f.route.fail_after_selection = True
            with mock.patch.object(hot, 'control', side_effect=f.route):
                with self.assertRaisesRegex(hot.ControlError, 'UNCERTAIN'):
                    hot.select(f.home)
            self.assertEqual(hot.read_json(f.home / '.config/chatgpt-mcp/active.json')['revision'], 'b' * 40)
            self.assertEqual([path for path, _ in f.route.calls].count('/rollback'), 1)

    def test_existing_and_cold_started_ingress_never_reopens_the_inspector(self):
        with fixture() as f:
            current_pid = 73088
            receipt = {'bridgeAbi': 1, 'generation': f.a['generation']['id'], 'pid': current_pid, 'legacyAvailable': False, 'inspectorOpen': False}
            def command(*args, **kwargs):
                self.assertFalse(any(str(arg).endswith('attach-legacy.js') for arg in args), 'existing ingress must not be reattached')
                return SimpleNamespace(returncode=0, stdout='', stderr='')
            with mock.patch.object(deploy, 'unit_state', return_value={'ActiveState': 'active', 'MainPID': str(current_pid)}), \
                 mock.patch.object(deploy, 'backend', return_value=receipt), \
                 mock.patch.object(deploy.stager, 'systemctl', side_effect=command) as service, \
                 mock.patch.object(deploy.stager, 'run', side_effect=command):
                deploy.ensure_bridge(f.home, f.state)
                dropin = f.home / '.config/systemd/user' / (f.a['generation']['unit'] + '.d/90-hot-swap-ingress.conf')
                before = dropin.stat().st_mtime_ns
                deploy.ensure_bridge(f.home, f.state)
                self.assertEqual(dropin.stat().st_mtime_ns, before)
                self.assertFalse(any(call.args[0] in ['restart', 'stop'] for call in service.call_args_list))
                self.assertEqual(f.state['phase'], 'active')

    def test_legacy_port_switch_installer_refuses_managed_ingress(self):
        with fixture() as f, mock.patch.object(deploy.stager.pathlib.Path, 'home', return_value=f.home), \
             mock.patch.object(deploy.stager, 'systemctl') as service:
            with self.assertRaisesRegex(ValueError, 'hot-swap ingress'):
                deploy.stager.deploy(SimpleNamespace())
            service.assert_not_called()


class RecoveryTests(unittest.TestCase):
    def test_backend_recovery_rolls_back_without_restart_or_tunnel_actions(self):
        with fixture() as f:
            settings = {**f.state['recoveryBaseline'], 'backendUnit': f.a['generation']['unit'],
                        'hotSwap': {'statePath': str(hot.state_path(f.home))}, 'policy': {'confirmations': 1}}
            with mock.patch.object(recovery, 'backend_probe', return_value=('BACKEND_UNAVAILABLE', {})), \
                 mock.patch.object(hot, 'recover_backend', return_value={'action': 'route_rollback', 'accepted': True}) as repair, \
                 mock.patch.object(recovery.subprocess, 'run', side_effect=AssertionError('no direct service mutation')):
                result = recovery.tick(settings)
                self.assertEqual(result['components'][0]['action'], 'route_recovery')
                repair.assert_called_once_with(settings)

    def test_recovery_retains_normal_overdeck_ownership_when_no_rollback_is_available(self):
        with fixture() as f:
            settings = {'hotSwap': {'statePath': str(hot.state_path(f.home))}}
            with mock.patch.object(hot, 'control', return_value={'active': f.a['generation']['id'], 'previous': None}), \
                 mock.patch.object(hot.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as service:
                self.assertTrue(hot.recover_backend(settings)['accepted'])
                service.assert_called_once_with(['systemctl', '--user', 'start', '--no-block', 'overdeck-mcp-sync.service'],
                                                capture_output=True, timeout=5, check=False)


class RouterLifetimeTests(unittest.TestCase):
    def settings(self, home):
        state = home / 'private'
        state.mkdir(mode=0o700)
        settings = home / 'settings.json'
        hot.atomic_json(settings, {'controlSocket': str(state / 'control.sock'), 'statePath': str(state / 'registry.json')})
        return settings, state / 'control.sock'

    def test_private_lifetime_lock_is_exclusive_and_released_on_exec_process_exit(self):
        with tempfile.TemporaryDirectory(prefix='mcp-router-lifetime-test-') as tmp:
            home = Path(tmp)
            settings, _ = self.settings(home)
            entry = home / 'hotswap/main.js'
            entry.parent.mkdir()
            entry.write_text("process.stdout.write('ready\\n');setInterval(()=>{},10000);\n")
            node = os.environ.get('MCP_TEST_NODE', shutil.which('node'))
            argv = [sys.executable, str(Path(runner.__file__)), '--settings', str(settings), '--node', node, '--entry', str(entry)]
            process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertTrue(select_io.select([process.stdout], [], [], 8)[0], 'router lifetime child did not start')
                self.assertEqual(process.stdout.readline(), 'ready\n')
                refused = subprocess.run(argv, capture_output=True, text=True, timeout=5)
                self.assertEqual(refused.returncode, 78)
                self.assertIn('ROUTER_LIFETIME_START_REFUSED', refused.stderr)
                self.assertIsNone(process.poll())
            finally:
                process.terminate()
                process.wait(timeout=5)
                process.stdout.close(); process.stderr.close()
            fd, _ = runner.claim(settings)
            os.close(fd)

    def test_only_a_proven_stale_owned_socket_can_be_removed(self):
        with tempfile.TemporaryDirectory(prefix='mcp-router-stale-test-') as tmp:
            home = Path(tmp)
            settings, path = self.settings(home)
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(path)); path.chmod(0o600); listener.listen(1)
                with self.assertRaisesRegex(ValueError, 'live controller'):
                    runner.claim(settings)
                self.assertTrue(path.is_socket())
            fd, _ = runner.claim(settings)
            os.close(fd)
            self.assertFalse(path.exists())
            path.write_text('not a socket')
            with self.assertRaisesRegex(ValueError, 'non-owned router socket'):
                runner.claim(settings)
            self.assertEqual(path.read_text(), 'not a socket')


class ControlTransportTests(unittest.TestCase):
    def test_dispatched_control_write_is_not_repeated_when_reply_is_lost(self):
        with tempfile.TemporaryDirectory(prefix='mcp-control-wire-test-') as tmp:
            path = Path(tmp) / 'control.sock'
            calls = []
            class Handler(http.server.BaseHTTPRequestHandler):
                def do_POST(self):
                    calls.append(self.rfile.read(int(self.headers['Content-Length'])))
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                def log_message(self, *args):
                    pass
            with socketserver.UnixStreamServer(str(path), Handler) as server:
                path.chmod(0o600)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    with self.assertRaisesRegex(hot.ControlError, 'OUTCOME_UNCERTAIN'):
                        hot.control(path, '/activate', {'expectedEpoch': 1, 'id': 'a' * 32})
                    self.assertEqual(len(calls), 1)
                finally:
                    server.shutdown(); thread.join(timeout=3)

    def test_private_state_rejects_shared_permissions_and_symlinks(self):
        with tempfile.TemporaryDirectory(prefix='mcp-private-state-test-') as tmp:
            path = Path(tmp) / 'state.json'
            hot.atomic_json(path, {'schema': 1})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(hot.read_json(path)['schema'], 1)
            link = path.with_name('link.json'); link.symlink_to(path)
            with self.assertRaises(hot.ControlError):
                hot.read_json(link)
            path.chmod(0o644)
            with self.assertRaises(hot.ControlError):
                hot.read_json(path)


if __name__ == '__main__':
    unittest.main(verbosity=2)
