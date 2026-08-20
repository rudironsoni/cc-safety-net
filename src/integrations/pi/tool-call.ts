import { writeIntegrationDenialAudit } from '@/integrations/audit';
import { resolveContainedCwd } from '@/integrations/cwd-containment';
import {
  createFailedClosedDenial,
  formatDenial,
  formatIntegrationError,
  type IntegrationDenial,
  projectGuardDenial,
} from '@/integrations/denial';
import {
  evaluateRuntimeGuard,
  type GuardDependencies,
  GuardEvaluationError,
} from '@/integrations/runtime';
import type { CommandToolKind, ToolInvocation } from '@/ir/invocation';
import { createToolInvocation } from '@/ir/invocation';
import { getNonCommandToolInputKind } from '@/parser/tool-input';
import { ENV_FLAGS, envTruthy, shouldRecordAllowedCommands } from '@/policy/env';
import type { PolicySnapshotOptions } from '@/policy/snapshot';

type PiApi = {
  on: (
    event: 'tool_call',
    handler: (event: unknown, ctx: PiToolCallContext) => PiToolCallResult,
  ) => void;
};

type PiToolCallContext = {
  cwd: string;
  sessionManager: {
    getSessionId: () => string | undefined;
  };
};

type PiToolCallResult = { block: true; reason: string } | undefined;

type PiToolCallEvent = {
  type?: string;
  toolName?: string;
  input?: Record<string, unknown>;
};

const PI_COMMAND_TOOL_ADAPTERS = new Map<string, CommandToolKind>([['bash', 'posix']]);

type MalformedPiToolCall = {
  malformed: true;
  denial: IntegrationDenial;
  cwd: string | null;
};

export function registerToolCallEvent(pi: PiApi): void {
  pi.on('tool_call', handlePiToolCall);
}

/** @internal - exported for test coverage */
export const handlePiToolCall = createPiToolCallHandler();

/** @internal */
export function createPiToolCallHandler(
  options: {
    guardDependencies?: Partial<GuardDependencies>;
    policyOptions?: PolicySnapshotOptions;
  } = {},
): (event: unknown, ctx: PiToolCallContext) => PiToolCallResult {
  return (event, ctx) => handlePiToolCallWithDependencies(event, ctx, options);
}

function handlePiToolCallWithDependencies(
  event: unknown,
  ctx: PiToolCallContext,
  options: {
    guardDependencies?: Partial<GuardDependencies>;
    policyOptions?: PolicySnapshotOptions;
  },
): PiToolCallResult {
  const toolCall = getPiToolCall(event, ctx);
  if (!toolCall) return undefined;

  if ('malformed' in toolCall) {
    writeIntegrationDenialAudit(toolCall.denial, () => ctx.sessionManager.getSessionId(), {
      agent: 'pi',
      toolName: toolCall.denial.toolName,
      cwd: toolCall.cwd,
    });
    return blockPiToolCall(toolCall.denial);
  }

  try {
    const evaluation = evaluateRuntimeGuard(toolCall, {
      guard: {
        auditAllowed: shouldRecordAllowedCommands(),
        policyOptions: options.policyOptions,
        dependencies: options.guardDependencies,
      },
      audit: {
        agent: 'pi',
        getSessionId: () => ctx.sessionManager.getSessionId(),
      },
    });
    return blockPiEvaluation(evaluation, evaluation.stage !== 'config-state');
  } catch (error) {
    if (!(error instanceof GuardEvaluationError)) throw error;
    if (envTruthy(ENV_FLAGS.debug)) {
      console.error(
        `CC Safety Net debug: pi tool_call analysis failed: ${formatIntegrationError(error.cause)}`,
      );
    }
    return blockPiEvaluation(error.evaluation, toolCall.route.kind === 'command');
  }
}

function getPiToolCall(
  event: unknown,
  ctx: PiToolCallContext,
): MalformedPiToolCall | ToolInvocation | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const toolCall = event as PiToolCallEvent;
  if (toolCall.type !== undefined && toolCall.type !== 'tool_call') return undefined;
  if (typeof toolCall.toolName !== 'string' || toolCall.toolName.trim() === '') {
    return malformedPiToolCall(ctx);
  }

  const validContextCwd =
    typeof ctx.cwd === 'string' && ctx.cwd.trim() !== ''
      ? resolveContainedCwd('.', [ctx.cwd])
      : undefined;
  if (!validContextCwd) return malformedPiToolCall(ctx, toolCall.toolName);

  const shell = PI_COMMAND_TOOL_ADAPTERS.get(toolCall.toolName);
  if (!toolCall.input || typeof toolCall.input !== 'object') {
    return shell ? malformedPiToolCall(ctx, toolCall.toolName) : undefined;
  }

  if (!shell) {
    return createToolInvocation(
      toolCall.toolName,
      toolCall.input,
      { kind: getNonCommandToolInputKind(toolCall.toolName) },
      { configCwd: validContextCwd, executionCwd: validContextCwd },
      null,
    );
  }

  const command = toolCall.input.command;
  if (typeof command !== 'string' || command.trim() === '') {
    return malformedPiToolCall(ctx, toolCall.toolName);
  }

  return createToolInvocation(
    toolCall.toolName,
    toolCall.input,
    { kind: 'command', shell },
    { configCwd: validContextCwd, executionCwd: validContextCwd },
    command,
  );
}

function malformedPiToolCall(ctx: PiToolCallContext, toolName?: string): MalformedPiToolCall {
  return {
    malformed: true,
    denial: createFailedClosedDenial({ toolName }),
    cwd: typeof ctx.cwd === 'string' && ctx.cwd.trim() ? ctx.cwd : null,
  };
}

function blockPiEvaluation(
  evaluation: Parameters<typeof projectGuardDenial>[0],
  includeEvidence: boolean,
): PiToolCallResult {
  const denial = projectGuardDenial(evaluation, { includeEvidence });
  return denial ? blockPiToolCall(denial) : undefined;
}

function blockPiToolCall(denial: IntegrationDenial): PiToolCallResult {
  return { block: true, reason: formatDenial(denial) };
}
