import { adapterError } from '../errors.js';

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

export function clampRuntime(requested: number | undefined, maximum: number): number {
  if (requested === undefined) return maximum;
  return Math.max(1, Math.min(requested, maximum));
}

export function clampOutput(requested: number | undefined, maximum: number): number {
  if (requested === undefined) return maximum;
  return Math.max(1, Math.min(requested, maximum));
}
