"""Fresh desktop bootstrap tests. No actual service or tunnel is started."""
import importlib.util
import json
import pathlib
import socket
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

deploy = load('deploy-release')
installer = load('install-recovery')
TUNNEL = 'tunnel_' + 'c' * 32


def inputs(home):
    source = home / 'desktop-source'
    source.mkdir()
    key = source / 'chatgpt-mtp-tunnel.api'
    key.write_text("# original desktop key\nexport CONTROL_PLANE_API_KEY='desktop-test-value'\n")
    identity = source / 'chatgpt-mcp.tunnel'
    identity.write_text('CONTROL_PLANE_TUNNEL_ID="' + TUNNEL + '"\n')
    config = source / 'config.local.json'
    config.write_text(json.dumps({'http': {'host': '127.0.0.1', 'port': 3210, 'token': 'private-backend-token'},
                                 'filesystem': {'read': True, 'write': True, 'roots': [str(home)]},
                                 'shell': {'enabled': True, 'allowedCommands': ['node']}}))
    release = home / 'release'
    (release / 'scripts').mkdir(parents=True)
    (release / 'scripts/deploy-release.py').write_bytes((SCRIPTS / 'deploy-release.py').read_bytes())
    node = home / 'node'
    node.write_text('native node fixture')
    args = SimpleNamespace(profile=['desktop-restored=' + str(key)], tunnel_id_file=identity,
                           identity_verified_unused=True, health_port=None, bootstrap=True,
                           config=config, release=release, node=node, enable_jobs=True,
                           canary_directory=None, working_directory=None)
    return args


class BootstrapTests(unittest.TestCase):
    def test_reads_legacy_activation_without_evaluating_shell_syntax(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'value'
            for text in ['plain', 'VALUE="plain"', "export VALUE='plain'", '# comment\n\nplain\n']:
                path.write_text(text)
                self.assertEqual(deploy.read_activation_value(path), 'plain')
            path.write_text('VALUE="$(touch /no-command-is-executed)"')
            self.assertEqual(deploy.read_activation_value(path), '$(touch /no-command-is-executed)')
            for text in ['', 'one\ntwo', 'VALUE=""', 'x' * 32769]:
                path.write_text(text)
                with self.assertRaises(ValueError):
                    deploy.read_activation_value(path)

    def test_requires_verified_identity_and_new_local_alias(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            args = inputs(home)
            args.identity_verified_unused = False
            with self.assertRaisesRegex(ValueError, 'identity-verified-unused'):
                deploy.bootstrap_profile(args, home)
            args.identity_verified_unused = True
            profile = deploy.bootstrap_profile(args, home)
            self.assertEqual(profile['bootstrapTunnelId'], TUNNEL)
            self.assertIsNone(profile['original'])
            installed = home / '.config/tunnel-client/overdeck-host.yaml'
            installed.parent.mkdir(parents=True)
            installed.write_text('control_plane:\n  tunnel_id: ' + TUNNEL + '\n')
            with self.assertRaisesRegex(ValueError, 'existing profile'):
                deploy.bootstrap_profile(args, home)
            self.assertIn(TUNNEL, installed.read_text())

    def test_does_not_overwrite_existing_mcp_installation_or_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            args = inputs(home)
            for relative in ['.config/chatgpt-mcp/active.json', '.config/chatgpt-mcp/recovery.json',
                             '.config/systemd/user/chatgpt-mcp.service', '.config/tunnel-client/desktop-restored.yaml']:
                path = home / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('existing owner data')
                with self.assertRaisesRegex(ValueError, 'existing MCP/profile'):
                    deploy.bootstrap_profile(args, home)
                self.assertEqual(path.read_text(), 'existing owner data')
                path.unlink()
            alias = home / '.config/tunnel-client/desktop-restored.yaml'
            alias.symlink_to(home / 'missing-target')
            with self.assertRaisesRegex(ValueError, 'existing MCP/profile'):
                deploy.bootstrap_profile(args, home)

    def test_rejects_in_use_health_port_without_interfering_with_listener(self):
        with tempfile.TemporaryDirectory() as tmp, socket.socket() as listener:
            home = pathlib.Path(tmp)
            args = inputs(home)
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            args.health_port = listener.getsockname()[1]
            with self.assertRaisesRegex(ValueError, 'no free loopback'):
                deploy.bootstrap_profile(args, home)
            self.assertGreater(listener.fileno(), 0)

    def run_rollout(self, home, fail_poll=False):
        args = inputs(home)
        original_config = args.config.read_bytes()
        original_key = pathlib.Path(args.profile[0].partition('=')[2]).read_bytes()
        overdeck = home / '.config/tunnel-client/overdeck-host.yaml'
        overdeck.parent.mkdir(parents=True)
        overdeck.write_text('control_plane:\n  tunnel_id: tunnel_' + 'a' * 32 + '\n')
        other_unit = home / '.config/systemd/user/overdeck-mcp-tunnel.service'
        other_unit.parent.mkdir(parents=True)
        other_unit.write_text('separate live Overdeck deployment\n')
        tunnel = home / 'pinned/tunnel-client'
        tunnel.parent.mkdir()
        tunnel.write_text('pinned binary fixture')
        commands = []
        def systemctl(*values, **kwargs):
            commands.append(values)
            return SimpleNamespace(returncode=1 if values[0] == 'is-enabled' else 0, stdout='')
        def run(*values, **kwargs):
            if values[0] == str(tunnel):
                stage = pathlib.Path(values[values.index('--profile-dir') + 1])
                name = values[values.index('--profile') + 1]
                endpoint = values[values.index('--mcp-server-url') + 1]
                identity = values[values.index('--tunnel-id') + 1]
                (stage / (name + '.yaml')).write_text('config_version: 1\ncontrol_plane:\n  tunnel_id: ' + identity + '\nhealth:\n  listen_addr: "127.0.0.1:8180"\nmcp:\n  server_urls:\n    - channel: main\n      url: "' + endpoint + '"\n')
            elif values[0] == 'python3' and values[1].endswith('install-tunnel.py'):
                return SimpleNamespace(returncode=0, stdout=str(tunnel) + '\n')
            elif values[0] == 'python3' and values[1].endswith('install-recovery.py'):
                runtime = pathlib.Path(values[values.index('--runtime') + 1])
                name = values[values.index('--profile') + 1]
                health = values[values.index('--health-url') + 1]
                installer.install(runtime, name, health, home, enable=False)
            return SimpleNamespace(returncode=0, stdout='')
        evidence = {'runtime': {'release': 'b' * 40, 'configFingerprint': 'loaded-fingerprint'}, 'catalogCount': 28,
                    'writeCanary': 'passed', 'shellCanary': 'passed'}
        with mock.patch.object(deploy.pathlib.Path, 'home', return_value=home), \
             mock.patch.object(deploy, 'verify', return_value={'revision': 'b' * 40}), \
             mock.patch.object(deploy, 'systemctl', side_effect=systemctl), \
             mock.patch.object(deploy, 'run', side_effect=run), \
             mock.patch.object(deploy, 'free_port', return_value=3298), \
             mock.patch.object(deploy, 'validate', return_value={'finalBackend': evidence}), \
             mock.patch.object(deploy, 'wait_backend', return_value=evidence), \
             mock.patch.object(deploy, 'backend_probe', return_value=('HEALTHY', evidence)), \
             mock.patch.object(deploy, 'wait_idle') as idle, \
             mock.patch.object(deploy, 'wait_poll', side_effect=RuntimeError('poll unavailable') if fail_poll else None, return_value=1.0), \
             mock.patch.object(deploy.signal, 'signal'), mock.patch.object(deploy.signal, 'alarm'):
            if fail_poll:
                with self.assertRaisesRegex(RuntimeError, 'poll unavailable'):
                    deploy.deploy(args)
            else:
                deploy.deploy(args)
            idle.assert_not_called()
        self.assertEqual(args.config.read_bytes(), original_config)
        self.assertEqual(pathlib.Path(args.profile[0].partition('=')[2]).read_bytes(), original_key)
        self.assertEqual(other_unit.read_text(), 'separate live Overdeck deployment\n')
        self.assertEqual(overdeck.read_text(), 'control_plane:\n  tunnel_id: tunnel_' + 'a' * 32 + '\n')
        self.assertFalse(any(any('overdeck' in arg for arg in call) for call in commands))
        return commands

    def test_fresh_bootstrap_preserves_originals_authentication_and_overdeck(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            commands = self.run_rollout(home)
            active = json.loads((home / '.config/chatgpt-mcp/active.json').read_text())
            directory = pathlib.Path(active['deploymentDirectory'])
            plan = json.loads((directory / 'plan.json').read_text())
            self.assertTrue(plan['committed'])
            self.assertEqual(plan['newProfiles'], ['desktop-restored'])
            self.assertIn(('enable', 'chatgpt-mcp-tunnel-desktop-restored.service'), commands)
            self.assertNotIn(('disable', 'chatgpt-mcp.service'), commands)
            profile = (home / '.config/tunnel-client/desktop-restored.yaml').read_text()
            self.assertIn('extra_headers:', profile)
            self.assertIn('discovery_extra_headers:', profile)
            self.assertNotIn('private-backend-token', profile)
            self.assertNotIn('desktop-test-value', profile)
            self.assertEqual((directory / 'desktop-backend-authorization').read_text(), 'Bearer private-backend-token\n')
            self.assertEqual((directory / 'desktop-runtime-api-key').read_text(), 'desktop-test-value\n')
            self.assertEqual((directory / 'desktop-runtime-api-key').stat().st_mode & 0o777, 0o600)

    def test_failed_poll_rolls_back_only_new_tunnel(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            commands = self.run_rollout(home, fail_poll=True)
            self.assertFalse((home / '.config/chatgpt-mcp/active.json').exists())
            self.assertFalse((home / '.config/tunnel-client/desktop-restored.yaml').exists())
            self.assertFalse((home / '.config/systemd/user/chatgpt-mcp-tunnel-desktop-restored.service').exists())
            self.assertIn(('disable', '--now', 'chatgpt-mcp-tunnel-desktop-restored.service'), commands)
            self.assertNotIn(('restart', 'overdeck-mcp-tunnel.service'), commands)
            plan_path = next((home / '.local/state/chatgpt-mcp/deployments').glob('*/plan.json'))
            self.assertTrue(json.loads(plan_path.read_text())['rolledBack'])


if __name__ == '__main__':
    unittest.main()
