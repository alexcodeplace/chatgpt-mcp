import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeCommand, authorizeHostDisplaySafeInvocation, clampOutput, clampRuntime, nonInteractiveShellArgs, nonInteractiveShellEnvironment } from '../src/policy/shell.js';

const policy = {
  enabled: true,
  allowedCommands: ['git', 'node'],
  maxRuntimeMs: 10_000,
  maxOutputBytes: 4096,
} as const;

const wildcardPolicy = { ...policy, allowedCommands: ['*'] } as const;
const isCommandNotAllowed = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'COMMAND_NOT_ALLOWED';

test('allowed executable passes', () => {
  assert.doesNotThrow(() => authorizeCommand('git', [], policy));
});

test('disabled shell rejects before command inspection', () => {
  assert.throws(() => authorizeCommand('git', [], { ...policy, enabled: false }), (error: unknown) => {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'CAPABILITY_DISABLED';
  });
});

test('unlisted executable rejects', () => {
  assert.throws(() => authorizeCommand('rm', [], policy), (error: unknown) => {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'COMMAND_NOT_ALLOWED';
  });
});

test('wildcard and exact path grants allow executable paths without expanding name-only grants', () => {
  for (const command of ['/usr/bin/git', './scripts/inspect', '../tools/inspect']) {
    assert.doesNotThrow(() => authorizeCommand(command, [], wildcardPolicy));
    assert.doesNotThrow(() => authorizeCommand(command, [], { ...policy, allowedCommands: [command] }));
    assert.throws(() => authorizeCommand(command, [], policy), isCommandNotAllowed);
  }
  for (const command of ['', 'git\0status']) {
    assert.throws(() => authorizeCommand(command, [], wildcardPolicy), isCommandNotAllowed);
  }
});

test('executable paths retain explicit agent, privilege and host-display blocks', () => {
  for (const command of ['/usr/bin/codex', './claudex', '/usr/bin/sudo', './pkexec']) {
    assert.throws(() => authorizeCommand(command, [], wildcardPolicy), isCommandNotAllowed);
  }
  for (const command of ['/usr/bin/grim', './scrot']) {
    assert.throws(() => authorizeHostDisplaySafeInvocation(command, [], false), isCommandNotAllowed);
  }
  assert.throws(() => authorizeHostDisplaySafeInvocation('/bin/bash', ['-c', 'grim /tmp/image.png'], false), isCommandNotAllowed);
  assert.doesNotThrow(() => authorizeHostDisplaySafeInvocation('/usr/bin/git', ['status'], false));
});

test('explicit wildcard allows executable names', () => {
  assert.doesNotThrow(() => authorizeCommand('printf', [], { ...policy, allowedCommands: ['*'] }));
});

test('runtime and output values clamp to configured maxima', () => {
  assert.equal(clampRuntime(undefined, 100), 100);
  assert.equal(clampRuntime(1000, 100), 100);
  assert.equal(clampRuntime(0, 100), 1);
  assert.equal(clampOutput(undefined, 200), 200);
  assert.equal(clampOutput(1000, 200), 200);
  assert.equal(clampOutput(0, 200), 1);
});


test('host display denial blocks obvious direct capture executables', () => {
  for (const command of ['grim', 'gnome-screenshot', 'scrot', 'maim', 'xwd', 'flameshot', 'spectacle', 'import']) {
    assert.throws(() => authorizeHostDisplaySafeInvocation(command, [], false), (error: unknown) =>
      typeof error === 'object' && error !== null && (error as { code?: string }).code === 'COMMAND_NOT_ALLOWED');
  }
});

test('host display denial blocks obvious wrapped and multipurpose capture invocations', () => {
  const cases: Array<[string, string[]]> = [
    ['ffmpeg', ['-f', 'x11grab', '-i', ':0', 'out.png']],
    ['gst-launch-1.0', ['ximagesrc', '!', 'pngenc', '!', 'filesink', 'location=out.png']],
    ['bash', ['-lc', 'grim /tmp/shot.png']],
    ['env', ['ffmpeg', '-f', 'x11grab', '-i', ':0', 'out.png']],
    ['gdbus', ['call', '--dest', 'org.gnome.Shell.Screenshot']],
    ['magick', ['import', '-window', 'root', 'shot.png']],
  ];
  for (const [command, args] of cases) {
    assert.throws(() => authorizeHostDisplaySafeInvocation(command, args, false), (error: unknown) =>
      typeof error === 'object' && error !== null && (error as { code?: string }).code === 'COMMAND_NOT_ALLOWED');
  }
});

test('host display denial blocks obvious Python and JavaScript capture one-liners', () => {
  const cases: Array<[string, string[]]> = [
    ['python3', ['-c', 'import pyautogui; pyautogui.screenshot()']],
    ['python3', ['-c', 'from PIL import ImageGrab; ImageGrab.grab()']],
    ['python3', ['-c', 'import mss; mss.mss().grab({"top":0,"left":0,"width":100,"height":100})']],
    ['node', ['-e', 'require("screenshot-desktop")().then(console.log)']],
    ['node', ['-e', 'desktopCapturer.getSources({types:["screen"]})']],
    ['python3', ['-c', 'from Xlib import display; d=display.Display(); d.screen().root.get_image(0,0,100,100,0xffffffff,2)']],
    ['env', ['DISPLAY=:0', 'python3', '-c', 'print(1)']],
  ];
  for (const [command, args] of cases) {
    assert.throws(() => authorizeHostDisplaySafeInvocation(command, args, false), (error: unknown) =>
      typeof error === 'object' && error !== null && (error as { code?: string }).code === 'COMMAND_NOT_ALLOWED');
  }
});

test('host display guard preserves ordinary shell, Python, Node, and ffmpeg work', () => {
  assert.doesNotThrow(() => authorizeHostDisplaySafeInvocation('python3', ['-c', 'print(1 + 1)'], false));
  assert.doesNotThrow(() => authorizeHostDisplaySafeInvocation('node', ['-e', 'console.log(2)'], false));
  assert.doesNotThrow(() => authorizeHostDisplaySafeInvocation('bash', ['-lc', 'printf ok'], false));
  assert.doesNotThrow(() => authorizeHostDisplaySafeInvocation('bash', ['-lc', "python3 - <<'PY'\nimport json\nfrom pathlib import Path\nprint(json.dumps({'path': str(Path('.'))}))\nPY"], false));
  assert.doesNotThrow(() => authorizeHostDisplaySafeInvocation('bash', ['-lc', "printf '%s\n' 'documentation says import json'"], false));
  assert.throws(() => authorizeHostDisplaySafeInvocation('bash', ['-lc', 'import /tmp/shot.png'], false), isCommandNotAllowed);
  assert.throws(() => authorizeHostDisplaySafeInvocation('env', ['import', '-window', 'root', '/tmp/shot.png'], false), isCommandNotAllowed);
  assert.doesNotThrow(() => authorizeHostDisplaySafeInvocation('ffmpeg', ['-i', 'input.mp4', '-c:v', 'copy', 'output.mp4'], false));
  assert.doesNotThrow(() => authorizeHostDisplaySafeInvocation('grim', [], true));
});


test('direct agent launch is blocked', () => {
  for (const name of ['claudex', 'claude', 'cdx', 'codex', 'factory']) {
    assert.throws(() => authorizeCommand(name, [], wildcardPolicy), isCommandNotAllowed, name);
  }
});

test('agent launch via shell wrapper is blocked', () => {
  assert.throws(() => authorizeCommand('bash', ['-c', 'cd /tmp && claudex -p "do it"'], wildcardPolicy), isCommandNotAllowed);
  assert.throws(() => authorizeCommand('sh', ['-c', 'codex -p "run task"'], wildcardPolicy), isCommandNotAllowed);
});

test('agent launch via wrappers is blocked', () => {
  assert.throws(() => authorizeCommand('env', ['FOO=bar', 'claudex'], wildcardPolicy), isCommandNotAllowed);
  assert.throws(() => authorizeCommand('nohup', ['factory'], wildcardPolicy), isCommandNotAllowed);
  assert.throws(() => authorizeCommand('systemd-run', ['--user', 'cdx'], wildcardPolicy), isCommandNotAllowed);
  assert.throws(() => authorizeCommand('tmux', ['send-keys', 'claudex', 'Enter'], wildcardPolicy), isCommandNotAllowed);
});

test('ordinary commands and blocked-word filenames still pass', () => {
  assert.doesNotThrow(() => authorizeCommand('git', ['status', '--short'], policy));
  assert.doesNotThrow(() => authorizeCommand('cat', ['notes-about-claudex.txt'], wildcardPolicy));
});


test('interactive privilege escalation commands are refused without blocking deck-sudo', () => {
  for (const name of ['sudo', 'su', 'pkexec']) {
    assert.throws(() => authorizeCommand(name, ['true'], wildcardPolicy), isCommandNotAllowed, name);
  }
  assert.doesNotThrow(() => authorizeCommand('deck-sudo', ['true'], wildcardPolicy));
  assert.throws(() => authorizeCommand('bash', ['-lc', 'sudo systemctl restart example.service'], wildcardPolicy), isCommandNotAllowed);
  assert.throws(() => authorizeCommand('ssh', ['debian3', 'sudo', 'true'], wildcardPolicy), isCommandNotAllowed);
  assert.throws(() => authorizeCommand('ssh', ['debian3', "sh -lc 'sudo true'"], wildcardPolicy), isCommandNotAllowed);
});

test('ssh execution is forced to non-interactive authentication', () => {
  assert.deepEqual(
    nonInteractiveShellArgs('ssh', ['debian1', 'hostname']),
    ['-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0', 'debian1', 'hostname'],
  );
  assert.deepEqual(nonInteractiveShellArgs('git', ['status']), ['status']);
  const env = nonInteractiveShellEnvironment({ PATH: '/bin', SSH_ASKPASS_REQUIRE: 'force', GIT_TERMINAL_PROMPT: '1' });
  assert.equal(env?.SSH_ASKPASS_REQUIRE, 'never');
  assert.equal(env?.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env?.SUDO_ASKPASS, '/bin/false');
});
