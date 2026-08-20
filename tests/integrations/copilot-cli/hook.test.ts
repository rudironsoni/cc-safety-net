import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readAuditLogEntriesForSession } from '../../helpers';
import {
  copilotBashInput,
  copilotRawToolArgsInput,
  expectNoHookOutput,
  expectSecretProtectionDeny,
  getHookDenyReason,
  runCopilotHookDirect as runCopilotHook,
  withHookTestContext,
  writeUserPolicy,
} from '../hook-helpers';

async function expectDeny(input: object | string, reason: string) {
  const result = await runCopilotHook(input);
  expect(getHookDenyReason(result, 'copilot-cli')).toContain(reason);
}

describe('GitHub Copilot CLI hook', () => {
  describe('blocked commands', () => {
    test('blocks rm -rf via bash tool', async () => {
      const { stdout, exitCode } = await runCopilotHook(copilotBashInput('rm -rf /'));

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.permissionDecision).toBe('deny');
      expect(output.permissionDecisionReason).toContain('rm -rf');
    });

    test('audits native guard denials exactly once with sessionId', async () => {
      await withHookTestContext(async (context) => {
        await context.runCopilotHook(context.copilotBashInput('git reset --hard'));

        expect(readAuditLogEntriesForSession(context.home, 'copilot-test-session')).toHaveLength(1);
      });
    });
  });

  describe('allowed commands', () => {
    test('allows safe commands (no output)', async () => {
      await expectNoHookOutput(runCopilotHook, copilotBashInput('ls -la'));
    });
  });

  describe('non-target tool', () => {
    test('ignores non-bash tools when user policy disables secret protection', async () => {
      await withHookTestContext(async (context) => {
        writeUserPolicy(context.home, { version: 1, secret_protection: { enabled: false } });

        await expectNoHookOutput(context.runCopilotHook, {
          timestamp: Date.now(),
          cwd: context.cwd,
          toolName: 'write_file',
          toolArgs: JSON.stringify({ path: '.env' }),
        });
      });
    });

    test('secret protection blocks path-like non-bash tool args', async () => {
      const result = await runCopilotHook({
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolName: 'write_file',
        toolArgs: JSON.stringify({ path: '.env' }),
      });

      expectSecretProtectionDeny(result, 'copilot-cli');
    });

    test('secret protection ignores grep pattern text for non-sensitive search roots', async () => {
      const envFile = ['.', 'env'].join('');

      await expectNoHookOutput(runCopilotHook, {
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolName: 'grep',
        toolArgs: JSON.stringify({ pattern: envFile, path: 'src' }),
      });
    });
  });

  describe('empty stdin', () => {
    test('empty input produces deny output', async () => {
      await expectDeny('', 'Missing hook input JSON.');
    });

    test('whitespace-only input produces deny output', async () => {
      await expectDeny('   \n\t  ', 'Missing hook input JSON.');
    });
  });

  describe('invalid outer JSON', () => {
    test('non-strict mode blocks invalid outer JSON', async () => {
      await expectDeny('{invalid json', 'Failed to parse hook input JSON.');
    });
  });

  describe('invalid toolArgs', () => {
    test('blocks non-string toolArgs before command analysis', async () => {
      await expectDeny(
        {
          ...copilotBashInput('git status'),
          toolArgs: { command: 'git status' },
        },
        'Failed to parse toolArgs JSON.',
      );
    });

    test('non-strict mode blocks invalid toolArgs JSON', async () => {
      await expectDeny(copilotRawToolArgsInput('{invalid'), 'Failed to parse toolArgs JSON.');
    });

    test('audits malformed toolArgs exactly once when sessionId is usable', async () => {
      await withHookTestContext(async (context) => {
        await context.runCopilotHook(context.copilotRawToolArgsInput('{invalid'));

        expect(readAuditLogEntriesForSession(context.home, 'copilot-test-session')).toMatchObject([
          {
            agent: 'copilot-cli',
            toolName: 'bash',
            reason: 'Failed to parse toolArgs JSON.',
          },
        ]);
      });
    });

    test.each([
      ['missing', undefined],
      ['blank', '   '],
      ['non-string', 42],
    ] as const)('does not audit unsafe input with a %s sessionId', async (_label, sessionId) => {
      await withHookTestContext(async (context) => {
        const timestamp = 1_234_567_890;
        const result = await context.runCopilotHook({
          ...(sessionId === undefined ? {} : { sessionId }),
          timestamp,
          cwd: context.cwd,
          toolName: 'bash',
          toolArgs: JSON.stringify({ command: 'git reset --hard' }),
        });

        expect(getHookDenyReason(result, 'copilot-cli')).toContain('git reset --hard');
        expect(existsSync(join(context.home, '.cc-safety-net', 'logs'))).toBe(false);
        expect(readAuditLogEntriesForSession(context.home, `copilot-${timestamp}`)).toHaveLength(0);
      });
    });
  });

  describe('missing command', () => {
    test('missing command in toolArgs fails closed', async () => {
      const input = {
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolName: 'bash',
        toolArgs: JSON.stringify({}),
      };

      await expectDeny(input, 'CC Safety Net failed closed');
    });

    test('null command in toolArgs fails closed', async () => {
      const input = {
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolName: 'bash',
        toolArgs: JSON.stringify({ command: null }),
      };

      await expectDeny(input, 'CC Safety Net failed closed');
    });

    test('empty string command in toolArgs fails closed', async () => {
      const input = {
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolName: 'bash',
        toolArgs: JSON.stringify({ command: '' }),
      };

      await expectDeny(input, 'CC Safety Net failed closed');
    });
  });
});
