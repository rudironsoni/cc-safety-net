import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOpenClawBeforeToolCallHandler,
  registerOpenClawPlugin,
} from '@/integrations/openclaw/plugin';
import type { AnalyzeOptions } from '@/ir/analysis';
import { readAuditLogEntriesForSession, readLatestAuditLogEntry, withEnv } from '../../helpers';

type AnalyzeCall = { command: string; cwd?: string; shell?: string };

type Registration = { hookName: string; handler: unknown; opts: unknown };

describe('OpenClaw before_tool_call plugin', () => {
  test('registers a before_tool_call handler for the canonical exec matcher', () => {
    withWorkspace((dir) => {
      const registrations: Registration[] = [];
      registerOpenClawPlugin(openClawApi(dir, { registrations }));

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.hookName).toBe('before_tool_call');
      expect(registrations[0]?.opts).toEqual({ matcher: ['exec'], priority: 50 });
      expect(typeof registrations[0]?.handler).toBe('function');
    });
  });

  test('maps a canonical exec call to a shell command analysed in the agent workspace', () => {
    withWorkspace((dir) => {
      const calls: AnalyzeCall[] = [];

      expect(
        handlerWithAnalyzer(dir, calls)(execEvent({ command: 'git status' }), toolContext()),
      ).toBeUndefined();
      expect(calls).toEqual([{ command: 'git status', cwd: realpathSync(dir), shell: 'auto' }]);
    });
  });

  test('resolves the agent workspace from the plugin config and the context agent id', () => {
    withWorkspace((dir) => {
      const resolveCalls: Array<[unknown, unknown]> = [];
      const api = openClawApi(dir, {
        resolveAgentWorkspaceDir: (config: unknown, agentId: unknown) => {
          resolveCalls.push([config, agentId]);
          return dir;
        },
      });

      createOpenClawBeforeToolCallHandler(api)(
        execEvent({ command: 'git status' }),
        toolContext({ agentId: 'research' }),
      );

      expect(resolveCalls).toEqual([[api.config, 'research']]);
    });
  });

  test('blocks a destructive exec command with a formatted blockReason', () => {
    withWorkspace((dir) => {
      const result = createOpenClawBeforeToolCallHandler(openClawApi(dir))(
        execEvent({ command: 'rm -rf .' }),
        toolContext(),
      ) as { block: boolean; blockReason: string };

      expect(Object.keys(result).sort()).toEqual(['block', 'blockReason']);
      expect(result.block).toBeTrue();
      expect(result.blockReason).toContain('BLOCKED by CC Safety Net');
      expect(result.blockReason).toContain('Command: rm -rf .');
    });
  });

  test('blocks an exec command that reads a sensitive path', () => {
    withWorkspace((dir) => {
      const result = createOpenClawBeforeToolCallHandler(openClawApi(dir))(
        execEvent({ command: 'cat .env' }),
        toolContext(),
      ) as { blockReason: string };

      expect(result.blockReason).toContain('Access to a sensitive path is not allowed.');
    });
  });

  test('makes no decision for tools outside the exec matcher', () => {
    withWorkspace((dir) => {
      const calls: AnalyzeCall[] = [];
      const handler = handlerWithAnalyzer(dir, calls);

      expect(
        handler(
          { toolName: 'apply_patch', params: { patch: 'rm -rf ~' } },
          toolContext({ toolName: 'apply_patch' }),
        ),
      ).toBeUndefined();
      expect(
        handler({ toolName: 'read', params: { path: '.env' } }, toolContext()),
      ).toBeUndefined();
      expect(calls).toEqual([]);
    });
  });

  test('makes no decision for Code Mode exec events tagged with toolKind', () => {
    withWorkspace((dir) => {
      expect(
        createOpenClawBeforeToolCallHandler(openClawApi(dir))(
          {
            toolName: 'exec',
            params: { code: 'rm -rf .', command: 'rm -rf .' },
            toolKind: 'code_mode_exec',
          },
          toolContext(),
        ),
      ).toBeUndefined();
    });
  });

  test('blocks malformed exec events', () => {
    withWorkspace((dir) => {
      const handler = createOpenClawBeforeToolCallHandler(openClawApi(dir));

      for (const event of [null, undefined, 'nope', 42]) {
        expect(handler(event, toolContext())).toEqual({
          block: true,
          blockReason: expect.stringContaining('CC Safety Net failed closed'),
        });
      }
      for (const toolName of [undefined, null, '', '   ', 42]) {
        expect(
          handler({ toolName, params: { command: 'git status' } }, toolContext()),
        ).toMatchObject({ block: true });
      }
      for (const params of [undefined, null, 'nope', 42, ['command']]) {
        expect(handler({ toolName: 'exec', params }, toolContext())).toMatchObject({ block: true });
      }
    });
  });

  test('blocks malformed exec command input', () => {
    withWorkspace((dir) => {
      const handler = createOpenClawBeforeToolCallHandler(openClawApi(dir));

      for (const command of [undefined, null, '', '   ', 42, { command: 'git status' }]) {
        expect(handler(execEvent({ command }), toolContext())).toEqual({
          block: true,
          blockReason: expect.stringContaining('CC Safety Net failed closed'),
        });
      }
    });
  });

  test('uses a workdir contained in the agent workspace as the execution cwd', () => {
    withWorkspace((dir) => {
      mkdirSync(join(dir, 'app'));
      const calls: AnalyzeCall[] = [];

      expect(
        handlerWithAnalyzer(dir, calls)(
          execEvent({ command: 'git status', workdir: 'app' }),
          toolContext(),
        ),
      ).toBeUndefined();
      expect(calls).toEqual([
        { command: 'git status', cwd: realpathSync(join(dir, 'app')), shell: 'auto' },
      ]);
    });
  });

  test('blocks a workdir that escapes the agent workspace', () => {
    withWorkspace((dir) => {
      const outside = mkdtempSync(join(tmpdir(), 'safety-net-openclaw-outside-'));
      try {
        symlinkSync(outside, join(dir, 'outside-link'));
        const handler = createOpenClawBeforeToolCallHandler(openClawApi(dir));

        for (const workdir of ['..', '../../outside', outside, 'outside-link', 'missing']) {
          expect(handler(execEvent({ command: 'git status', workdir }), toolContext())).toEqual({
            block: true,
            blockReason: expect.stringContaining('CC Safety Net failed closed'),
          });
        }
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  test('blocks an empty or malformed workdir', () => {
    withWorkspace((dir) => {
      const handler = createOpenClawBeforeToolCallHandler(openClawApi(dir));

      for (const workdir of ['', '   ', null, 42]) {
        expect(handler(execEvent({ command: 'git status', workdir }), toolContext())).toMatchObject(
          {
            block: true,
          },
        );
      }
    });
  });

  test('blocks when the agent context is missing', () => {
    withWorkspace((dir) => {
      const handler = createOpenClawBeforeToolCallHandler(openClawApi(dir));

      for (const agentId of [undefined, '', '   ', 42]) {
        expect(handler(execEvent({ command: 'git status' }), toolContext({ agentId }))).toEqual({
          block: true,
          blockReason: expect.stringContaining('CC Safety Net failed closed'),
        });
      }
    });
  });

  test('blocks when the agent workspace cannot be proven', () => {
    withWorkspace((dir) => {
      const missing = join(dir, 'gone');
      const filePath = join(dir, 'workspace-file');
      writeFileSync(filePath, 'not a directory');

      for (const resolved of [undefined, '', '   ', missing, filePath, 42]) {
        const handler = createOpenClawBeforeToolCallHandler(
          openClawApi(dir, { resolveAgentWorkspaceDir: () => resolved }),
        );
        expect(handler(execEvent({ command: 'git status' }), toolContext())).toMatchObject({
          block: true,
        });
      }

      const throwing = createOpenClawBeforeToolCallHandler(
        openClawApi(dir, {
          resolveAgentWorkspaceDir: () => {
            throw new Error('no workspace');
          },
        }),
      );
      const result = throwing(execEvent({ command: 'git status' }), toolContext()) as {
        blockReason: string;
      };
      expect(result.blockReason).toContain('CC Safety Net failed closed');
      expect(result.blockReason).not.toContain('no workspace');
    });
  });

  test('analyses exec calls on the proven local gateway host', () => {
    withWorkspace((dir) => {
      const calls: AnalyzeCall[] = [];
      const handler = handlerWithAnalyzer(dir, calls);

      for (const host of [undefined, 'auto', 'gateway']) {
        expect(handler(execEvent({ command: 'git status', host }), toolContext())).toBeUndefined();
      }
      expect(calls).toHaveLength(3);
    });
  });

  test('blocks exec calls routed to an unproven execution host', () => {
    withWorkspace((dir) => {
      const calls: AnalyzeCall[] = [];
      const handler = handlerWithAnalyzer(dir, calls);

      for (const host of ['node', 'sandbox', 'remote.example.com', '', null, 42]) {
        expect(handler(execEvent({ command: 'git status', host }), toolContext())).toEqual({
          block: true,
          blockReason: expect.stringContaining('CC Safety Net failed closed'),
        });
      }
      expect(calls).toEqual([]);
    });
  });

  test('blocks without analysing when the tool call is already cancelled', () => {
    withWorkspace((dir) => {
      const calls: AnalyzeCall[] = [];
      const controller = new AbortController();
      controller.abort();

      expect(
        handlerWithAnalyzer(dir, calls)(
          execEvent({ command: 'git status' }),
          toolContext({ abortSignal: controller.signal }),
        ),
      ).toEqual({
        block: true,
        blockReason: expect.stringContaining('CC Safety Net failed closed'),
      });
      expect(calls).toEqual([]);
    });
  });

  test('evaluates normally while the cancellation signal is unaborted', () => {
    withWorkspace((dir) => {
      const calls: AnalyzeCall[] = [];

      expect(
        handlerWithAnalyzer(dir, calls)(
          execEvent({ command: 'git status' }),
          toolContext({ abortSignal: new AbortController().signal }),
        ),
      ).toBeUndefined();
      expect(calls).toHaveLength(1);
    });
  });

  test('blocks rather than throwing when guard analysis fails', () => {
    withWorkspace((dir) => {
      const result = createOpenClawBeforeToolCallHandler(openClawApi(dir), {
        guardDependencies: {
          analyzeCommand: () => {
            throw new Error('unexpected analysis failure');
          },
        },
      })(execEvent({ command: 'git status' }), toolContext()) as { blockReason: string };

      expect(result.blockReason).toContain('CC Safety Net failed closed');
      expect(result.blockReason).toContain('Command: git status');
      expect(result.blockReason).not.toContain('unexpected analysis failure');
    });
  });

  test('attributes audit records to openclaw with the context session id', () => {
    withWorkspace((dir) => {
      const home = join(dir, 'home');
      withEnv({ HOME: home }, () => {
        const result = createOpenClawBeforeToolCallHandler(openClawApi(dir))(
          execEvent({ command: 'cat .env' }),
          toolContext({ sessionId: 'oc-session-deny' }),
        ) as { blockReason: string };

        expect(result.blockReason).toContain('Access to a sensitive path is not allowed.');
        expect(readLatestAuditLogEntry(home, 'oc-session-deny')).toEqual(
          expect.objectContaining({
            agent: 'openclaw',
            decision: 'deny',
            command: 'cat .env',
            toolName: 'exec',
            cwd: realpathSync(dir),
          }),
        );
      });
    });
  });

  test('falls back to the session key when no session id is present', () => {
    withWorkspace((dir) => {
      const home = join(dir, 'home');
      withEnv({ HOME: home }, () => {
        createOpenClawBeforeToolCallHandler(openClawApi(dir))(
          execEvent({ command: 'git reset --hard' }),
          toolContext({ sessionId: undefined, sessionKey: 'agent:main:oc-key' }),
        );

        // Audit records store the filename-sanitized session id.
        expect(readAuditLogEntriesForSession(home, 'agent_main_oc-key')).toMatchObject([
          { agent: 'openclaw', decision: 'deny', ruleId: 'git.reset-hard' },
        ]);
      });
    });
  });

  test('audits malformed exec calls with the openclaw agent', () => {
    withWorkspace((dir) => {
      const home = join(dir, 'home');
      withEnv({ HOME: home }, () => {
        createOpenClawBeforeToolCallHandler(openClawApi(dir))(
          execEvent({ command: 'git status', host: 'node' }),
          toolContext({ sessionId: 'oc-session-malformed' }),
        );

        expect(readAuditLogEntriesForSession(home, 'oc-session-malformed')).toMatchObject([
          { agent: 'openclaw', decision: 'deny', toolName: 'exec' },
        ]);
      });
    });
  });

  test('records an allowed exec command only under the all audit scope', () => {
    withWorkspace((dir) => {
      const home = join(dir, 'home');
      withEnv({ HOME: home, CC_SAFETY_NET_AUDIT_SCOPE: 'all' }, () => {
        expect(
          createOpenClawBeforeToolCallHandler(openClawApi(dir))(
            execEvent({ command: 'git status' }),
            toolContext({ sessionId: 'oc-session-allow' }),
          ),
        ).toBeUndefined();

        expect(readAuditLogEntriesForSession(home, 'oc-session-allow')).toMatchObject([
          { agent: 'openclaw', decision: 'allow', reason: 'allowed' },
        ]);
      });

      const home2 = join(dir, 'home2');
      withEnv({ HOME: home2, CC_SAFETY_NET_AUDIT_SCOPE: 'blocked' }, () => {
        createOpenClawBeforeToolCallHandler(openClawApi(dir))(
          execEvent({ command: 'git status' }),
          toolContext({ sessionId: 'oc-session-allow' }),
        );

        expect(readAuditLogEntriesForSession(home2, 'oc-session-allow')).toEqual([]);
      });
    });
  });
});

function handlerWithAnalyzer(dir: string, calls: AnalyzeCall[]) {
  return createOpenClawBeforeToolCallHandler(openClawApi(dir), {
    guardDependencies: {
      analyzeCommand: (command: string, options: AnalyzeOptions) => {
        calls.push({ command, cwd: options.cwd, shell: options.shell });
        return null;
      },
    },
  });
}

function execEvent(params: Record<string, unknown>) {
  return { toolName: 'exec', params };
}

function toolContext(overrides: Record<string, unknown> = {}) {
  return {
    toolName: 'exec',
    agentId: 'main',
    sessionId: 'oc-session',
    ...overrides,
  } as Parameters<ReturnType<typeof createOpenClawBeforeToolCallHandler>>[1];
}

function openClawApi(
  workspaceDir: string,
  overrides: {
    registrations?: Registration[];
    resolveAgentWorkspaceDir?: (config: unknown, agentId: unknown) => unknown;
  } = {},
) {
  return {
    config: { agents: { defaults: { workspace: workspaceDir } } },
    runtime: {
      agent: {
        resolveAgentWorkspaceDir:
          overrides.resolveAgentWorkspaceDir ?? (() => workspaceDir as unknown),
      },
    },
    on: (hookName: string, handler: unknown, opts: unknown) => {
      overrides.registrations?.push({ hookName, handler, opts });
    },
  } as unknown as Parameters<typeof createOpenClawBeforeToolCallHandler>[0];
}

function withWorkspace(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'safety-net-openclaw-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
