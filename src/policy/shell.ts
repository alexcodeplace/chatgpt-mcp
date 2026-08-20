import { adapterError } from '../errors.js';

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

const WRAPPED_CAPTURE_COMMAND = /(?:^|[\s;&|()])(?:deepin-screenshot|flameshot|gnome-screenshot|gnome-shell-screenshot|grim|grimshot|import|ksnip|maim|mate-screenshot|scrot|shutter|spectacle|wf-recorder|wl-screenrec|xwd|xfce4-screenshooter)(?=$|[\s;&|()])/i;

export interface ShellLimits {
  enabled: boolean;
  allowedCommands: readonly string[];
  maxRuntimeMs: number;
  maxOutputBytes: number;
}

export function authorizeCommand(command: string, policy: ShellLimits): void {
  if (!policy.enabled) {
    throw adapterError('CAPABILITY_DISABLED', 'shell.exec', 'Shell execution is disabled.');
  }
  if (command.length === 0 || command.includes('/') || command.includes('\\')) {
    throw adapterError('COMMAND_NOT_ALLOWED', 'shell.exec', 'Command must be an allowed executable name.', { command });
  }
  if (!policy.allowedCommands.includes('*') && !policy.allowedCommands.includes(command)) {
    throw adapterError('COMMAND_NOT_ALLOWED', 'shell.exec', 'Executable is not in the configured allow-list.', { command });
  }
}

export function authorizeHostDisplaySafeInvocation(
  command: string,
  args: readonly string[],
  hostDisplayAccess: boolean,
): void {
  if (hostDisplayAccess) return;

  const executable = command.toLowerCase();
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

  if (SHELL_OR_WRAPPER_EXECUTABLES.has(executable) && WRAPPED_CAPTURE_COMMAND.test(payload)) {
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

export function clampOutput(requested: number | undefined, maximum: number): number {
  if (requested === undefined) return maximum;
  return Math.max(1, Math.min(requested, maximum));
}
