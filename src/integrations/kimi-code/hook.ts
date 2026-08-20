import type { HookOutput } from '@/integrations/claude-code/hook';
import {
  getToolRoute,
  outputFailedClosed,
  resolveStandardHookContext,
  runConfiguredHookAdapter,
} from '@/integrations/hook/common';
import { KIMI_CODE_HOOK_EVENT } from '@/integrations/hook/constants';
import { resolveContainedCwd } from '@/integrations/runtime';
import type { CommandToolKind } from '@/ir/invocation';

/** Kimi Code hook input format */
interface KimiCodeHookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: {
    command?: string;
    cwd?: unknown;
    [key: string]: unknown;
  };
  tool_call_id?: string;
}

const KIMI_CODE_COMMAND_TOOLS = new Map<string, CommandToolKind>([['Bash', 'posix']]);

/** @internal */
export function getKimiCodeToolRoute(toolName: string) {
  return getToolRoute(toolName, KIMI_CODE_COMMAND_TOOLS);
}

export async function runKimiCodeHook(): Promise<void> {
  await runConfiguredHookAdapter<KimiCodeHookInput>({
    agent: 'kimi-code',
    createDenyOutput: (message): HookOutput => ({
      hookSpecificOutput: {
        hookEventName: KIMI_CODE_HOOK_EVENT,
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
    }),
    isSupported: (input) => input.hook_event_name === KIMI_CODE_HOOK_EVENT,
    getToolName: (input) => input.tool_name,
    getToolInput: (input, toolName) => ({
      ok: true,
      input: input.tool_input,
      route: getKimiCodeToolRoute(toolName),
    }),
    getContext: (input, toolInput, toolName, outputDeny) => {
      const context = resolveStandardHookContext(input.cwd, toolInput, toolName, outputDeny);
      if (!context) return null;
      const args = input.tool_input;
      if (!KIMI_CODE_COMMAND_TOOLS.has(toolName) || !args || !Object.hasOwn(args, 'cwd')) {
        return context;
      }
      const cwd = args.cwd;
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        outputFailedClosed(outputDeny, toolInput, toolName);
        return null;
      }
      const containedCwd = resolveContainedCwd(cwd, [context.configCwd]);
      if (!containedCwd) {
        outputFailedClosed(outputDeny, toolInput, toolName, cwd);
        return null;
      }
      return { configCwd: context.configCwd, executionCwd: containedCwd };
    },
    getSessionId: (input) => input.session_id,
  });
}
