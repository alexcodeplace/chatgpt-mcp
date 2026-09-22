import type { ChatGptMcpConfig } from '../config.js';
import { authorizePath } from '../policy/filesystem.js';
import { authorizeCommand, authorizeHostDisplaySafeInvocation, effectiveShellRuntime, validateShellEnvironment } from '../policy/shell.js';
import { compileCommandPolicies, enforceCommandPolicy, evaluateCommandPolicy, type CommandPolicyDecision } from '../policy/command-policy.js';
import { KubernetesExecutor } from '../execution/kubernetes-executor.js';
import { ExecutionMetrics } from '../execution/metrics.js';
import { adapterError } from '../errors.js';
import type { ExecRequest, ExecResult, ShellExecutionClass } from './computer-adapter.js';
import { LocalComputerAdapter } from './local-computer-adapter.js';

export class RoutingComputerAdapter extends LocalComputerAdapter {
  private readonly metrics = new ExecutionMetrics();
  private readonly kubernetes: KubernetesExecutor;
  private readonly patterns: readonly RegExp[];
  private readonly policies: ReturnType<typeof compileCommandPolicies>;

  constructor(private readonly routingConfig: Readonly<ChatGptMcpConfig>) {
    super(routingConfig);
    this.kubernetes = new KubernetesExecutor(routingConfig, this.metrics);
    this.patterns = routingConfig.execution.kubernetes.heavyCommandPatterns.map(pattern => new RegExp(pattern));
    this.policies = compileCommandPolicies(routingConfig.execution.commandPolicies);
  }

  private policyDecision(request: ExecRequest): CommandPolicyDecision | undefined {
    const decision = evaluateCommandPolicy(this.policies, request);
    enforceCommandPolicy(decision);
    return decision;
  }

  private requireKubernetesRoute(request: ExecRequest, decision: CommandPolicyDecision): ShellExecutionClass {
    const remote = this.routingConfig.execution.kubernetes;
    if (!remote.enabled || remote.image === undefined) {
      throw adapterError('CAPABILITY_DISABLED', 'shell.exec', 'Command policy requires the Kubernetes execution backend, but it is not configured.', { ruleId: decision.ruleId, backend: 'kubernetes' });
    }
    if (request.cwd === undefined) {
      throw adapterError('INVALID_INPUT', 'shell.exec', 'Command policy requires the Kubernetes execution backend, which requires an explicit cwd.', { ruleId: decision.ruleId, backend: 'kubernetes' });
    }
    return 'shell-remote';
  }

  override classifyExec(request: ExecRequest): ShellExecutionClass {
    const localClass = super.classifyExec(request);
    const decision = this.policyDecision(request);
    if (decision?.action.type === 'allow') return localClass;
    if (decision?.action.type === 'route') {
      if (decision.action.backend === 'local') return localClass;
      return this.requireKubernetesRoute(request, decision);
    }

    const remote = this.routingConfig.execution.kubernetes;
    if (!remote.enabled || remote.image === undefined || request.cwd === undefined) return localClass;
    if (remote.localOnlyCommands.includes(request.command)) return localClass;
    if (remote.remoteCommands.includes(request.command)) return 'shell-remote';
    const invocation = [request.command, ...request.args].join(' ');
    return this.patterns.some(pattern => pattern.test(invocation)) ? 'shell-remote' : localClass;
  }

  override async exec(request: ExecRequest): Promise<ExecResult> {
    const decision = this.policyDecision(request);
    const route = this.classifyExec(request);
    if (route !== 'shell-remote') {
      const policyForcedLocal = decision?.action.type === 'allow' || (decision?.action.type === 'route' && decision.action.backend === 'local');
      this.metrics.recordRoute(policyForcedLocal || this.routingConfig.execution.kubernetes.localOnlyCommands.includes(request.command) ? 'forced-local' : 'local');
      const started = process.hrtime.bigint();
      const result = await super.exec(request);
      this.metrics.addOutput('local', Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8'));
      this.metrics.recordDuration('local', Number(process.hrtime.bigint() - started) / 1_000_000);
      return result;
    }

    this.metrics.recordRoute('remote');
    const operation = 'shell.exec';
    authorizeCommand(request.command, request.args, this.routingConfig.shell);
    authorizeHostDisplaySafeInvocation(request.command, request.args, this.routingConfig.desktop.hostDisplayAccess);
    const cwd = await authorizePath(request.cwd!, this.routingConfig.filesystem.roots, operation);
    const env = validateShellEnvironment(
      request.env,
      this.routingConfig.shell.allowEnvironment,
      false,
      false,
    );
    return this.kubernetes.exec({
      command: request.command,
      args: request.args,
      cwd,
      ...(env === undefined ? {} : { env: env as Readonly<Record<string, string>> }),
      timeoutMs: effectiveShellRuntime(
        request.timeoutMs,
        this.routingConfig.shell.defaultRuntimeMs ?? Math.min(30_000, this.routingConfig.shell.maxRuntimeMs),
        this.routingConfig.shell.maxRuntimeMs,
      ),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, this.routingConfig.shell.maxRuntimeMs, this.routingConfig.shell.maxOutputBytes);
  }

  executionMetrics(): Record<string, unknown> {
    return this.metrics.snapshot() as unknown as Record<string, unknown>;
  }
}
