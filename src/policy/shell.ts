import { realpathSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, parse } from 'node:path';
import { adapterError } from '../errors.js';


const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_VALUE_BYTES = 32 * 1024;
const HOST_DISPLAY_ENV_KEYS = new Set(['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'MIR_SOCKET', 'DBUS_SESSION_BUS_ADDRESS']);

export function sanitizeHostDisplayEnvironment(env: NodeJS.ProcessEnv, hostDisplayAccess: boolean): NodeJS.ProcessEnv {
  if (hostDisplayAccess) return env;
  const sanitized = { ...env };
  for (const key of HOST_DISPLAY_ENV_KEYS) delete sanitized[key];
  return sanitized;
}

export function validateShellEnvironment(
  env: Readonly<Record<string, string>> | undefined,
  allowEnvironment: boolean,
  hostDisplayAccess: boolean,
  inheritProcessEnvironment = true,
): NodeJS.ProcessEnv | undefined {
  const base = inheritProcessEnvironment ? { ...process.env } : {};
  if (env === undefined) return sanitizeHostDisplayEnvironment(base, hostDisplayAccess);
  if (!allowEnvironment) {
    throw adapterError('CAPABILITY_DISABLED', 'shell.exec', 'Caller-provided environment variables are disabled.');
  }
  const entries = Object.entries(env);
  if (entries.length > MAX_ENV_ENTRIES) {
    throw adapterError('INVALID_INPUT', 'shell.exec', 'Too many caller-provided environment variables.', { maximum: MAX_ENV_ENTRIES });
  }
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key) || Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE_BYTES) {
      throw adapterError('INVALID_INPUT', 'shell.exec', 'Invalid caller-provided environment variable.', { key });
    }
    if (!hostDisplayAccess && HOST_DISPLAY_ENV_KEYS.has(key)) {
      throw adapterError('CAPABILITY_DISABLED', 'shell.exec', 'Host display environment access is disabled.', { key });
    }
  }
  return sanitizeHostDisplayEnvironment({ ...base, ...env }, hostDisplayAccess);
}

const HOST_CAPTURE_EXECUTABLES = new Set([
  'deepin-screenshot',
  'flameshot',
  'gnome-screenshot',
  'gnome-shell-screenshot',
  'grim',
  'grimshot',
  'import',
  'ksnip',
  'maim',
  'mate-screenshot',
  'scrot',
  'shutter',
  'spectacle',
  'wf-recorder',
  'wl-screenrec',
  'xwd',
  'xfce4-screenshooter',
]);

const SHELL_OR_WRAPPER_EXECUTABLES = new Set([
  'bash', 'dash', 'env', 'fish', 'nice', 'nohup', 'setsid', 'sh', 'stdbuf', 'sudo', 'timeout', 'zsh',
]);

const HIGH_SIGNAL_HOST_CAPTURE_PATTERNS: readonly RegExp[] = [
  /\bx11grab\b/i,
  /\bkmsgrab\b/i,
  /\bximagesrc\b/i,
  /\borg\.gnome\.Shell\.Screenshot\b/i,
  /\borg\.freedesktop\.portal\.Screenshot\b/i,
  /\borg\.kde\.(?:KWin\.ScreenShot2|kwin\.Screenshot)\b/i,
  /\b(?:pyautogui|pyscreeze|pyscreenshot)\b/i,
  /\bPIL\.ImageGrab\b/i,
  /\bImageGrab\.grab\s*\(/i,
  /\bmss\s*\.\s*mss\s*\(/i,
  /\b(?:screenshot-desktop|desktop-screenshot|node-screenshots)\b/i,
  /\bdesktopCapturer\s*\.\s*getSources\s*\(/i,
  /\brobotjs\b[^\n]{0,160}\bscreen\s*\.\s*capture\b/i,
  /\bXGetImage\b|\bXShmGetImage\b|\bxcb_get_image\b/i,
  /\blibX11(?:\.so(?:\.\d+)*)?\b/i,
  /\bXlib\b[^\n]{0,200}\b(?:Display|get_image)\b/i,
  /\b(?:require\s*\(\s*['\"]x11['\"]|from\s+['\"]x11['\"])\b/i,
  /\bpixbuf_get_from_window\b/i,
  /(?:^|\s)DISPLAY\s*=\s*:\d+(?:\.\d+)?(?:\s|$)/i,
  /\/tmp\/\.X11-unix\/X\d+\b/i,
];

const WRAPPED_CAPTURE_COMMAND = /(?:^|[\s;&|()])(?:deepin-screenshot|flameshot|gnome-screenshot|gnome-shell-screenshot|grim|grimshot|ksnip|maim|mate-screenshot|scrot|shutter|spectacle|wf-recorder|wl-screenrec|xwd|xfce4-screenshooter)(?=$|[\s;&|()])/i;
const WRAPPED_IMAGEMAGICK_IMPORT = /(?:^|(?:&&|\|\||[;()])\s*)import(?=\s+(?:(?:-(?:window|screen|frame|silent|snaps|monitor|pause|quality|resize|crop|display|density)\b)|[^;\n|()]*\.(?:png|jpe?g|gif|webp|bmp|tiff?)\b))/i;

export interface ShellLimits {
  enabled: boolean;
  allowedCommands: readonly string[];
  maxRuntimeMs: number;
  maxOutputBytes: number;
}

const BLOCKED_AGENT_EXECUTABLES = new Set(['claudex', 'claude', 'cdx', 'codex', 'factory']);
const WRAPPER_EXECUTABLES = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'env', 'nohup', 'systemd-run', 'tmux']);
const SHELL_COMMAND_FLAGS = new Set(['-c', '--command']);
const SHELL_SEGMENT_SPLIT = /(?:&&|\|\||[;&|`\n])/;
const AGENT_LAUNCH_MESSAGE = 'launching agent sessions from this MCP is disabled by the owner';
const INTERACTIVE_PRIVILEGE_EXECUTABLES = new Set(['sudo', 'su', 'pkexec']);
const INTERACTIVE_PRIVILEGE_MESSAGE = 'interactive privilege escalation is disabled; use deck-sudo when explicitly supported or use a non-privileged path';
const INTERACTIVE_PRIVILEGE_IN_WRAPPER = /(?:^|[\s;&|()`'"])(?:sudo|su|pkexec)(?=$|[\s;&|()`'"])/;

function resolvePath(token: string): string | undefined {
  if (isAbsolute(token) || token.includes('/')) {
    try {
      return realpathSync(token);
    } catch {
      return undefined;
    }
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    try {
      return realpathSync(join(dir, token));
    } catch {
      continue;
    }
  }
  return undefined;
}

function candidateNames(token: string): readonly string[] {
  const names = new Set<string>([basename(token), parse(token).name]);
  const resolved = resolvePath(token);
  if (resolved !== undefined) {
    names.add(basename(resolved));
    names.add(parse(resolved).name);
  }
  return [...names];
}

function isBlockedToken(token: string): boolean {
  return candidateNames(token).some(name => BLOCKED_AGENT_EXECUTABLES.has(name));
}

function resolvedBasename(token: string): string {
  const resolved = resolvePath(token);
  return resolved === undefined ? basename(token) : basename(resolved);
}

function leadingCommandToken(segment: string): string | undefined {
  for (const word of segment.trim().split(/\s+/).filter(part => part.length > 0)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return word.replace(/^["']|["']$/g, '');
  }
  return undefined;
}

function tokenizeShellSegments(value: string): string[] {
  return value
    .split(SHELL_SEGMENT_SPLIT)
    .map(leadingCommandToken)
    .filter((token): token is string => token !== undefined && token.length > 0);
}

function commandLaunchesBlockedAgent(command: string, args: readonly string[]): boolean {
  if (isBlockedToken(command)) return true;
  if (!WRAPPER_EXECUTABLES.has(resolvedBasename(command))) return false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (SHELL_COMMAND_FLAGS.has(arg)) {
      const script = args[index + 1];
      if (script !== undefined && tokenizeShellSegments(script).some(isBlockedToken)) return true;
      continue;
    }
    if (isBlockedToken(arg)) return true;
  }
  return false;
}

function commandUsesInteractivePrivilege(command: string, args: readonly string[]): boolean {
  if (candidateNames(command).some(name => INTERACTIVE_PRIVILEGE_EXECUTABLES.has(name))) return true;
  const executable = resolvedBasename(command);
  if (WRAPPER_EXECUTABLES.has(executable) || executable === 'ssh') {
    return args.some(arg => INTERACTIVE_PRIVILEGE_IN_WRAPPER.test(arg));
  }
  return false;
}

export function nonInteractiveShellArgs(command: string, args: readonly string[]): string[] {
  if (resolvedBasename(command) !== 'ssh') return [...args];
  return ['-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0', ...args];
}

export function nonInteractiveShellEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  return {
    ...env,
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_TERMINAL_PROMPT: '0',
    SUDO_ASKPASS: '/bin/false',
  };
}

export function authorizeCommand(command: string, args: readonly string[], policy: ShellLimits): void {
  if (!policy.enabled) {
    throw adapterError('CAPABILITY_DISABLED', 'shell.exec', 'Shell execution is disabled.');
  }
  if (command.length === 0 || command.includes('\0')) {
    throw adapterError('COMMAND_NOT_ALLOWED', 'shell.exec', 'Command must be a non-empty executable name or path without NUL bytes.', { command });
  }
  if (!policy.allowedCommands.includes('*') && !policy.allowedCommands.includes(command)) {
    throw adapterError('COMMAND_NOT_ALLOWED', 'shell.exec', 'Executable is not in the configured allow-list.', { command });
  }
  if (commandLaunchesBlockedAgent(command, args)) {
    throw adapterError('COMMAND_NOT_ALLOWED', 'shell.exec', AGENT_LAUNCH_MESSAGE, { command });
  }
  if (commandUsesInteractivePrivilege(command, args)) {
    throw adapterError('COMMAND_NOT_ALLOWED', 'shell.exec', INTERACTIVE_PRIVILEGE_MESSAGE, { command });
  }
}

export function authorizeHostDisplaySafeInvocation(
  command: string,
  args: readonly string[],
  hostDisplayAccess: boolean,
): void {
  if (hostDisplayAccess) return;

  const executable = basename(command).toLowerCase();
  if (HOST_CAPTURE_EXECUTABLES.has(executable)) {
    throw adapterError(
      'COMMAND_NOT_ALLOWED',
      'shell.exec',
      'Host-display capture executable is blocked while host display access is disabled.',
      { command },
    );
  }

  const payload = args.join(' ');
  if (HIGH_SIGNAL_HOST_CAPTURE_PATTERNS.some(pattern => pattern.test(payload))) {
    throw adapterError(
      'COMMAND_NOT_ALLOWED',
      'shell.exec',
      'Invocation contains an obvious host-display capture primitive while host display access is disabled.',
      { command },
    );
  }

  if (SHELL_OR_WRAPPER_EXECUTABLES.has(executable) && (WRAPPED_CAPTURE_COMMAND.test(payload) || WRAPPED_IMAGEMAGICK_IMPORT.test(payload) || args.some(arg => WRAPPED_IMAGEMAGICK_IMPORT.test(arg)))) {
    throw adapterError(
      'COMMAND_NOT_ALLOWED',
      'shell.exec',
      'Wrapped host-display capture command is blocked while host display access is disabled.',
      { command },
    );
  }

  if ((executable === 'ffmpeg' || executable === 'avconv') && /(?:^|\s)-f\s+(?:x11grab|kmsgrab)(?:\s|$)/i.test(payload)) {
    throw adapterError(
      'COMMAND_NOT_ALLOWED',
      'shell.exec',
      'Host-display FFmpeg capture is blocked while host display access is disabled.',
      { command },
    );
  }

  if (/^gst-launch(?:-\d+(?:\.\d+)?)?$/.test(executable) && /\bximagesrc\b/i.test(payload)) {
    throw adapterError(
      'COMMAND_NOT_ALLOWED',
      'shell.exec',
      'Host-display GStreamer capture is blocked while host display access is disabled.',
      { command },
    );
  }

  if (['gdbus', 'dbus-send', 'busctl', 'qdbus', 'qdbus6'].includes(executable) && /(?:Screenshot|ScreenShot2)/i.test(payload)) {
    throw adapterError(
      'COMMAND_NOT_ALLOWED',
      'shell.exec',
      'Desktop screenshot D-Bus invocation is blocked while host display access is disabled.',
      { command },
    );
  }

  if (executable === 'magick' && /(?:^|\s)import(?:\s|$)/i.test(payload)) {
    throw adapterError(
      'COMMAND_NOT_ALLOWED',
      'shell.exec',
      'ImageMagick desktop import is blocked while host display access is disabled.',
      { command },
    );
  }
}

export function clampRuntime(requested: number | undefined, maximum: number): number {
  if (requested === undefined) return maximum;
  return Math.max(1, Math.min(requested, maximum));
}

export function effectiveShellRuntime(requested: number | undefined, defaultRuntime: number, maximum: number): number {
  return clampRuntime(requested ?? defaultRuntime, maximum);
}

export function clampOutput(requested: number | undefined, maximum: number): number {
  if (requested === undefined) return maximum;
  return Math.max(1, Math.min(requested, maximum));
}
