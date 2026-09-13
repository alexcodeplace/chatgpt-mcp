"""Behavioral recovery checks with a real loopback HTTP fixture, never live services."""
import contextlib
import hashlib
import http.server
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import recovery


@contextlib.contextmanager
def fixture():
    calls = []
    shell_result = {'structuredContent': {'exitCode': 0, 'timedOut': False, 'stdout': 'mcp-shell-canary'}}
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def send(self, value, content_type='application/json'):
            data = (json.dumps(value) if content_type == 'application/json' else value).encode()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_GET(self):
            if self.path.endswith('/metrics'):
                stamp = 1 if '/stale/' in self.path else 1000
                self.send('commands_poll_last_successful_timestamp_seconds ' + str(stamp) + '\n', 'text/plain')
            elif self.path.endswith('/readyz'):
                self.send('ready', 'text/plain')
            else:
                self.send({'ok': True})
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if request['method'] == 'tools/list':
                result = {'tools': [{'name': name} for name in ['system.info', 'shell.exec']]}
            else:
                name = request['params']['name']
                calls.append(name)
                if name == 'system.info':
                    result = {'structuredContent': {'capabilities': {'shell': True, 'filesystemWrite': False},
                              'runtime': {'release': 'a' * 40, 'configFingerprint': 'fingerprint'}}}
                elif name == 'shell.exec':
                    result = shell_result
                else:
                    raise AssertionError('unexpected canary operation: ' + name)
            self.send({'jsonrpc': '2.0', 'id': request['id'], 'result': result})
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with tempfile.TemporaryDirectory() as tmp:
        directory = pathlib.Path(tmp)
        config = directory / 'config.json'
        config.write_text(json.dumps({'filesystem': {'write': False}, 'shell': {'enabled': True}}))
        base = 'http://127.0.0.1:' + str(server.server_port)
        settings = {'backendUrl': base, 'configPath': str(config), 'stateDirectory': str(directory / 'state'),
                    'backendUnit': 'fixture-backend.service', 'expectedTools': ['system.info', 'shell.exec'],
                    'expectedCapabilities': {'shell': True, 'filesystemWrite': False},
                    'shellCanary': {'command': 'node', 'args': ['-e', "process.stdout.write('mcp-shell-canary')"], 'expectedStdout': 'mcp-shell-canary'}}
        try:
            yield settings, calls, shell_result
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


class RecoveryAcceptanceTests(unittest.TestCase):
    def test_capability_declaration_is_not_a_substitute_for_execution(self):
        with fixture() as (settings, calls, _):
            status, evidence = recovery.backend_probe(settings, canary=True)
            self.assertEqual(status, 'HEALTHY')
            self.assertEqual(calls, ['system.info', 'shell.exec'])
            self.assertEqual(evidence['shellCanary'], 'passed')

    def test_shell_error_is_not_mislabeled_as_backend_down(self):
        with fixture() as (settings, _, shell):
            shell['structuredContent']['exitCode'] = 1
            self.assertEqual(recovery.backend_probe(settings, canary=True)[0], 'EXECUTION_FAILURE')
            shell.clear()
            shell.update({'isError': True, 'content': [{'text': json.dumps({'error': {'code': 'OVERLOADED'}})}]})
            self.assertEqual(recovery.backend_probe(settings, canary=True)[0], 'OVERLOADED')

    def test_shell_rpc_timeout_does_not_restart_a_responsive_backend(self):
        with fixture() as (settings, _, _):
            original = recovery.rpc
            def rpc(url, method, params=None, token=None):
                if params and params.get('name') == 'shell.exec':
                    raise TimeoutError('execution queue or runner did not respond')
                return original(url, method, params, token)
            with mock.patch.object(recovery, 'rpc', side_effect=rpc):
                status, _ = recovery.backend_probe(settings, canary=True)
                self.assertEqual(status, 'EXECUTION_FAILURE')
                state, _ = recovery.decision({}, status, 1000)
                _, action = recovery.decision(state, status, 1030)
                self.assertNotEqual(action, 'restart')

    def test_configuration_and_runtime_mismatch_do_not_change_permissions(self):
        with fixture() as (settings, calls, _):
            path = pathlib.Path(settings['configPath'])
            settings['expectedConfigSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            settings['expectedRuntime'] = {'release': 'a' * 40, 'configFingerprint': 'fingerprint'}
            self.assertEqual(recovery.backend_probe(settings)[0], 'HEALTHY')
            settings['expectedRuntime']['release'] = 'b' * 40
            self.assertEqual(recovery.backend_probe(settings)[0], 'RUNTIME_MISMATCH')
            path.write_text(path.read_text() + '\n')
            before = len(calls)
            self.assertEqual(recovery.backend_probe(settings)[0], 'CONFIG_CHANGED')
            self.assertEqual(len(calls), before)

    def test_green_readiness_and_stale_poll_recovers_only_the_affected_tunnel(self):
        with fixture() as (settings, _, _):
            base = settings['backendUrl']
            settings['profiles'] = [
                {'name': 'stale', 'unit': 'fixture-stale.service', 'healthUrl': base + '/stale'},
                {'name': 'fresh', 'unit': 'fixture-fresh.service', 'healthUrl': base + '/fresh'},
            ]
            self.assertEqual(recovery.request(base + '/stale/readyz'), 'ready')
            with mock.patch.object(recovery, 'service_uptime', return_value=500), \
                 mock.patch.object(recovery.time, 'time', return_value=1000), \
                 mock.patch.object(recovery.subprocess, 'run', return_value=mock.Mock(returncode=0)) as run:
                recovery.tick(settings)
                recovery.tick(settings)
                recovery.tick(settings)
            self.assertEqual([c.args[0] for c in run.call_args_list], [
                ['systemctl', '--user', 'reset-failed', 'fixture-stale.service'],
                ['systemctl', '--user', 'restart', '--no-block', 'fixture-stale.service'],
            ])

    def test_dependent_tunnels_are_not_restarted_for_configuration_or_execution_faults(self):
        for status in ['CONFIG_INVALID', 'CONFIG_CHANGED', 'AUTH_FAILURE', 'POLICY_MISMATCH', 'RUNTIME_MISMATCH', 'EXECUTION_FAILURE']:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp:
                settings = {'stateDirectory': tmp, 'profiles': [{'name': 'a', 'unit': 'fixture-a.service', 'healthUrl': 'http://fixture'}]}
                with mock.patch.object(recovery, 'backend_probe', return_value=(status, {})), \
                     mock.patch.object(recovery, 'service_uptime', return_value=500), \
                     mock.patch.object(recovery, 'request', return_value='commands_poll_last_successful_timestamp_seconds 1'), \
                     mock.patch.object(recovery.time, 'time', return_value=1000), \
                     mock.patch.object(recovery.subprocess, 'run') as run:
                    recovery.tick(settings)
                    recovery.tick(settings)
                    run.assert_not_called()

    def test_corrupt_state_does_not_reset_the_restart_budget(self):
        for damaged in ['{truncated', '[]', '{"components":null}', '{"components":{"backend":{"restarts":"bad"}}}']:
            with self.subTest(damaged=damaged), tempfile.TemporaryDirectory() as tmp:
                directory = pathlib.Path(tmp)
                (directory / 'state.json').write_text(damaged)
                with mock.patch.object(recovery, 'backend_probe', return_value=('BACKEND_UNAVAILABLE', {})), \
                     mock.patch.object(recovery.time, 'time', return_value=1000), \
                     mock.patch.object(recovery.subprocess, 'run') as run:
                    recovery.tick({'stateDirectory': tmp})
                    recovery.tick({'stateDirectory': tmp})
                    run.assert_not_called()
                state = json.loads((directory / 'state.json').read_text())
                self.assertEqual(state['components']['backend']['phase'], 'circuit_open')
                self.assertEqual(len(state['components']['backend']['restarts']), 3)
                self.assertEqual(json.loads((directory / 'state-recovery.json').read_text())['status'], 'STATE_INVALID')

    def test_dry_run_preserves_corrupt_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'state.json'
            path.write_text('{truncated')
            with mock.patch.object(recovery, 'backend_probe', return_value=('BACKEND_UNAVAILABLE', {})), \
                 mock.patch.object(recovery.subprocess, 'run') as run:
                recovery.tick({'stateDirectory': tmp}, dry_run=True)
                run.assert_not_called()
            self.assertEqual(path.read_text(), '{truncated')
            self.assertFalse((path.parent / 'state-recovery.json').exists())


class UpgradeAcceptanceTests(unittest.TestCase):
    def test_candidate_ledger_is_private_and_original_config_is_unchanged(self):
        spec = importlib.util.spec_from_file_location('candidate_deploy', SCRIPTS / 'deploy-release.py')
        deploy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deploy)
        original = {'jobs': {'enabled': True, 'directory': '/private/live-jobs', 'maxConcurrent': 2}, 'filesystem': {'roots': ['/private']}}
        staged = deploy.staging_config(original, pathlib.Path('/private/deployment'))
        self.assertEqual(staged['jobs']['directory'], '/private/deployment/canary-jobs')
        self.assertEqual(original['jobs']['directory'], '/private/live-jobs')
        self.assertEqual(staged['filesystem'], original['filesystem'])
        self.assertEqual(deploy.staging_config({'jobs': {'enabled': False}}, pathlib.Path('/private')), {'jobs': {'enabled': False}})


if __name__ == '__main__':
    unittest.main()
