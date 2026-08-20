import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { printStatusline } from '@/cli/statusline';
import {
  captureConsoleOutput,
  hermeticSafetyNetHome,
  runCCSafetyNetCli,
  withEnv,
} from '../helpers.ts';

const hermeticHome = hermeticSafetyNetHome('cc-safety-net-statusline-home-');

function clearEnv(): void {
  delete process.env.CC_SAFETY_NET_STRICT;
  delete process.env.CC_SAFETY_NET_LEVEL;
  delete process.env.CC_SAFETY_NET_PARANOID;
  delete process.env.CC_SAFETY_NET_PARANOID_RM;
  delete process.env.CC_SAFETY_NET_PARANOID_INTERPRETERS;
  delete process.env.CC_SAFETY_NET_WORKTREE;
  process.env.CC_SAFETY_NET_HOME = hermeticHome;
  delete process.env.SAFETY_NET_STRICT;
  delete process.env.SAFETY_NET_PARANOID;
  delete process.env.SAFETY_NET_PARANOID_RM;
  delete process.env.SAFETY_NET_PARANOID_INTERPRETERS;
  delete process.env.SAFETY_NET_WORKTREE;
  delete process.env.CLAUDE_SETTINGS_PATH;
}

async function runStatusline(env: Record<string, string>) {
  const result = await withEnv(env, () =>
    captureConsoleOutput(() => printStatusline(Readable.from([]))),
  );
  return {
    output: result.stdout.join('\n').trim(),
    stderr: result.stderr.join('\n'),
    exitCode: 0,
  };
}

async function runStatuslineWithStdin(stdin: string, env: Record<string, string>) {
  const cli = join(process.cwd(), 'src/cli/cc-safety-net.ts');
  const proc = Bun.spawn([process.execPath, cli, 'statusline', '--claude-code'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  // The bounded reader destroys its stdin at the cap, so flushing an oversized
  // payload can fail with EPIPE — the expected outcome, not a harness error.
  await Promise.resolve(proc.stdin.write(stdin)).catch(() => {});
  await Promise.resolve(proc.stdin.end()).catch(() => {});
  const output = await new Response(proc.stdout).text();
  return { output: output.trim(), exitCode: await proc.exited };
}

async function expectStatusline(env: Record<string, string>, output: string) {
  const result = await runStatusline(env);
  expect(result.output).toBe(output);
  expect(result.exitCode).toBe(0);
}

describe('statusline command', () => {
  // Create a temp settings file with plugin enabled to test statusline modes
  // When settings file doesn't exist, isPluginEnabled() defaults to false (disabled)
  let tempDir: string;
  let enabledSettingsPath: string;

  beforeEach(async () => {
    clearEnv();
    tempDir = await mkdtemp(join(tmpdir(), 'safety-net-statusline-'));
    enabledSettingsPath = join(tempDir, 'settings.json');
    await writeFile(
      enabledSettingsPath,
      JSON.stringify({
        enabledPlugins: { 'cc-safety-net@cc-marketplace': true },
      }),
    );
    process.env.CLAUDE_SETTINGS_PATH = enabledSettingsPath;
  });

  afterEach(async () => {
    clearEnv();
    await rm(tempDir, { recursive: true, force: true });
  });

  const modes: Array<{ name: string; env: Record<string, string>; output: string }> = [
    { name: 'no env flags', env: {}, output: '🛡️ CC Safety Net ✅' },
    { name: 'SAFETY_NET_STRICT=1', env: { SAFETY_NET_STRICT: '1' }, output: '🛡️ CC Safety Net 🔒' },
    {
      name: 'SAFETY_NET_PARANOID=1',
      env: { SAFETY_NET_PARANOID: '1' },
      output: '🛡️ CC Safety Net 🔧',
    },
    {
      name: 'CC_SAFETY_NET_PARANOID=1',
      env: { CC_SAFETY_NET_PARANOID: '1' },
      output: '🛡️ CC Safety Net 🔧',
    },
    {
      name: 'SAFETY_NET_WORKTREE=1',
      env: { SAFETY_NET_WORKTREE: '1' },
      output: '🛡️ CC Safety Net ✅🌳',
    },
    {
      name: 'strict and paranoid',
      env: { SAFETY_NET_STRICT: '1', SAFETY_NET_PARANOID: '1' },
      output: '🛡️ CC Safety Net 👁️',
    },
    {
      name: 'SAFETY_NET_PARANOID_RM=1 only',
      env: { SAFETY_NET_PARANOID_RM: '1' },
      output: '🛡️ CC Safety Net 🔧',
    },
    {
      name: 'strict and paranoid rm',
      env: { SAFETY_NET_STRICT: '1', SAFETY_NET_PARANOID_RM: '1' },
      output: '🛡️ CC Safety Net 🔧',
    },
    {
      name: 'SAFETY_NET_PARANOID_INTERPRETERS=1',
      env: { SAFETY_NET_PARANOID_INTERPRETERS: '1' },
      output: '🛡️ CC Safety Net 🔧',
    },
    {
      name: 'strict and paranoid interpreters',
      env: { SAFETY_NET_STRICT: '1', SAFETY_NET_PARANOID_INTERPRETERS: '1' },
      output: '🛡️ CC Safety Net 🔧',
    },
    {
      name: 'both granular paranoid flags',
      env: { SAFETY_NET_PARANOID_RM: '1', SAFETY_NET_PARANOID_INTERPRETERS: '1' },
      output: '🛡️ CC Safety Net 🔧',
    },
    {
      name: 'strict and both granular paranoid flags',
      env: {
        SAFETY_NET_STRICT: '1',
        SAFETY_NET_PARANOID_RM: '1',
        SAFETY_NET_PARANOID_INTERPRETERS: '1',
      },
      output: '🛡️ CC Safety Net 👁️',
    },
  ];

  modes.forEach((mode) => {
    test(`shows ${mode.name}`, async () => {
      await expectStatusline(
        { CLAUDE_SETTINGS_PATH: enabledSettingsPath, ...mode.env },
        mode.output,
      );
    });
  });

  test('shows custom for a rule override that changes inherited behavior', async () => {
    await writeFile(
      join(tempDir, 'policy.json'),
      JSON.stringify({
        version: 1,
        destructive_command_protection: {
          overrides: { 'shell.dynamic-executable': 'on' },
        },
      }),
    );

    await expectStatusline(
      { CLAUDE_SETTINGS_PATH: enabledSettingsPath, CC_SAFETY_NET_HOME: tempDir },
      '🛡️ CC Safety Net 🔧',
    );
  });

  test('marks a degraded fallback policy after the level emoji', async () => {
    await writeFile(
      join(tempDir, 'policy.json'),
      JSON.stringify({ version: 1, not_a_real_field: true }),
    );

    await expectStatusline(
      { CLAUDE_SETTINGS_PATH: enabledSettingsPath, CC_SAFETY_NET_HOME: tempDir },
      '🛡️ CC Safety Net ✅⚠️',
    );
  });

  test('marks an unreadable rule configuration after the level emoji', async () => {
    await mkdir(join(tempDir, 'rules'), { recursive: true });
    await writeFile(join(tempDir, 'rules', 'rule.json'), '{ invalid');

    await expectStatusline(
      { CLAUDE_SETTINGS_PATH: enabledSettingsPath, CC_SAFETY_NET_HOME: tempDir },
      '🛡️ CC Safety Net ✅⚠️',
    );
  });

  test('prefixes piped text', async () => {
    const result = await runStatuslineWithStdin('upstream context', {
      CLAUDE_SETTINGS_PATH: enabledSettingsPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('upstream context | 🛡️ CC Safety Net ✅');
  });

  test('drops piped input larger than the bounded stdin limit', async () => {
    const result = await runStatuslineWithStdin('a'.repeat(9 * 1024 * 1024), {
      CLAUDE_SETTINGS_PATH: enabledSettingsPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('🛡️ CC Safety Net ✅');
  });

  test('keeps the preset emoji for a redundant rule override', async () => {
    await writeFile(
      join(tempDir, 'policy.json'),
      JSON.stringify({
        version: 1,
        safety: { level: 'strict' },
        destructive_command_protection: {
          overrides: { 'shell.dynamic-executable': 'on' },
        },
      }),
    );

    await expectStatusline(
      { CLAUDE_SETTINGS_PATH: enabledSettingsPath, CC_SAFETY_NET_HOME: tempDir },
      '🛡️ CC Safety Net 🔒',
    );
  });
});

describe('statusline command routing', () => {
  test('supports short Claude Code flag', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'safety-net-statusline-'));
    const settingsPath = join(tempDir, 'settings.json');
    try {
      await writePluginSettings(settingsPath, true);
      const result = await runCCSafetyNetCli(['statusline', '-cc'], {
        CLAUDE_SETTINGS_PATH: settingsPath,
      });

      expect(result.output.trim()).toBe('🛡️ CC Safety Net ✅');
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('supports legacy --statusline flag', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'safety-net-statusline-'));
    const settingsPath = join(tempDir, 'settings.json');
    try {
      await writePluginSettings(settingsPath, true);
      const preferred = await runCCSafetyNetCli(['statusline', '--claude-code'], {
        CLAUDE_SETTINGS_PATH: settingsPath,
      });
      const legacy = await runCCSafetyNetCli(['--statusline'], {
        CLAUDE_SETTINGS_PATH: settingsPath,
      });

      expect(legacy.exitCode).toBe(0);
      expect(legacy.output).toBe(preferred.output);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('statusline without platform flag prints help on stderr and exits nonzero', async () => {
    const result = await runCCSafetyNetCli(['statusline']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('statusline requires --claude-code (-cc)');
    expect(result.stderr).toContain('USAGE:\n  cc-safety-net statusline');
    expect(result.stderr).toContain('-cc, --claude-code');
    expect(result.output).toBe('');
  });
});

describe('statusline enabled/disabled detection', () => {
  let tempDir: string;

  beforeEach(async () => {
    clearEnv();
    tempDir = await mkdtemp(join(tmpdir(), 'safety-net-test-'));
  });

  afterEach(async () => {
    clearEnv();
    await rm(tempDir, { recursive: true, force: true });
  });

  test('shows ❌ when plugin is disabled in settings', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writePluginSettings(settingsPath, false);
    await expectStatusline({ CLAUDE_SETTINGS_PATH: settingsPath }, '🛡️ CC Safety Net ❌');
  });

  test('shows ✅ when plugin is enabled in settings', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writePluginSettings(settingsPath, true);
    await expectStatusline({ CLAUDE_SETTINGS_PATH: settingsPath }, '🛡️ CC Safety Net ✅');
  });

  test('shows ❌ when settings file does not exist (default disabled)', async () => {
    const settingsPath = join(tempDir, 'nonexistent.json');

    await expectStatusline({ CLAUDE_SETTINGS_PATH: settingsPath }, '🛡️ CC Safety Net ❌');
  });

  test('shows ❌ when enabledPlugins key is missing (default disabled)', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ model: 'opus' }));

    await expectStatusline({ CLAUDE_SETTINGS_PATH: settingsPath }, '🛡️ CC Safety Net ❌');
  });

  test('logs invalid settings only in debug mode', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writeFile(settingsPath, '{ invalid json }');

    const result = await runStatusline({
      CLAUDE_SETTINGS_PATH: settingsPath,
      CC_SAFETY_NET_DEBUG: '1',
    });

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('🛡️ CC Safety Net ❌');
    expect(result.stderr).toContain('CC Safety Net debug: failed to read Claude settings:');
    expect(result.stderr).toContain(settingsPath);
  });

  test('disabled plugin ignores mode flags (shows ❌ only)', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writePluginSettings(settingsPath, false);
    await expectStatusline(
      { CLAUDE_SETTINGS_PATH: settingsPath, SAFETY_NET_STRICT: '1', SAFETY_NET_PARANOID: '1' },
      '🛡️ CC Safety Net ❌',
    );
  });

  test('enabled plugin with modes shows mode emojis', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writePluginSettings(settingsPath, true);
    await expectStatusline(
      { CLAUDE_SETTINGS_PATH: settingsPath, SAFETY_NET_STRICT: '1' },
      '🛡️ CC Safety Net 🔒',
    );
  });
});

async function writePluginSettings(path: string, enabled: boolean) {
  await writeFile(
    path,
    JSON.stringify({
      enabledPlugins: {
        'cc-safety-net@cc-marketplace': enabled,
      },
    }),
  );
}
