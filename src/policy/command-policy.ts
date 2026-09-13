import type { ExecRequest } from '../adapter/computer-adapter.js';
import type { ChatGptMcpConfig } from '../config.js';
import { adapterError } from '../errors.js';

type CommandPolicyConfig = ChatGptMcpConfig['execution']['commandPolicies'][number];
type CommandPolicyAction = CommandPolicyConfig['action'];

export interface CompiledCommandPolicy {
  readonly id: string;
  readonly command?: RegExp;
  readonly invocation?: RegExp;
  readonly cwd?: RegExp;
  readonly action: CommandPolicyAction;
}

export interface CommandPolicyDecision {
  readonly ruleId: string;
  readonly action: CommandPolicyAction;
}

export function canonicalInvocation(request: Pick<ExecRequest, 'command' | 'args'>): string {
  return JSON.stringify([request.command, ...request.args]);
}

export function compileCommandPolicies(policies: readonly CommandPolicyConfig[]): readonly CompiledCommandPolicy[] {
  return policies.map(policy => ({
    id: policy.id,
    ...(policy.match.command === undefined ? {} : { command: new RegExp(policy.match.command) }),
    ...(policy.match.invocation === undefined ? {} : { invocation: new RegExp(policy.match.invocation) }),
    ...(policy.match.cwd === undefined ? {} : { cwd: new RegExp(policy.match.cwd) }),
    action: policy.action,
  }));
}

function matches(pattern: RegExp | undefined, value: string | undefined): boolean {
  if (pattern === undefined) return true;
  if (value === undefined) return false;
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function evaluateCommandPolicy(
  policies: readonly CompiledCommandPolicy[],
  request: Pick<ExecRequest, 'command' | 'args' | 'cwd'>,
): CommandPolicyDecision | undefined {
  const invocation = canonicalInvocation(request);
  for (const policy of policies) {
    if (!matches(policy.command, request.command)) continue;
    if (!matches(policy.invocation, invocation)) continue;
    if (!matches(policy.cwd, request.cwd)) continue;
    return { ruleId: policy.id, action: policy.action };
  }
  return undefined;
}

export function enforceCommandPolicy(decision: CommandPolicyDecision | undefined, operation = 'shell.exec'): void {
  if (decision?.action.type !== 'deny') return;
  throw adapterError('COMMAND_NOT_ALLOWED', operation, decision.action.message, { ruleId: decision.ruleId });
}
