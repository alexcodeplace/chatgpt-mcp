import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
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
            subprocess.run(['git', 'init', '-q', str(source)], check=True)
            subprocess.run(['git', '-C', str(source), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(source), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixture'], check=True)
            revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
            destination = pathlib.Path(tmp) / 'release'
            try:
                with self.assertRaisesRegex(ValueError, 'revision does not match'):
                    release.pack(source, destination, 'a' * 40)
                (source / 'README.md').write_text('uncommitted source')
                with self.assertRaisesRegex(ValueError, 'not clean'):
                    release.pack(source, destination, revision)
                subprocess.run(['git', '-C', str(source), 'restore', 'README.md'], check=True)
                manifest = release.pack(source, destination, revision)
                self.assertEqual(release.verify(destination)['revision'], revision)
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

    def test_upgrade_preserves_the_running_backend_working_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            previous = root / 'original-runtime'
            previous.mkdir()
            with mock.patch.object(deploy, 'systemctl', return_value=mock.Mock(returncode=0, stdout=str(previous) + '\n')):
                self.assertEqual(deploy.working_directory(root / 'new-deployment/config.json', 'old.service'), previous)
                self.assertEqual(deploy.working_directory(root / 'config.json', 'old.service', root), root)

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'native systemd verifier unavailable')
    def test_native_unit_parser_accepts_generated_unit_and_rejects_quoted_working_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            work = root / 'directory with spaces'
            work.mkdir()
            runtime = root / 'xdg-runtime'
            runtime.mkdir(mode=0o700)
            env = {**os.environ, 'XDG_RUNTIME_DIR': str(runtime)}
            path = root / 'mcp-unit-fixture.service'
            text = deploy.backend_unit_text('a' * 40, root, work, root / 'config.json', pathlib.Path(shutil.which('node')))
            path.write_text(text)
            result = subprocess.run(['systemd-analyze', '--user', 'verify', str(path)], capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            path.write_text(text.replace('WorkingDirectory=' + str(work), 'WorkingDirectory="' + str(work) + '"'))
            invalid = subprocess.run(['systemd-analyze', '--user', 'verify', str(path)], capture_output=True, text=True, env=env)
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn('path is not absolute', invalid.stderr)

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
