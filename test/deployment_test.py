import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import release
from recovery import atomic_json

spec = importlib.util.spec_from_file_location('deploy_release', SCRIPTS / 'deploy-release.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def writable(root):
    if not root.exists():
        return
    for path in root.rglob('*'):
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() else 0o644)
    root.chmod(0o755)


class DeploymentTests(unittest.TestCase):
    def test_release_manifest_detects_edits_and_excludes_private_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / 'source'
            source.mkdir()
            for name in release.ALLOWED:
                path = source / name
                if name in ['dist/src', 'src', 'scripts', 'docs', 'node_modules']:
                    path.mkdir(parents=True, exist_ok=True)
                    (path / 'fixture').write_text('tracked artifact\n')
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text('{}\n')
            (source / 'dist/src/http.js').write_text('process.stdout.write("test");\n')
            (source / 'config.local.json').write_text('SECRET-MUST-NOT-BE-PACKAGED')
            (source / '.secrets').mkdir()
            (source / '.secrets/runtime-api-key').write_text('SECRET-KEY')
            (source / 'node_modules/alias').symlink_to('fixture')
            destination = pathlib.Path(tmp) / 'release'
            try:
                manifest = release.pack(source, destination, 'a' * 40)
                self.assertEqual(release.verify(destination)['revision'], 'a' * 40)
                self.assertNotIn('config.local.json', manifest['files'])
                self.assertFalse((destination / '.secrets').exists())
                self.assertEqual((destination / 'node_modules/alias').read_text(), 'tracked artifact\n')
                target = destination / 'dist/src/http.js'
                target.chmod(0o644)
                target.write_text('unreviewed change')
                with self.assertRaisesRegex(ValueError, 'content mismatch'):
                    release.verify(destination)
            finally:
                writable(destination)

    def test_release_rejects_external_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'release'
            root.mkdir()
            (root / 'escape').symlink_to('/etc/hosts')
            with self.assertRaisesRegex(ValueError, 'symlink escapes'):
                release.inventory(root)

    def test_rollback_restores_profiles_without_stopping_any_backend(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            profile = root / 'profile.yaml'
            profile.write_text('original profile\n')
            dropin = root / 'dropin.conf'
            plan = {'directory': str(root), 'lockPath': str(root / 'lock'), 'backendUnit': 'new-backend.service',
                    'previousBackendUnit': 'old-backend.service', 'previousBackendWasEnabled': True,
                    'files': [], 'touchedProfiles': ['example'], 'enabledLegacyTimers': ['old-watchdog.timer'], 'recoveryWasEnabled': False}
            deploy.backup(plan, profile)
            deploy.backup(plan, dropin)
            profile.write_text('candidate profile\n')
            dropin.write_text('candidate unit settings\n')
            with mock.patch.object(deploy, 'systemctl', return_value=mock.Mock(returncode=0)) as systemctl:
                deploy.rollback(root / 'plan.json')
                self.assertEqual(profile.read_text(), 'original profile\n')
                self.assertFalse(dropin.exists())
                commands = [call.args for call in systemctl.call_args_list]
                self.assertIn(('restart', 'chatgpt-mcp-tunnel-example.service'), commands)
                self.assertIn(('enable', 'old-backend.service'), commands)
                self.assertFalse(any('stop' in command and any('backend' in value for value in command) for command in commands))
                self.assertFalse(any(command[:3] == ('disable', '--now', 'new-backend.service') for command in commands))
                count = systemctl.call_count
                deploy.rollback(root / 'plan.json')
                self.assertEqual(systemctl.call_count, count, 'rollback must be idempotent')

    def test_armed_guard_does_not_rollback_a_committed_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'plan.json'
            atomic_json(path, {'committed': True})
            with mock.patch.object(deploy, 'systemctl') as systemctl:
                deploy.rollback(path)
                systemctl.assert_not_called()

    def test_drain_checks_both_worker_and_queue_occupancy(self):
        samples = [
            'dispatcher_worker_pool_occupancy 0\ncommands_queue_length 1\n',
            'dispatcher_worker_pool_occupancy 1\ncommands_queue_length 0\n',
            'dispatcher_worker_pool_occupancy 0\ncommands_queue_length 0\n',
        ]
        with mock.patch.object(deploy, 'request', side_effect=samples) as request, mock.patch.object(deploy.time, 'sleep'):
            deploy.wait_idle('http://127.0.0.1:8080')
            self.assertEqual(request.call_count, 3)

    def test_ready_without_a_fresh_poll_is_not_recovery(self):
        samples = ['commands_poll_last_successful_timestamp_seconds 100\n',
                   'commands_poll_last_successful_timestamp_seconds 995\n', 'ready']
        with mock.patch.object(deploy, 'request', side_effect=samples), mock.patch.object(deploy.time, 'time', return_value=1000), mock.patch.object(deploy.time, 'sleep'):
            self.assertEqual(deploy.wait_poll('http://127.0.0.1:8080'), 5)


if __name__ == '__main__':
    unittest.main()
