import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expectNoHookOutput,
  expectSecretProtectionDeny,
  getHookDenyReason,
  kimiShellInput,
  runKimiHookDirect as runKimiHook,
  withHookTestContext,
  writeUserPolicy,
} from '../hook-helpers';

describe('Kimi Code hook', () => {
  describe('blocked commands', () => {
    test('blocks rm -rf via Bash tool', async () => {
      const { stdout, exitCode } = await runKimiHook(kimiShellInput('rm -rf /'));

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain('rm -rf');
    });
  });

  describe('allowed commands', () => {
    test('allows safe commands with no output', async () => {
      await expectNoHookOutput(runKimiHook, kimiShellInput('git status'));
    });
  });

  describe('non-target tool', () => {
    test('ignores non-Bash tools, and their cwd, when user policy disables secret protection', async () => {
      await withHookTestContext(async (context) => {
        writeUserPolicy(context.home, { version: 1, secret_protection: { enabled: false } });

        for (const toolInput of [{ file_path: '.env' }, { file_path: '.env', cwd: 42 }]) {
          await expectNoHookOutput(context.runKimiHook, {
            hook_event_name: 'PreToolUse',
            cwd: context.cwd,
            tool_name: 'ReadFile',
            tool_input: toolInput,
          });
        }
      });
    });

    test('secret protection blocks path-like non-Bash tool input', async () => {
      const result = await runKimiHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'ReadFile',
        tool_input: { file_path: '.env' },
      });

      expectSecretProtectionDeny(result, 'kimi-code');
    });
  });

  describe('non-target event', () => {
    test('ignores non-PreToolUse events', async () => {
      const input = {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      };

      await expectNoHookOutput(runKimiHook, input);
    });
  });

  describe('invalid JSON', () => {
    test('empty input produces deny output', async () => {
      const result = await runKimiHook('');

      expect(getHookDenyReason(result, 'kimi-code')).toContain('Missing hook input JSON.');
    });

    test('whitespace-only input produces deny output', async () => {
      const result = await runKimiHook('   \n\t  ');

      expect(getHookDenyReason(result, 'kimi-code')).toContain('Missing hook input JSON.');
    });

    test('non-strict mode blocks invalid JSON', async () => {
      const result = await runKimiHook('{invalid json');

      expect(getHookDenyReason(result, 'kimi-code')).toContain('Failed to parse hook input JSON.');
    });
  });

  describe('tool_input.cwd containment', () => {
    test('honors tool_input.cwd as the execution directory', async () => {
      await withHookTestContext(async (context) => {
        mkdirSync(join(context.cwd, 'repo', '.git'), { recursive: true });
        writeFileSync(join(context.cwd, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n');

        const result = await context.runKimiHook({
          hook_event_name: 'PreToolUse',
          session_id: 'kimi-test-session',
          cwd: context.cwd,
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf .', cwd: 'repo' },
        });

        expect(getHookDenyReason(result, 'kimi-code')).toContain('Rule: rm.git-metadata');
      });
    });

    test('allows a contained relative tool_input.cwd', async () => {
      await withHookTestContext(async (context) => {
        mkdirSync(join(context.cwd, 'app'));

        await expectNoHookOutput(context.runKimiHook, {
          hook_event_name: 'PreToolUse',
          cwd: context.cwd,
          tool_name: 'Bash',
          tool_input: { command: 'git status', cwd: 'app' },
        });
      });
    });

    test('denies non-string, empty, and unresolvable tool_input.cwd values', async () => {
      await withHookTestContext(async (context) => {
        for (const cwd of ['', '   ', null, 42, join(context.cwd, 'missing')]) {
          const result = await context.runKimiHook({
            hook_event_name: 'PreToolUse',
            cwd: context.cwd,
            tool_name: 'Bash',
            tool_input: { command: 'git status', cwd },
          });

          expect(getHookDenyReason(result, 'kimi-code')).toContain('CC Safety Net failed closed');
        }
      });
    });

    test('denies tool_input.cwd outside the session directory', async () => {
      await withHookTestContext(async (context) => {
        const outside = mkdtempSync(join(tmpdir(), 'safety-net-kimi-outside-'));
        try {
          const result = await context.runKimiHook({
            hook_event_name: 'PreToolUse',
            cwd: context.cwd,
            tool_name: 'Bash',
            tool_input: { command: 'git status', cwd: outside },
          });

          expect(getHookDenyReason(result, 'kimi-code')).toContain('CC Safety Net failed closed');
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      });
    });
  });

  describe('missing command', () => {
    test('missing command in tool_input fails closed', async () => {
      const input = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {},
      };

      expect(getHookDenyReason(await runKimiHook(input), 'kimi-code')).toContain(
        'CC Safety Net failed closed',
      );
    });
  });
});
