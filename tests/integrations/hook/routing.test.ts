import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findHookIntegrationByFlag,
  findLegacyTopLevelHookIntegration,
} from '@/cli/hook-integrations';
import { getAntigravityCliToolRoute } from '@/integrations/antigravity-cli/hook';
import { getClaudeCodeToolRoute } from '@/integrations/claude-code/hook';
import { getCopilotCliToolRoute } from '@/integrations/copilot-cli/hook';
import { getCursorToolRoute } from '@/integrations/cursor/hook';
import { getGeminiCliToolRoute } from '@/integrations/gemini-cli/hook';
import { getKimiCodeToolRoute } from '@/integrations/kimi-code/hook';
import { writeLockedGitHubRulebookPolicy } from '../../helpers.ts';
import {
  antigravityShellInput,
  claudeCodeBashInput,
  copilotBashInput,
  expectNoHookOutput,
  geminiShellInput,
  getHookDenyReason,
  type HookFormat,
  type HookResult,
  kimiShellInput,
  runAntigravityHookDirect as runAntigravityHook,
  runClaudeCodeHookDirect as runClaudeCodeHook,
  runCli,
  runCopilotHookDirect as runCopilotHook,
  runGeminiHookDirect as runGeminiHook,
  runKimiHookDirect as runKimiHook,
} from '../hook-helpers';

const SHARED_HOOK_FORMATS = [
  'claude-code',
  'gemini-cli',
  'kimi-code',
  'copilot-cli',
  'antigravity-cli',
] as const;

describe('hook command routing', () => {
  test('Claude Code hook manifest does not use explicit PreToolUse matcher', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'hooks/hooks.json'), 'utf-8'));

    expect(manifest.hooks.PreToolUse[0]).not.toHaveProperty('matcher');
  });

  test('adapters establish command capability only for exact verified tool names', () => {
    expect([
      getClaudeCodeToolRoute('Bash'),
      getClaudeCodeToolRoute('PowerShell'),
      getClaudeCodeToolRoute('bash'),
      getGeminiCliToolRoute('run_shell_command'),
      getGeminiCliToolRoute('Run_Shell_Command'),
      getKimiCodeToolRoute('Bash'),
      getKimiCodeToolRoute('bash'),
      getCopilotCliToolRoute('bash'),
      getCopilotCliToolRoute('Bash'),
      getCopilotCliToolRoute('powershell'),
      getCopilotCliToolRoute('PowerShell'),
      getAntigravityCliToolRoute('run_command'),
      getAntigravityCliToolRoute('Run_Command'),
    ]).toEqual([
      { kind: 'command', shell: 'posix' },
      { kind: 'command', shell: 'powershell' },
      { kind: 'unknown' },
      { kind: 'command', shell: 'auto' },
      { kind: 'unknown' },
      { kind: 'command', shell: 'posix' },
      { kind: 'unknown' },
      { kind: 'command', shell: 'auto' },
      { kind: 'command', shell: 'auto' },
      { kind: 'command', shell: 'powershell' },
      { kind: 'command', shell: 'powershell' },
      { kind: 'command', shell: 'auto' },
      { kind: 'unknown' },
    ]);

    expect([
      getClaudeCodeToolRoute('apply-patch'),
      getGeminiCliToolRoute('Grep'),
      getKimiCodeToolRoute('ReadFile'),
      getCopilotCliToolRoute('glob'),
      getAntigravityCliToolRoute('write_to_file'),
    ]).toEqual([
      { kind: 'patch' },
      { kind: 'grep' },
      { kind: 'path' },
      { kind: 'glob' },
      { kind: 'path' },
    ]);
  });

  test('Cursor adapter routes Shell to auto shell and file tools to protections', () => {
    expect([
      getCursorToolRoute('Shell'),
      getCursorToolRoute('shell'),
      getCursorToolRoute('Read'),
      getCursorToolRoute('apply_patch'),
    ]).toEqual([
      { kind: 'command', shell: 'auto' },
      { kind: 'unknown' },
      { kind: 'path' },
      { kind: 'patch' },
    ]);
  });

  test('all shared adapters keep patch command fields out of destructive analysis', async () => {
    const command = [
      '*** Begin Patch',
      '*** Update File: tests/example.test.ts',
      '@@',
      ' rm -rf ~',
      '*** End Patch',
    ].join('\n');

    await Promise.all([
      expectNoHookOutput(runClaudeCodeHook, {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command },
      }),
      expectNoHookOutput(runGeminiHook, {
        hook_event_name: 'BeforeTool',
        tool_name: 'apply_patch',
        tool_input: { command },
      }),
      expectNoHookOutput(runKimiHook, {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command },
      }),
      expectNoHookOutput(runCopilotHook, {
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolName: 'apply_patch',
        toolArgs: JSON.stringify({ command }),
      }),
      expectNoHookOutput(runAntigravityHook, {
        toolCall: { name: 'apply_patch', args: { command } },
        workspacePaths: [process.cwd()],
      }),
    ]);
  });

  test('unknown named tools retain path protection without destructive analysis', async () => {
    await Promise.all([
      expectNoHookOutput(runClaudeCodeHook, {
        hook_event_name: 'PreToolUse',
        tool_name: 'custom_command',
        tool_input: { command: 'git reset --hard' },
      }),
      expectNoHookOutput(runGeminiHook, {
        hook_event_name: 'BeforeTool',
        tool_name: 'custom_command',
        tool_input: { command: 'git reset --hard' },
      }),
      expectNoHookOutput(runKimiHook, {
        hook_event_name: 'PreToolUse',
        tool_name: 'custom_command',
        tool_input: { command: 'git reset --hard' },
      }),
      expectNoHookOutput(runCopilotHook, {
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolName: 'custom_command',
        toolArgs: JSON.stringify({ command: 'git reset --hard' }),
      }),
      expectNoHookOutput(runAntigravityHook, {
        toolCall: { name: 'custom_command', args: { command: 'git reset --hard' } },
        workspacePaths: [process.cwd()],
      }),
    ]);

    expect(
      getHookDenyReason(
        await runClaudeCodeHook({
          hook_event_name: 'PreToolUse',
          tool_name: 'custom_command',
          tool_input: { command: 'cat .env' },
        }),
        'claude-code',
      ),
    ).toContain('Access to a sensitive path is not allowed.');
  });

  test('auto-shell adapters retain PowerShell destructive detection', async () => {
    const command = 'Remove-Item . -Recurse -Force';
    expect(
      getHookDenyReason(await runGeminiHook(geminiShellInput(command)), 'gemini-cli'),
    ).toContain('powershell.remove-item-recursive-force-cwd-self');
    expect(
      getHookDenyReason(
        await runAntigravityHook(antigravityShellInput(command)),
        'antigravity-cli',
      ),
    ).toContain('powershell.remove-item-recursive-force-cwd-self');
  });

  test('recognized command adapters fail closed once for malformed commands', async () => {
    for (const command of [undefined, null, '', 42]) {
      const cases = await Promise.all([
        runClaudeCodeHook({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
        }),
        runGeminiHook({
          hook_event_name: 'BeforeTool',
          tool_name: 'run_shell_command',
          tool_input: { command },
        }),
        runKimiHook({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
        }),
        runCopilotHook({
          timestamp: Date.now(),
          cwd: process.cwd(),
          toolName: 'bash',
          toolArgs: JSON.stringify({ command }),
        }),
        runAntigravityHook({
          toolCall: { name: 'run_command', args: { CommandLine: command } },
          workspacePaths: [process.cwd()],
        }),
      ]);

      expectAllSingleFailClosed(cases);
    }
  });

  test('supported events fail closed once for missing or empty tool names', async () => {
    const cases = await Promise.all([
      runClaudeCodeHook({ hook_event_name: 'PreToolUse', tool_input: {} }),
      runGeminiHook({ hook_event_name: 'BeforeTool', tool_name: '', tool_input: {} }),
      runKimiHook({ hook_event_name: 'PreToolUse', tool_input: {} }),
      runCopilotHook({
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolName: '',
        toolArgs: '{}',
      }),
      runAntigravityHook({ toolCall: { args: {} }, workspacePaths: [process.cwd()] }),
    ]);
    expectAllSingleFailClosed(cases);
  });

  test('malformed JSON envelopes fail closed once in every shared adapter', async () => {
    for (const input of ['null', 'false', '0', '""', '[]']) {
      expectSingleFailClosed(await runClaudeCodeHook(input), 'claude-code');
    }

    expectAllSingleFailClosed(
      await Promise.all([
        runClaudeCodeHook('null'),
        runGeminiHook('null'),
        runKimiHook('null'),
        runCopilotHook('null'),
        runAntigravityHook('null'),
      ]),
    );
  });

  test('each hook format keeps real subprocess transport coverage', async () => {
    for (const hook of [
      {
        flag: '--coding-cli',
        format: 'claude-code' as const,
        input: claudeCodeBashInput,
        run: runClaudeCodeHook,
      },
      {
        flag: '-gc',
        format: 'gemini-cli' as const,
        input: geminiShellInput,
        run: runGeminiHook,
      },
      {
        flag: '-kc',
        format: 'kimi-code' as const,
        input: kimiShellInput,
        run: runKimiHook,
      },
      {
        flag: '-cp',
        format: 'copilot-cli' as const,
        input: copilotBashInput,
        run: runCopilotHook,
      },
      {
        flag: '-ac',
        format: 'antigravity-cli' as const,
        input: antigravityShellInput,
        run: runAntigravityHook,
      },
    ]) {
      const allowed = await hook.run(hook.input('git status'));
      const denied = await runCli(
        ['hook', hook.flag],
        JSON.stringify(hook.input('git reset --hard')),
      );
      const malformed = await hook.run('{');

      expect(allowed).toMatchObject({ exitCode: 0, stdout: '' });
      expect(getHookDenyReason(denied, hook.format)).toContain('git reset --hard');
      expect(malformed.stdout.split('\n')).toHaveLength(1);
      expect(getHookDenyReason(malformed, hook.format)).toContain(
        'Failed to parse hook input JSON.',
      );
    }
  });

  test('shared adapters fail closed once for unusable supplied working directories', async () => {
    const missing = join(tmpdir(), `safety-net-missing-cwd-${crypto.randomUUID()}`);
    const cases = await Promise.all([
      runClaudeCodeHook({ ...claudeCodeBashInput('git status'), cwd: missing }),
      runGeminiHook({ ...geminiShellInput('git status'), cwd: missing }),
      runKimiHook({ ...kimiShellInput('git status'), cwd: missing }),
      runCopilotHook({ ...copilotBashInput('git status'), cwd: missing }),
      runAntigravityHook({
        toolCall: { name: 'run_command', args: { CommandLine: 'git status', Cwd: missing } },
        workspacePaths: [process.cwd()],
      }),
    ]);
    expectAllSingleFailClosed(cases);
  });

  test('shared adapters fail closed once for empty or non-string supplied cwd values', async () => {
    for (const cwd of ['', '   ', null, 42]) {
      const cases = await Promise.all([
        runClaudeCodeHook({ ...claudeCodeBashInput('git status'), cwd }),
        runGeminiHook({ ...geminiShellInput('git status'), cwd }),
        runKimiHook({ ...kimiShellInput('git status'), cwd }),
        runCopilotHook({ ...copilotBashInput('git status'), cwd }),
      ]);

      for (const [index, result] of cases.entries()) {
        expectSingleFailClosed(result, SHARED_HOOK_FORMATS[index] ?? 'claude-code');
      }
    }
  });

  test('legacy top-level --claude-code alias routes to the hook command', async () => {
    const { stdout, exitCode } = await runCli(
      ['--claude-code'],
      JSON.stringify(claudeCodeBashInput('git reset --hard')),
    );

    const output = JSON.parse(stdout);
    expect(exitCode).toBe(0);
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('git reset --hard');
  });

  test('legacy nested --claude-code alias resolves to the Coding CLI hook', () => {
    expect(findHookIntegrationByFlag(['--claude-code'])?.id).toBe('claude-code');
  });

  test('top-level Coding CLI -cc alias resolves to the Coding CLI hook', () => {
    expect(findLegacyTopLevelHookIntegration('-cc')?.id).toBe('claude-code');
  });

  test('canonical --coding-cli flag requires the hook command', async () => {
    const { stderr, exitCode } = await runCli(['--coding-cli']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown option: --coding-cli');
  });

  test('Coding CLI hook keeps running when config loading throws', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'safety-net-hook-bad-config-'));
    try {
      writeLockedGitHubRulebookPolicy(cwd, '{}', { cacheAsDirectory: true });

      // An unreadable policy filesystem degrades to protective defaults rather than
      // denying every command, so an ordinary command still passes with no output.
      const { stdout, exitCode } = await runClaudeCodeHook({
        ...claudeCodeBashInput('echo ok'),
        cwd,
      });

      expect(exitCode).toBe(0);
      expect(stdout).toBe('');

      // The built-in protections the fallback carries keep denying.
      const denied = await runClaudeCodeHook({
        ...claudeCodeBashInput('git reset --hard'),
        cwd,
      });

      expect(denied.exitCode).toBe(0);
      expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('top-level non-Claude hook flags resolve to the hook command for compatibility', () => {
    expect(findLegacyTopLevelHookIntegration('-gc')?.id).toBe('gemini-cli');
  });

  test('Kimi Code resolves through hook command only', () => {
    expect(findHookIntegrationByFlag(['--kimi-code'])?.id).toBe('kimi-code');
  });

  test('Antigravity CLI resolves through hook command only', () => {
    expect(findHookIntegrationByFlag(['--agy-cli'])?.id).toBe('antigravity-cli');
  });

  test('hook kimi-code is not a platform subcommand', async () => {
    const { stdout, stderr, exitCode } = await runCli(['hook', 'kimi-code']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('cc-safety-net hook');
    expect(stderr).toContain('-kc, --kimi-code');
    expect(stdout).toBe('');
  });

  test('removed hook install syntax fails instead of running the integration', async () => {
    const { stdout, stderr, exitCode } = await runCli(
      ['hook', 'install', '--kimi-code'],
      JSON.stringify(kimiShellInput('git status')),
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('hook requires exactly one integration flag');
    expect(stderr).toContain('cc-safety-net hook');
    expect(stdout).toBe('');
  });

  test('top-level Kimi Code flags are not legacy compatibility aliases', () => {
    expect(findLegacyTopLevelHookIntegration('--kimi-code')).toBeUndefined();
    expect(findLegacyTopLevelHookIntegration('-kc')).toBeUndefined();
  });

  test('top-level Antigravity CLI flags are not legacy compatibility aliases', () => {
    expect(findLegacyTopLevelHookIntegration('--agy-cli')).toBeUndefined();
    expect(findLegacyTopLevelHookIntegration('-ac')).toBeUndefined();
  });

  test('does not route nested legacy hook flags outside the hook command', async () => {
    const { stderr, exitCode } = await runCli(
      ['xxx', '--claude-code'],
      JSON.stringify(claudeCodeBashInput('git reset --hard')),
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown command: xxx');
  });

  test('hook without platform flag prints hook help on stderr and exits nonzero', async () => {
    const { stdout, stderr, exitCode } = await runCli(['hook']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('cc-safety-net hook');
    expect(stderr).toContain('-ac, --agy-cli');
    expect(stderr).toContain('-cc, --coding-cli');
    expect(stderr).toContain('-cp, --copilot-cli');
    expect(stderr).toContain('-gc, --gemini-cli');
    expect(stderr).toContain('-kc, --kimi-code');
    expect(stdout).toBe('');
  });
});

function expectSingleFailClosed(result: HookResult, format: HookFormat): void {
  expect(result.stdout.split('\n')).toHaveLength(1);
  expect(getHookDenyReason(result, format)).toContain('CC Safety Net failed closed');
}

function expectAllSingleFailClosed(results: HookResult[]): void {
  for (const [index, result] of results.entries()) {
    expectSingleFailClosed(result, SHARED_HOOK_FORMATS[index] ?? 'claude-code');
  }
}
