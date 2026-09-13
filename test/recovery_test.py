import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock
import fcntl
import sys

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import recovery

def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class RecoveryTests(unittest.TestCase):
    def test_poll_metric_scientific_notation_and_labels(self):
        sample = '# HELP commands_poll_last_successful_timestamp_seconds last poll\ncommands_poll_last_successful_timestamp_seconds{scope="controlplane"} 1.7e+03\n'
        self.assertEqual(recovery.poll_status(sample, 1710, 200), ('HEALTHY', 10))
        self.assertEqual(recovery.poll_status(sample, 1800, 200), ('TUNNEL_STALE', 100))

    def test_missing_future_and_startup_metrics(self):
        self.assertEqual(recovery.poll_status('', 1700, 10)[0], 'STARTING')
        self.assertEqual(recovery.poll_status('', 1700, 100)[0], 'METRICS_UNAVAILABLE')
        self.assertEqual(recovery.poll_status('commands_poll_last_successful_timestamp_seconds 9000', 1700, 100)[0], 'CLOCK_SKEW')
        self.assertEqual(recovery.poll_status('commands_poll_last_successful_timestamp_seconds NaN', 1700, 100)[0], 'METRICS_UNAVAILABLE')

    def test_confirm_before_restart(self):
        state, action = recovery.decision({}, 'TUNNEL_STALE', 1000)
        self.assertEqual(action, 'none')
        state, action = recovery.decision(state, 'TUNNEL_STALE', 1030)
        self.assertEqual(action, 'restart')
        self.assertEqual(state['restarts'], [1030])

    def test_restart_budget_and_circuit_survive_transient_success(self):
        state = {}
        actions = []
        for now in range(1000, 2000, 30):
            state, action = recovery.decision(state, 'TUNNEL_STALE', now)
            actions.append(action)
            if action == 'restart':
                state, _ = recovery.decision(state, 'HEALTHY', now + 1)
        self.assertEqual(actions.count('restart'), 3)
        self.assertEqual(state['phase'], 'circuit_open')
        # Low-rate probes can detect recovery, without deleting the hourly budget.
        state, _ = recovery.decision(state, 'HEALTHY', 2100)
        state, action = recovery.decision(state, 'HEALTHY', 2230)
        self.assertEqual(action, 'resolved')
        self.assertEqual(len(state['restarts']), 3)

    def test_circuit_allows_later_recovery_attempt(self):
        state = {'restarts': [100, 200, 300], 'failureStreak': 2, 'incidentOpen': True}
        state, action = recovery.decision(state, 'TUNNEL_STALE', 4000)
        self.assertEqual(action, 'restart')

    def test_permissions_and_overload_never_trigger_restart(self):
        for status in ['OVERLOADED', 'POLICY_MISMATCH', 'AUTH_FAILURE', 'CONFIG_INVALID', 'EXECUTION_FAILURE', 'CLOCK_SKEW']:
            state = {}
            for now in range(1000, 1300, 30):
                state, action = recovery.decision(state, status, now)
                self.assertNotEqual(action, 'restart', status)

    def test_tick_restarts_only_stale_tunnel_and_records_one_incident(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = {'stateDirectory': tmp, 'backendUnit': 'backend.service', 'profiles': [
                {'name': 'a', 'unit': 'tunnel-a.service', 'healthUrl': 'http://127.0.0.1:8080'},
                {'name': 'b', 'unit': 'tunnel-b.service', 'healthUrl': 'http://127.0.0.1:8081'}]}
            def response(url):
                stamp = 10 if ':8080/' in url else 1700
                return 'commands_poll_last_successful_timestamp_seconds ' + str(stamp)
            with mock.patch.object(recovery, 'backend_probe', return_value=('HEALTHY', {})), \
                 mock.patch.object(recovery, 'service_uptime', return_value=200), \
                 mock.patch.object(recovery, 'request', side_effect=response), \
                 mock.patch.object(recovery.time, 'time', return_value=1700), \
                 mock.patch.object(recovery.subprocess, 'run', return_value=mock.Mock(returncode=0)) as run:
                recovery.tick(settings)
                recovery.tick(settings)
                recovery.tick(settings)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args_list[0].args[0], ['systemctl', '--user', 'reset-failed', 'tunnel-a.service'])
            self.assertEqual(run.call_args.args[0][-1], 'tunnel-a.service')
            self.assertEqual(len(list((pathlib.Path(tmp) / 'incidents').glob('*.json'))), 1)

    def test_shared_lock_excludes_second_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(pathlib.Path(tmp) / 'recovery.lock', 'w') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(recovery.tick({'stateDirectory': tmp}), {'status': 'already_running'})

    def test_dry_run_does_not_spend_budget_or_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(recovery, 'backend_probe', return_value=('BACKEND_UNAVAILABLE', {})), \
                 mock.patch.object(recovery.subprocess, 'run') as run:
                recovery.tick({'stateDirectory': tmp}, dry_run=True)
                run.assert_not_called()
                self.assertFalse((pathlib.Path(tmp) / 'state.json').exists())

    def test_install_merges_profiles_and_preserves_configuration(self):
        installer = module('install-recovery')
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            runtime = home / 'runtime'
            runtime.mkdir()
            config = '{"filesystem":{"write":true,"read":true,"roots":["' + tmp + '"]},"shell":{"enabled":true},"http":{"port":3210,"token":"never-print-this"}}'
            (runtime / 'config.local.json').write_text(config)
            installer.install(runtime, 'a', 'http://127.0.0.1:8080', home, enable=False)
            installer.install(runtime, 'b', 'http://127.0.0.1:8081', home, enable=False)
            settings = json.loads((home / '.config/chatgpt-mcp/recovery.json').read_text())
            self.assertEqual([p['name'] for p in settings['profiles']], ['a', 'b'])
            self.assertEqual((runtime / 'config.local.json').read_text(), config)
            self.assertNotIn('never-print-this', json.dumps(settings))
            self.assertTrue((home / '.config/systemd/user/chatgpt-mcp-recovery.timer').exists())

    def test_pinned_installer_rejects_unknown_cached_identity(self):
        installer = module('install-tunnel')
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp)
            (target / 'manifest.json').write_text('{"version":"0.0.10","archiveSha256":"bad"}')
            with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                installer.install(target)


if __name__ == '__main__':
    unittest.main()
