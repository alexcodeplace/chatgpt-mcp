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


class RouterExecutableReconciliationTests(unittest.TestCase):
    def test_deleted_expected_node_restarts_only_router_after_idle_boundary(self):
        with fixture() as f:
            snapshot = copy.deepcopy(f.route.value)
            f.state['profiles'] = [{'name': 'p1', 'unit': 'tunnel-one.service'},
                                   {'name': 'p2', 'unit': 'tunnel-two.service'}]
            entry = str(Path(f.state['router']['releaseDirectory']) / 'dist/src/hotswap/main.js').encode()
            pauses = []
            resumes = []
            pids = {'tunnel-one.service': 81001, 'tunnel-two.service': 81002,
                    f.state['ingress']['unit']: 81003}
            def pause(unit):
                item = {'unit': unit, 'pid': pids[unit]}
                pauses.append(item)
                return item
            restarted = {**snapshot, 'routerPid': snapshot['routerPid'] + 1}
            with mock.patch.object(deploy, '_deleted_expected_executable', return_value=True), \
                 mock.patch.object(deploy, '_router_command', return_value=[b'/usr/bin/node', entry]), \
                 mock.patch.object(deploy, '_pause_unit', side_effect=pause), \
                 mock.patch.object(deploy, '_resume_unit', side_effect=lambda item: resumes.append(item)), \
                 mock.patch.object(deploy, '_wait_router_idle', side_effect=[snapshot, snapshot]), \
                 mock.patch.object(deploy, 'wait_control', return_value=restarted), \
                 mock.patch.object(deploy.stager, 'systemctl') as systemctl:
                result = deploy._reconcile_deleted_router_executable(f.home, f.state, snapshot)
            self.assertEqual(result['routerPid'], restarted['routerPid'])
            systemctl.assert_called_once_with('restart', f.state['router']['unit'])
            self.assertEqual([item['unit'] for item in pauses],
                             ['tunnel-one.service', 'tunnel-two.service', f.state['ingress']['unit']])
            self.assertEqual(resumes, [pauses[2], pauses[0], pauses[1]])

    def test_router_reconcile_refuses_nonmatching_deleted_executable(self):
        with fixture() as f:
            snapshot = copy.deepcopy(f.route.value)
            with mock.patch.object(deploy, '_deleted_expected_executable', return_value=False), \
                 mock.patch.object(deploy.stager, 'systemctl') as systemctl:
                with self.assertRaisesRegex(hot.ControlError, 'PROVENANCE_MISMATCH'):
                    deploy._reconcile_deleted_router_executable(f.home, f.state, snapshot)
            systemctl.assert_not_called()


class DeploymentTests(unittest.TestCase):
    def test_generation_descriptor_preserves_rebound_instance(self):
        item = {'id': 'a' * 32, 'instanceId': 'b' * 32, 'url': 'http://127.0.0.1:31001',
                'revision': 'c' * 40, 'unit': 'backend-a.service', 'policyFingerprint': 'd' * 64}
        self.assertEqual(deploy._generation_descriptor(item)['instanceId'], item['instanceId'])

    def test_candidate_uses_enrollment_target_config_not_stale_active_config(self):
        with fixture() as f:
            desired = f.home / 'desired-config.json'
            hot.atomic_json(desired, {'http': {'port': 39999}, 'filesystem': {'read': True, 'write': True, 'roots': [str(f.home)],
                'blocklist': [{'path': str(f.home / 'secret.token'), 'mode': 'deny-read'}]}, 'keyManager': {'enabled': True}})
            f.target['configPath'] = str(desired)
            loaded = deploy.desired_config(f.target)
            self.assertTrue(loaded['keyManager']['enabled'])
            self.assertEqual(loaded['filesystem']['blocklist'][0]['mode'], 'deny-read')
            self.assertNotIn('keyManager', hot.read_json(f.active['configPath']))

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

    def _policy_maintenance_fixture(self, f, inventory_ok=True):
        f.b['generation']['policyFingerprint'] = '2' * 64
        f.state['generations'][f.b['generation']['id']] = f.b
        f.state['profiles'] = [{'name': 'profile', 'unit': 'tunnel.service', 'healthUrl': 'http://127.0.0.1:8080'}]
        hot.atomic_json(hot.state_path(f.home), f.state)
        registry_path = f.root / 'registry.json'
        old_registry = {'schema': 1, 'epoch': 4, 'active': f.a['generation']['id'], 'previous': None,
                        'legacyOwner': f.a['generation']['id'], 'generations': [copy.deepcopy(f.a['generation'])]}
        hot.atomic_json(registry_path, old_registry)
        old_config = hot.read_json(f.a['settings']['configPath'])
        hot.atomic_json(f.state['router']['configPath'], old_config)
        services = {'tunnel.service': 73101, f.a['generation']['unit']: 73102}
        router_pid = {'value': 73103}
        service_calls = []

        def unit(name):
            pid = services.get(name)
            if pid is None:
                return {'ActiveState': 'active', 'MainPID': str(router_pid['value'])}
            return {'ActiveState': 'active', 'MainPID': str(pid)}

        def systemctl(*args, **kwargs):
            service_calls.append(args)
            if args[:2] == ('stop', f.state['router']['unit']):
                router_pid['value'] += 1
            return SimpleNamespace(returncode=0, stdout='', stderr='')

        def control(socket_path, path='/status', data=None):
            registry = hot.read_json(registry_path)
            if path == '/inventory':
                return {'instanceId': data['id'] if inventory_ok else 'f' * 32}
            return {**registry, 'routerPid': router_pid['value'],
                    'generations': [{**item, 'inFlight': 0,
                                     'ownership': 'legacy-retained' if item.get('legacy') else 'query-backend-inventory'}
                                    for item in registry['generations']]}

        before = [{'name': 'profile', 'unit': 'tunnel.service', 'pid': 73101,
                   'profileSha256': '3' * 64, 'unitSha256': {'x': '4' * 64}}]
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(deploy, 'unit_state', side_effect=unit))
        stack.enter_context(mock.patch.object(deploy.stager, 'systemctl', side_effect=systemctl))
        stack.enter_context(mock.patch.object(deploy, 'control', side_effect=control))
        stack.enter_context(mock.patch.object(hot, 'control', side_effect=control))
        stack.enter_context(mock.patch.object(deploy, 'ensure_router', side_effect=lambda *_: control('socket')))
        stack.enter_context(mock.patch.object(deploy, 'profiles_snapshot', return_value=before))
        stack.enter_context(mock.patch.object(deploy.stager, 'wait_poll'))
        stack.enter_context(mock.patch.object(deploy.stager, 'run',
                                              return_value=SimpleNamespace(returncode=0, stdout='', stderr='')))
        return SimpleNamespace(stack=stack, before=before, old_registry=old_registry, old_config=old_config,
                               registry_path=registry_path, calls=service_calls,
                               active={**f.active, 'profiles': f.state['profiles']},
                               ingress={'pid': services[f.a['generation']['unit']]})

    def test_policy_maintenance_preserves_ingress_and_tunnel_pids_and_restarts_only_router(self):
        with fixture() as f:
            seam = self._policy_maintenance_fixture(f)
            with seam.stack:
                result = deploy.policy_maintenance(f.home, f.state, seam.active, f.b, seam.before, seam.ingress)
            self.assertEqual(result['status'], 'policy-maintenance-cutover')
            self.assertTrue(result['routerRestarted'])
            self.assertEqual(result['ingressPid'], 73102)
            self.assertEqual(result['tunnels'][0]['pid'], 73101)
            registry = hot.read_json(seam.registry_path)
            self.assertEqual(registry['active'], f.b['generation']['id'])
            self.assertIsNone(registry['previous'])
            self.assertEqual(set(registry['generations'][0]), {'id', 'url', 'revision', 'unit', 'policyFingerprint', 'legacy'})
            signals = [call for call in seam.calls if call and call[0] == 'kill']
            self.assertEqual(sum('--signal=SIGSTOP' in call for call in signals), 2)
            self.assertEqual(sum('--signal=SIGCONT' in call for call in signals), 2)
            self.assertFalse(any(call[:2] == ('restart', 'tunnel.service') for call in seam.calls))
            plan = hot.read_json(Path(f.b['deploymentDirectory']) / 'policy-maintenance-plan.json')
            self.assertTrue(plan['committed'])
            self.assertFalse(plan['rolledBack'])
            self.assertTrue(any(call[:2] == ('stop', plan['guardUnit'] + '.timer') for call in seam.calls))

    def test_policy_maintenance_failed_precommit_validation_restores_old_policy_before_resume(self):
        with fixture() as f:
            seam = self._policy_maintenance_fixture(f, inventory_ok=False)
            with seam.stack:
                with self.assertRaisesRegex(hot.ControlError, 'CANDIDATE_MISMATCH'):
                    deploy.policy_maintenance(f.home, f.state, seam.active, f.b, seam.before, seam.ingress)
            self.assertEqual(hot.read_json(seam.registry_path), seam.old_registry)
            self.assertEqual(hot.read_json(f.state['router']['configPath']), seam.old_config)
            active = hot.read_json(f.home / '.config/chatgpt-mcp/active.json')
            self.assertEqual(active['revision'], f.a['generation']['revision'])
            signals = [call for call in seam.calls if call and call[0] == 'kill']
            self.assertGreaterEqual(sum('--signal=SIGSTOP' in call for call in signals), 2)
            self.assertEqual(sum('--signal=SIGCONT' in call for call in signals), 2)
            plan = hot.read_json(Path(f.b['deploymentDirectory']) / 'policy-maintenance-plan.json')
            self.assertTrue(plan['rolledBack'])
            self.assertFalse(plan['committed'])

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

    def test_reboot_rebind_requires_changed_boot_identity(self):
        with fixture() as f:
            f.state['generations'] = {f.b['generation']['id']: f.b}
            status = {'epoch': 7, 'active': f.b['generation']['id'], 'previous': None, 'routerPid': 81001,
                      'generations': [copy.deepcopy(f.b['generation'])]}
            hot.atomic_json(f.root / 'selection-observation.json',
                            {'epoch': 6, 'active': f.b['generation']['id'], 'previous': None,
                             'revision': f.b['generation']['revision'], 'routerPid': 80001,
                             'bootId': '11111111-1111-1111-1111-111111111111'})
            with mock.patch.object(hot, 'current_boot_id', return_value='11111111-1111-1111-1111-111111111111'), \
                 mock.patch.object(hot, 'backend', side_effect=AssertionError('same-boot backend must not be adopted')):
                self.assertIsNone(hot.rebind_generation_after_reboot(f.home, f.state, status, status['active']))

    def test_reboot_rebind_missing_observation_fails_closed(self):
        with fixture() as f:
            status = {'epoch': 7, 'active': f.b['generation']['id'], 'previous': None, 'routerPid': 81001}
            with mock.patch.object(hot, 'current_boot_id', return_value='22222222-2222-2222-2222-222222222222'):
                self.assertFalse(hot.reboot_rebind_allowed(f.state, status))

    def test_reboot_rebind_adopts_exact_idle_systemd_backend_without_changing_generation(self):
        with fixture() as f:
            generation = copy.deepcopy(f.b['generation'])
            stable = generation['id']
            live = 'c' * 32
            f.state['generations'] = {stable: {**f.b, 'generation': generation}}
            status = {'epoch': 7, 'active': stable, 'previous': None, 'routerPid': 81001,
                      'generations': [copy.deepcopy(generation)]}
            hot.atomic_json(f.root / 'selection-observation.json',
                            {'epoch': 6, 'active': stable, 'previous': None,
                             'revision': generation['revision'], 'routerPid': 80001,
                             'bootId': '11111111-1111-1111-1111-111111111111'})
            observation = {
                'instanceId': live,
                'routingAbi': 1,
                'jobsAbi': 1,
                'policyFingerprint': generation['policyFingerprint'],
                'runtime': {'release': generation['revision'], 'pid': 81234},
                'resources': {'applications': 0, 'recordings': 0},
                'exchanges': 0,
                'activeCalls': 0,
                'queuedCalls': 0,
                'fenced': False,
            }
            calls = []
            def control(socket_path, path='/status', data=None):
                calls.append((path, copy.deepcopy(data)))
                if path == '/rebind':
                    self.assertEqual(data, {'expectedEpoch': 7, 'id': stable, 'instanceId': live})
                    return {'epoch': 8}
                if path == '/status':
                    return {**status, 'epoch': 8,
                            'generations': [{**generation, 'instanceId': live}]}
                raise AssertionError(path)
            with mock.patch.object(hot, 'current_boot_id', return_value='22222222-2222-2222-2222-222222222222'), \
                 mock.patch.object(hot, 'backend', return_value=observation), \
                 mock.patch.object(hot, 'unit_main_pid', return_value=81234), \
                 mock.patch.object(hot, 'control', side_effect=control), \
                 mock.patch.object(hot, 'publish_selection', return_value={'revision': generation['revision']}) as publish:
                result = hot.rebind_generation_after_reboot(f.home, f.state, status, stable)
            self.assertEqual(result['action'], 'generation_rebind')
            self.assertEqual(result['generation'], stable)
            self.assertEqual(result['instanceId'], live)
            self.assertIn(('/rebind', {'expectedEpoch': 7, 'id': stable, 'instanceId': live}), calls)
            publish.assert_called_once()

    def test_reboot_rebind_refuses_live_owned_resources(self):
        generation = {'id': 'a' * 32, 'unit': 'backend-a.service', 'revision': 'b' * 40,
                      'policyFingerprint': 'c' * 64}
        observation = {
            'instanceId': 'd' * 32,
            'policyFingerprint': generation['policyFingerprint'],
            'runtime': {'release': generation['revision'], 'pid': 81234},
            'resources': {'applications': 1, 'recordings': 0},
            'exchanges': 0, 'activeCalls': 0, 'queuedCalls': 0, 'fenced': False,
        }
        with mock.patch.object(hot, 'unit_main_pid', side_effect=AssertionError('owned backend must fail before unit adoption')):
            with self.assertRaisesRegex(hot.ControlError, 'REBIND_REQUIRES_IDLE_BACKEND'):
                hot.rebindable_backend(generation, observation)

    def test_reboot_rebind_refuses_wrong_systemd_main_pid(self):
        generation = {'id': 'a' * 32, 'unit': 'backend-a.service', 'revision': 'b' * 40,
                      'policyFingerprint': 'c' * 64}
        observation = {
            'instanceId': 'd' * 32,
            'policyFingerprint': generation['policyFingerprint'],
            'runtime': {'release': generation['revision'], 'pid': 81234},
            'resources': {'applications': 0, 'recordings': 0},
            'exchanges': 0, 'activeCalls': 0, 'queuedCalls': 0, 'fenced': False,
        }
        with mock.patch.object(hot, 'unit_main_pid', return_value=99999):
            with self.assertRaisesRegex(hot.ControlError, 'GENERATION_UNIT_IDENTITY_MISMATCH'):
                hot.rebindable_backend(generation, observation)

    def test_active_rebind_failure_still_allows_previous_generation_rollback(self):
        with fixture() as f:
            settings = {'hotSwap': {'statePath': str(hot.state_path(f.home))}}
            status = {'epoch': 7, 'active': f.b['generation']['id'], 'previous': f.a['generation']['id'],
                      'routerPid': 81001, 'generations': []}
            with mock.patch.object(hot, 'control', return_value=status), \
                 mock.patch.object(hot, 'rebind_generation_after_reboot',
                                   side_effect=[hot.ControlError('ACTIVE_REBIND_FAILED'), None]) as rebind, \
                 mock.patch.object(hot, 'select',
                                   return_value={'state': 'selected', 'revision': f.a['generation']['revision'],
                                                 'activeGeneration': f.a['generation']['id'],
                                                 'previousGeneration': f.b['generation']['id'],
                                                 'epoch': 8, 'routerPid': 81001}) as rollback, \
                 mock.patch.object(hot.subprocess, 'run', side_effect=AssertionError('rollback must win')):
                result = hot.recover_backend(settings)
            self.assertEqual(result['action'], 'route_rollback')
            self.assertTrue(result['accepted'])
            self.assertEqual(rebind.call_count, 2)
            rollback.assert_called_once_with(f.home)

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
