/**
 * Tests for the doctor command hooks functions.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasClaudeInstalledPlugin } from '@/integrations/claude-code/detect';
import { detectAllHooks } from '@/integrations/detect';
import type { HookStatus } from '@/integrations/doctor-types';
import { stripJsonComments } from '@/integrations/jsonc';
import { withEnv } from '../../helpers.ts';

function expectHookState(
  hook: HookStatus | undefined,
  state: 'configured' | 'disabled' | 'n/a',
): void {
  expect(hook).toMatchObject(
    state === 'configured'
      ? { detected: true, configured: true, inspectionStatus: 'verified' }
      : state === 'disabled'
        ? { detected: true, configured: false, inspectionStatus: 'verified' }
        : { detected: false, configured: false },
  );
}

function expectHookConfigPaths(hook: HookStatus | undefined, configPath: string): void {
  expect(hook?.configPath).toBe(configPath);
  expect(hook?.configPaths).toEqual([configPath]);
}

function expectNoHookError(hook: HookStatus | undefined, message: string): void {
  expect(hook?.errors?.some((error) => error.includes(message)) ?? false).toBe(false);
}

function withHookFixture<T>(
  name: string,
  run: (fixture: { tmpBase: string; homeDir: string; projectDir: string }) => T,
): T {
  const tmpBase = join(tmpdir(), `doctor-${name}-${Date.now()}`);
  const homeDir = join(tmpBase, 'home');
  const projectDir = join(tmpBase, 'project');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  try {
    return run({ tmpBase, homeDir, projectDir });
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

function findHook(
  platform: HookStatus['platform'],
  homeDir: string,
  projectDir: string,
  options: Omit<NonNullable<Parameters<typeof detectAllHooks>[1]>, 'homeDir'> = {},
): HookStatus | undefined {
  return detectAllHooks(projectDir, { ...options, homeDir }).find(
    (hook) => hook.platform === platform,
  );
}

function _writeConfigFile(filePath: string, content: string): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

function _writeCopilotPluginDir(homeDir: string): void {
  mkdirSync(join(homeDir, '.copilot', 'installed-plugins', 'cc-marketplace', 'cc-safety-net'), {
    recursive: true,
  });
}

function _writeCopilotHook(
  filePath: string,
  command: string = 'npx -y cc-safety-net hook --copilot-cli',
  commandKey: 'bash' | 'powershell' = 'bash',
): void {
  _writeConfigFile(
    filePath,
    JSON.stringify({
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: 'command',
            [commandKey]: command,
            cwd: '.',
            timeoutSec: 15,
          },
        ],
      },
    }),
  );
}

function _writeCopilotInlineConfig(
  filePath: string,
  command: string = 'npx -y cc-safety-net hook --copilot-cli',
  options: {
    commandKey?: 'command' | 'bash' | 'powershell';
    disableAllHooks?: boolean;
  } = {},
): void {
  const { commandKey = 'command', disableAllHooks } = options;
  _writeConfigFile(
    filePath,
    JSON.stringify({
      ...(disableAllHooks !== undefined ? { disableAllHooks } : {}),
      hooks: {
        preToolUse: [
          {
            type: 'command',
            [commandKey]: command,
            cwd: '.',
            timeoutSec: 15,
          },
        ],
      },
    }),
  );
}

function _expectCopilotConfig(
  homeDir: string,
  projectDir: string,
  version: string,
  state: 'configured' | 'n/a',
  configPath: string,
  writeConfig: (configPath: string) => void,
): HookStatus | undefined {
  writeConfig(configPath);
  const copilot = findHook('copilot-cli', homeDir, projectDir, {
    copilotCliVersion: version,
  });
  expectHookState(copilot, state);
  if (state === 'configured') {
    expectHookConfigPaths(copilot, configPath);
  }
  return copilot;
}

function _writeKimiConfig(configPath: string, content = 'cc-safety-net hook --kimi-code'): void {
  _writeConfigFile(configPath, content);
}

function _writeAntigravityHooks(homeDir: string, config: unknown): string {
  const configPath = join(homeDir, '.gemini', 'config', 'hooks.json');
  _writeConfigFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

describe('detectAllHooks', () => {
  test('detects configured hooks without attaching the shared engine self-test', () => {
    withHookFixture('hooks', ({ homeDir, projectDir }) => {
      const opencodeDir = join(homeDir, '.config', 'opencode');
      mkdirSync(opencodeDir, { recursive: true });
      writeFileSync(
        join(opencodeDir, 'opencode.jsonc'),
        `{
        // comment
        "plugin": ["cc-safety-net",],
      }`,
      );

      const copilotDir = join(projectDir, '.github', 'hooks');
      mkdirSync(copilotDir, { recursive: true });
      _writeCopilotHook(join(copilotDir, 'safety-net.json'));

      mkdirSync(join(homeDir, '.claude', 'plugins'), { recursive: true });
      writeFileSync(
        join(homeDir, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({ plugins: { 'cc-safety-net@cc-marketplace': [{ scope: 'user' }] } }),
      );
      writeFileSync(
        join(homeDir, '.claude', 'settings.json'),
        JSON.stringify({ enabledPlugins: { 'cc-safety-net@cc-marketplace': true } }),
      );
      mkdirSync(join(homeDir, '.gemini', 'extensions', 'gemini-safety-net'), { recursive: true });

      const hooks = withEnv({ XDG_CONFIG_HOME: undefined }, () =>
        detectAllHooks(projectDir, { homeDir }),
      );

      const claude = hooks.find((hook) => hook.platform === 'claude-code');
      expectHookState(claude, 'configured');
      expect(claude?.method).toBe('plugin config');
      expect(claude?.configPath).toBe(
        join(homeDir, '.claude', 'plugins', 'installed_plugins.json'),
      );
      expect(claude).not.toHaveProperty('selfTest');
      expect(hasClaudeInstalledPlugin(homeDir, 'cc-safety-net@cc-marketplace')).toBeTrue();
      expect(hasClaudeInstalledPlugin(homeDir, 'safety-net@cc-marketplace')).toBeFalse();

      const opencode = hooks.find((hook) => hook.platform === 'opencode');
      expectHookState(opencode, 'configured');
      expect(opencode?.method).toBe('plugin array');
      expect(opencode).not.toHaveProperty('selfTest');

      const gemini = hooks.find((hook) => hook.platform === 'gemini-cli');
      expectHookState(gemini, 'configured');
      expect(gemini?.method).toBe('extension config');
      expect(gemini).not.toHaveProperty('selfTest');

      const copilot = hooks.find((hook) => hook.platform === 'copilot-cli');
      expectHookState(copilot, 'configured');
      expect(copilot?.method).toBe('hook config');
      expect(copilot).not.toHaveProperty('selfTest');

      const kimi = hooks.find((hook) => hook.platform === 'kimi-code');
      expectHookState(kimi, 'n/a');
    });
  });

  test('orders doctor hooks with coding CLIs alphabetical after Claude Code', () => {
    withHookFixture('hooks', ({ homeDir, projectDir }) => {
      expect(detectAllHooks(projectDir, { homeDir }).map((hook) => hook.platform)).toEqual([
        'claude-code',
        'amp',
        'antigravity-cli',
        'codex',
        'cursor',
        'gemini-cli',
        'copilot-cli',
        'hermes-agent',
        'kimi-code',
        'openclaw',
        'opencode',
        'pi',
      ]);
    });
  });

  test('Antigravity CLI: configured when hooks.json contains managed hook command', () => {
    withHookFixture('antigravity', ({ homeDir, projectDir }) => {
      const configPath = _writeAntigravityHooks(homeDir, {
        'cc-safety-net': {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'npx -y cc-safety-net hook --agy-cli',
                  timeout: 30,
                },
              ],
            },
          ],
        },
      });

      const antigravity = findHook('antigravity-cli', homeDir, projectDir);

      expectHookState(antigravity, 'configured');
      expect(antigravity?.method).toBe('hook config');
      expect(antigravity?.configPath).toBe(configPath);
      expect(antigravity).not.toHaveProperty('selfTest');
    });
  });

  test('Antigravity CLI: configured when hooks.json contains short flag hook command', () => {
    withHookFixture('antigravity', ({ homeDir, projectDir }) => {
      const configPath = _writeAntigravityHooks(homeDir, {
        'cc-safety-net': {
          PreToolUse: [{ hooks: [{ command: 'bunx cc-safety-net hook -ac' }] }],
        },
      });

      const antigravity = findHook('antigravity-cli', homeDir, projectDir);

      expectHookState(antigravity, 'configured');
      expect(antigravity?.configPath).toBe(configPath);
    });
  });

  test('Antigravity CLI: disabled when only matching hook definition is disabled', () => {
    withHookFixture('antigravity', ({ homeDir, projectDir }) => {
      const configPath = _writeAntigravityHooks(homeDir, {
        'cc-safety-net': {
          enabled: false,
          PreToolUse: [{ hooks: [{ command: 'npx -y cc-safety-net hook --agy-cli' }] }],
        },
      });
      const antigravity = findHook('antigravity-cli', homeDir, projectDir);

      expectHookState(antigravity, 'disabled');
      expect(antigravity?.method).toBe('hook config');
      expect(antigravity?.configPath).toBe(configPath);
      expect(antigravity).not.toHaveProperty('selfTest');
    });
  });

  test('Antigravity CLI: n/a when hooks.json is missing', () => {
    withHookFixture('antigravity', ({ homeDir, projectDir }) => {
      const antigravity = findHook('antigravity-cli', homeDir, projectDir);

      expectHookState(antigravity, 'n/a');
      expect(antigravity?.inspectionStatus).toBe('not-applicable');
      expect(antigravity?.configPath).toBe(join(homeDir, '.gemini', 'config', 'hooks.json'));
      expect(antigravity).not.toHaveProperty('selfTest');
    });
  });

  test('Antigravity CLI: n/a with error when hooks.json is malformed', () => {
    withHookFixture('antigravity', ({ homeDir, projectDir }) => {
      const configPath = join(homeDir, '.gemini', 'config', 'hooks.json');
      mkdirSync(join(configPath, '..'), { recursive: true });
      writeFileSync(configPath, '{ invalid json');
      const antigravity = findHook('antigravity-cli', homeDir, projectDir);

      expectHookState(antigravity, 'n/a');
      expect(antigravity?.inspectionStatus).toBe('failed');
      expect(antigravity?.configPath).toBe(configPath);
      expect(
        antigravity?.errors?.some((error) =>
          error.includes('Failed to parse Antigravity hooks config'),
        ),
      ).toBe(true);
    });
  });

  function _writeCursorHooks(homeDir: string, config: unknown): string {
    const configPath = join(homeDir, '.cursor', 'hooks.json');
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  test('Cursor: n/a when hooks.json is missing', () => {
    withHookFixture('cursor', ({ homeDir, projectDir }) => {
      const cursor = findHook('cursor', homeDir, projectDir);
      expectHookState(cursor, 'n/a');
      expect(cursor?.inspectionStatus).toBe('not-applicable');
      expect(cursor?.configPath).toBe(join(homeDir, '.cursor', 'hooks.json'));
    });
  });

  test('Cursor: configured with no drift for canonical managed entry', () => {
    withHookFixture('cursor', ({ homeDir, projectDir }) => {
      const configPath = _writeCursorHooks(homeDir, {
        version: 1,
        hooks: {
          preToolUse: [
            { command: 'npx -y cc-safety-net hook --cursor', timeout: 30, failClosed: true },
          ],
        },
      });
      const cursor = findHook('cursor', homeDir, projectDir);

      expectHookState(cursor, 'configured');
      expect(cursor?.method).toBe('hook config');
      expect(cursor?.configPath).toBe(configPath);
      expect(cursor?.errors).toBeUndefined();
    });
  });

  test('Cursor: configured with drift warning when failClosed is missing', () => {
    withHookFixture('cursor', ({ homeDir, projectDir }) => {
      _writeCursorHooks(homeDir, {
        version: 1,
        hooks: {
          preToolUse: [{ command: 'npx -y cc-safety-net hook --cursor', timeout: 30 }],
        },
      });
      const cursor = findHook('cursor', homeDir, projectDir);

      expectHookState(cursor, 'configured');
      expect(cursor?.errors?.some((error) => error.includes('failClosed'))).toBe(true);
    });
  });

  test('Cursor: configured with drift warning for duplicate managed entries', () => {
    withHookFixture('cursor', ({ homeDir, projectDir }) => {
      _writeCursorHooks(homeDir, {
        version: 1,
        hooks: {
          preToolUse: [
            { command: 'npx -y cc-safety-net hook --cursor', timeout: 30, failClosed: true },
            { command: 'npx -y cc-safety-net hook --cursor', timeout: 30, failClosed: true },
          ],
        },
      });
      const cursor = findHook('cursor', homeDir, projectDir);

      expectHookState(cursor, 'configured');
      expect(cursor?.errors?.some((error) => error.includes('Multiple'))).toBe(true);
    });
  });

  test('Cursor: n/a with error when hooks.json is malformed', () => {
    withHookFixture('cursor', ({ homeDir, projectDir }) => {
      const configPath = join(homeDir, '.cursor', 'hooks.json');
      mkdirSync(join(configPath, '..'), { recursive: true });
      writeFileSync(configPath, '{ invalid json');
      const cursor = findHook('cursor', homeDir, projectDir);

      expectHookState(cursor, 'n/a');
      expect(cursor?.inspectionStatus).toBe('failed');
      expect(cursor?.configPath).toBe(configPath);
      expect(
        cursor?.errors?.some((error) => error.includes('Failed to parse Cursor hooks config')),
      ).toBe(true);
    });
  });

  test('Cursor: n/a when config has no managed command', () => {
    withHookFixture('cursor', ({ homeDir, projectDir }) => {
      _writeCursorHooks(homeDir, {
        version: 1,
        hooks: { preToolUse: [{ command: 'some-other-tool' }] },
      });
      const cursor = findHook('cursor', homeDir, projectDir);

      expectHookState(cursor, 'n/a');
    });
  });

  test('Amp: n/a when the amp plugin list is unavailable', () => {
    withHookFixture('amp', ({ homeDir, projectDir }) => {
      const amp = findHook('amp', homeDir, projectDir, { ampPluginListOutput: null });

      expectHookState(amp, 'n/a');
      expect(amp?.inspectionStatus).toBe('not-applicable');
    });
  });

  test('Amp: configured from the personal plugins repository', () => {
    withHookFixture('amp', ({ homeDir, projectDir }) => {
      const amp = findHook('amp', homeDir, projectDir, {
        ampPluginListOutput: '\u2713 cc-safety-net (User Plugins) active\n  events: tool.call',
      });

      expectHookState(amp, 'configured');
      expect(amp?.method).toBe('amp plugins list');
      expect(amp?.errors).toBeUndefined();
    });
  });

  test('Amp: n/a when the plugin is active outside the personal plugins scope', () => {
    withHookFixture('amp', ({ homeDir, projectDir }) => {
      const amp = findHook('amp', homeDir, projectDir, {
        ampPluginListOutput: '\u2713 cc-safety-net (Workspace Plugins) active\n  events: tool.call',
      });

      expectHookState(amp, 'n/a');
    });
  });

  test('reports parse errors for invalid hook configs', () => {
    withHookFixture('hooks', ({ homeDir, projectDir }) => {
      _writeConfigFile(join(homeDir, '.config', 'opencode', 'opencode.json'), '{ invalid json }');
      const hooks = withEnv({ XDG_CONFIG_HOME: undefined }, () =>
        detectAllHooks(projectDir, { homeDir }),
      );

      const claude = hooks.find((hook) => hook.platform === 'claude-code');
      expectHookState(claude, 'n/a');
      expect(claude?.errors).toBeUndefined();

      const opencode = hooks.find((hook) => hook.platform === 'opencode');
      expectHookState(opencode, 'n/a');
      expect(opencode?.errors?.some((e) => e.includes('Failed to parse'))).toBe(true);

      const gemini = hooks.find((hook) => hook.platform === 'gemini-cli');
      expectHookState(gemini, 'n/a');
      expect(gemini?.errors).toBeUndefined();
    });
  });

  test('continues checking fallback configs after parse errors (OpenCode)', () => {
    withHookFixture('hooks', ({ homeDir, projectDir }) => {
      const opencodeDir = join(homeDir, '.config', 'opencode');
      _writeConfigFile(join(opencodeDir, 'opencode.json'), '{ invalid json }');
      writeFileSync(
        join(opencodeDir, 'opencode.jsonc'),
        `{
        // This is valid JSONC
        "plugin": ["cc-safety-net"]
      }`,
      );
      const opencode = withEnv({ XDG_CONFIG_HOME: undefined }, () =>
        findHook('opencode', homeDir, projectDir),
      );

      expectHookState(opencode, 'configured');
      expect(opencode?.method).toBe('plugin array');
      expect(opencode?.errors?.some((e) => e.includes('Failed to parse'))).toBe(true);
    });
  });

  test('OpenCode: finds the config under XDG_CONFIG_HOME', () => {
    withHookFixture('hooks', ({ homeDir, projectDir }) => {
      const xdgConfigHome = join(homeDir, 'xdg-config');
      const configPath = join(xdgConfigHome, 'opencode', 'opencode.json');
      _writeConfigFile(configPath, JSON.stringify({ plugin: ['cc-safety-net@latest'] }));

      const opencode = withEnv({ XDG_CONFIG_HOME: xdgConfigHome }, () =>
        findHook('opencode', homeDir, projectDir),
      );

      expectHookState(opencode, 'configured');
      expect(opencode?.configPath).toBe(configPath);
    });
  });

  test('Kimi Code: configured when home config contains hook command', () => {
    withHookFixture('kimi', ({ homeDir, projectDir }) => {
      const configPath = join(homeDir, '.kimi-code', 'config.toml');
      _writeKimiConfig(configPath);
      const kimi = findHook('kimi-code', homeDir, projectDir);

      expectHookState(kimi, 'configured');
      expect(kimi?.method).toBe('hook config');
      expect(kimi?.configPath).toBe(configPath);
      expect(kimi).not.toHaveProperty('selfTest');
    });
  });

  test('Kimi Code: configured when hook command is quoted in TOML', () => {
    withHookFixture('kimi', ({ homeDir, projectDir }) => {
      const configPath = join(homeDir, '.kimi-code', 'config.toml');
      _writeKimiConfig(configPath, 'pre_tool_use = "cc-safety-net hook --kimi-code"');
      const kimi = findHook('kimi-code', homeDir, projectDir);

      expectHookState(kimi, 'configured');
      expect(kimi?.configPath).toBe(configPath);
    });
  });

  test('Kimi Code: configured from KIMI_CODE_HOME config', () => {
    withHookFixture('kimi', ({ tmpBase, homeDir, projectDir }) => {
      const kimiShareDir = join(tmpBase, 'kimi-share');
      const configPath = join(kimiShareDir, 'config.toml');
      _writeKimiConfig(configPath, 'bunx cc-safety-net hook --kimi-code');
      const kimi = withEnv({ KIMI_CODE_HOME: kimiShareDir }, () =>
        findHook('kimi-code', homeDir, projectDir),
      );

      expectHookState(kimi, 'configured');
      expect(kimi?.configPath).toBe(configPath);
    });
  });

  test('Kimi Code: n/a when config file is missing', () => {
    withHookFixture('kimi', ({ homeDir, projectDir }) => {
      const kimi = findHook('kimi-code', homeDir, projectDir);

      expectHookState(kimi, 'n/a');
      expect(kimi?.configPath).toBe(join(homeDir, '.kimi-code', 'config.toml'));
      expect(kimi).not.toHaveProperty('selfTest');
    });
  });

  test('Kimi Code: n/a when config does not contain hook command', () => {
    withHookFixture('kimi', ({ homeDir, projectDir }) => {
      const configPath = join(homeDir, '.kimi-code', 'config.toml');
      _writeKimiConfig(configPath, 'hooks = []');
      const kimi = findHook('kimi-code', homeDir, projectDir);

      expectHookState(kimi, 'n/a');
      expect(kimi?.configPath).toBe(configPath);
      expect(kimi).not.toHaveProperty('selfTest');
    });
  });

  test('Kimi Code: n/a with error when config cannot be read', () => {
    withHookFixture('kimi', ({ homeDir, projectDir }) => {
      const configPath = join(homeDir, '.kimi-code', 'config.toml');
      mkdirSync(configPath, { recursive: true });
      const kimi = findHook('kimi-code', homeDir, projectDir);

      expectHookState(kimi, 'n/a');
      expect(kimi?.configPath).toBe(configPath);
      expect(kimi?.errors?.some((error) => error.includes('Failed to read'))).toBe(true);
    });
  });

  test('GitHub Copilot CLI: configured from local project hook config', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilotDir = join(projectDir, '.github', 'hooks');
      _writeCopilotHook(join(copilotDir, 'safety-net.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'configured');
      expect(copilot?.configPath).toBe(join(copilotDir, 'safety-net.json'));
      expect(copilot).not.toHaveProperty('selfTest');
    });
  });

  test('GitHub Copilot CLI: configured from installed plugin list without hook config', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      _writeCopilotPluginDir(homeDir);
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'configured');
      expect(copilot?.method).toBe('plugin config');
      expect(copilot?.configPath).toBe(
        join(homeDir, '.copilot', 'installed-plugins', 'cc-marketplace', 'cc-safety-net'),
      );
      expect(copilot?.configPaths).toBeUndefined();
      expect(copilot).not.toHaveProperty('selfTest');
    });
  });

  test('GitHub Copilot CLI: accepts commented managed config when configured from installed plugin list', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(homeDir, '.copilot');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json'),
        `// User settings belong in settings.json.
// This file is managed automatically.
{
  "installedPlugins": [
    {
      "name": "copilot-safety-net",
      "version": "1.0.0"
    }
  ]
}`,
      );
      _writeCopilotPluginDir(homeDir);
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.40',
      });

      expectHookState(copilot, 'configured');
      expect(copilot?.method).toBe('plugin config');
      expect(copilot?.errors?.some((error) => error.includes('Failed to parse')) ?? false).toBe(
        false,
      );
    });
  });

  test('GitHub Copilot CLI: installed plugin list overrides legacy hook config as configured signal', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilotDir = join(projectDir, '.github', 'hooks');
      _writeCopilotHook(join(copilotDir, 'safety-net.json'));
      _writeCopilotPluginDir(homeDir);
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'configured');
      expect(copilot?.method).toBe('plugin config');
      expect(copilot?.configPath).toBe(join(copilotDir, 'safety-net.json'));
      expect(copilot?.configPaths).toEqual([join(copilotDir, 'safety-net.json')]);
      expect(copilot).not.toHaveProperty('selfTest');
    });
  });

  test('GitHub Copilot CLI: disableAllHooks still overrides installed plugin list', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(projectDir, '.github', 'copilot');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ disableAllHooks: true }));
      _writeCopilotPluginDir(homeDir);
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.9',
      });

      expectHookState(copilot, 'disabled');
      expect(copilot?.configPath).toBe(join(configDir, 'settings.json'));
      expect(copilot?.configPaths).toEqual([join(configDir, 'settings.json')]);
      expect(copilot).not.toHaveProperty('selfTest');
    });
  });

  test('GitHub Copilot CLI: configured from global hook config', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      _expectCopilotConfig(
        homeDir,
        projectDir,
        '1.0.9',
        'configured',
        join(homeDir, '.copilot', 'hooks', 'global.json'),
        _writeCopilotHook,
      );
    });
  });

  test('GitHub Copilot CLI: ignores global hook config on unsupported versions', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilot = _expectCopilotConfig(
        homeDir,
        projectDir,
        '0.0.421',
        'n/a',
        join(homeDir, '.copilot', 'hooks', 'global.json'),
        _writeCopilotHook,
      );
      expect(copilot).not.toHaveProperty('selfTest');
      expect(copilot?.errors?.some((e) => e.includes('does not support user hook files'))).toBe(
        true,
      );
    });
  });

  test('GitHub Copilot CLI: unsupported user hook warning uses resolved COPILOT_HOME hooks path', () => {
    withHookFixture('copilot', ({ tmpBase, homeDir, projectDir }) => {
      const customCopilotHome = join(tmpBase, 'custom-copilot');
      const customHooksDir = join(customCopilotHome, 'hooks');
      _writeCopilotHook(join(customHooksDir, 'global.json'));
      const copilot = withEnv({ COPILOT_HOME: customCopilotHome }, () =>
        findHook('copilot-cli', homeDir, projectDir, { copilotCliVersion: '0.0.421' }),
      );

      expectHookState(copilot, 'n/a');
      expect(
        copilot?.errors?.some((error) =>
          error.includes(`user hook files in ${join(customCopilotHome, 'hooks')}`),
        ) ?? false,
      ).toBe(true);
      expect(copilot?.errors?.some((error) => error.includes('~/.copilot/hooks')) ?? false).toBe(
        false,
      );
    });
  });

  test('GitHub Copilot CLI: ignores malformed global hook config on unsupported versions', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilotDir = join(homeDir, '.copilot', 'hooks');
      _writeConfigFile(join(copilotDir, 'broken.json'), '{ invalid json }');
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '0.0.421',
      });

      expectHookState(copilot, 'n/a');
      expectNoHookError(copilot, 'Failed to parse');
      expectNoHookError(copilot, 'user hook files');
    });
  });

  test('GitHub Copilot CLI: does not warn about unsupported user hook files when none configure CC Safety Net', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilotDir = join(homeDir, '.copilot', 'hooks');
      _writeCopilotHook(join(copilotDir, 'other.json'), 'echo safe');
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'n/a');
      expect(copilot?.errors?.some((error) => error.includes('user hook files')) ?? false).toBe(
        false,
      );
    });
  });

  test('GitHub Copilot CLI: reports repo and global hook configs together', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const localDir = join(projectDir, '.github', 'hooks');
      const globalDir = join(homeDir, '.copilot', 'hooks');
      mkdirSync(localDir, { recursive: true });
      mkdirSync(globalDir, { recursive: true });
      _writeCopilotHook(join(globalDir, 'global.json'));
      _writeCopilotHook(join(localDir, 'local.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.9',
      });

      expectHookState(copilot, 'configured');
      expect(copilot?.configPath).toBe(join(localDir, 'local.json'));
      expect(copilot?.configPaths).toEqual([
        join(localDir, 'local.json'),
        join(globalDir, 'global.json'),
      ]);
    });
  });

  test('GitHub Copilot CLI: continues checking files after parse errors', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilotDir = join(projectDir, '.github', 'hooks');
      mkdirSync(copilotDir, { recursive: true });
      writeFileSync(join(copilotDir, 'broken.json'), '{ invalid json }');
      _writeCopilotHook(join(copilotDir, 'safety-net.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'configured');
      expect(copilot?.errors?.some((e) => e.includes('Failed to parse'))).toBe(true);
      expect(copilot?.configPath).toBe(join(copilotDir, 'safety-net.json'));
    });
  });

  test('GitHub Copilot CLI: ignores non-CC Safety Net preToolUse hooks', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilotDir = join(projectDir, '.github', 'hooks');
      _writeCopilotHook(join(copilotDir, 'other.json'), 'echo safe');
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'n/a');
      expect(copilot).not.toHaveProperty('selfTest');
    });
  });

  test('GitHub Copilot CLI: supports powershell hook commands', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilotDir = join(projectDir, '.github', 'hooks');
      _writeCopilotHook(
        join(copilotDir, 'powershell.json'),
        'npx -y cc-safety-net hook --copilot-cli',
        'powershell',
      );
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'configured');
      expect(copilot?.configPath).toBe(join(copilotDir, 'powershell.json'));
    });
  });

  test('GitHub Copilot CLI: reports parse errors when all hook files are invalid', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilotDir = join(projectDir, '.github', 'hooks');
      mkdirSync(copilotDir, { recursive: true });
      writeFileSync(join(copilotDir, 'bad1.json'), '{ invalid }');
      writeFileSync(join(copilotDir, 'bad2.json'), 'not json');
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'n/a');
      expect(copilot?.errors?.length).toBe(2);
      expect(copilot?.errors?.every((e) => e.includes('Failed to parse'))).toBe(true);
    });
  });

  test('GitHub Copilot CLI: supports the nested short -cp flag', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilotDir = join(projectDir, '.github', 'hooks');
      _writeCopilotHook(join(copilotDir, 'short-flag.json'), 'bunx cc-safety-net hook -cp');
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'configured');
      expect(copilot?.configPath).toBe(join(copilotDir, 'short-flag.json'));
    });
  });

  test('GitHub Copilot CLI: ignores old top-level -cp flag', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilotDir = join(projectDir, '.github', 'hooks');
      _writeCopilotHook(join(copilotDir, 'old-short-flag.json'), 'bunx cc-safety-net -cp');
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'n/a');
      expect(copilot).not.toHaveProperty('selfTest');
    });
  });

  test('GitHub Copilot CLI: configured from global config.json inline hooks', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      _expectCopilotConfig(
        homeDir,
        projectDir,
        '1.0.9',
        'configured',
        join(homeDir, '.copilot', 'config.json'),
        _writeCopilotInlineConfig,
      );
    });
  });

  test('GitHub Copilot CLI: ignores global config.json inline hooks on unsupported versions', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const copilot = _expectCopilotConfig(
        homeDir,
        projectDir,
        '1.0.7',
        'n/a',
        join(homeDir, '.copilot', 'config.json'),
        _writeCopilotInlineConfig,
      );
      expect(
        copilot?.errors?.some((e) => e.includes('does not support inline hook definitions')),
      ).toBe(true);
    });
  });

  test('GitHub Copilot CLI: supports global config.json inline hooks at the minimum supported version', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      _expectCopilotConfig(
        homeDir,
        projectDir,
        '1.0.8',
        'configured',
        join(homeDir, '.copilot', 'config.json'),
        _writeCopilotInlineConfig,
      );
    });
  });

  test('GitHub Copilot CLI: configured from global settings.json inline hooks', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      _expectCopilotConfig(
        homeDir,
        projectDir,
        '1.0.35',
        'configured',
        join(homeDir, '.copilot', 'settings.json'),
        _writeCopilotInlineConfig,
      );
    });
  });

  test('GitHub Copilot CLI: reports both global settings.json and config.json inline hooks', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(homeDir, '.copilot');
      _writeCopilotInlineConfig(join(configDir, 'settings.json'));
      _writeCopilotInlineConfig(join(configDir, 'config.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.35',
      });

      expectHookState(copilot, 'configured');
      expect(copilot?.configPaths).toEqual([
        join(configDir, 'settings.json'),
        join(configDir, 'config.json'),
      ]);
    });
  });

  test('GitHub Copilot CLI: configured from repository settings.json inline hooks', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(projectDir, '.github', 'copilot');
      _writeCopilotInlineConfig(join(configDir, 'settings.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.9',
      });

      expectHookState(copilot, 'configured');
      expectHookConfigPaths(copilot, join(configDir, 'settings.json'));
    });
  });

  test('GitHub Copilot CLI: configured from repository settings.local.json inline hooks', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(projectDir, '.github', 'copilot');
      _writeCopilotInlineConfig(join(configDir, 'settings.local.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.9',
      });

      expectHookState(copilot, 'configured');
      expectHookConfigPaths(copilot, join(configDir, 'settings.local.json'));
    });
  });

  test('GitHub Copilot CLI: configured from repository .claude/settings.json inline hooks', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(projectDir, '.claude');
      _writeCopilotInlineConfig(join(configDir, 'settings.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.35',
      });

      expectHookState(copilot, 'configured');
      expectHookConfigPaths(copilot, join(configDir, 'settings.json'));
    });
  });

  test('GitHub Copilot CLI: configured from repository .claude/settings.local.json inline hooks', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(projectDir, '.claude');
      _writeCopilotInlineConfig(join(configDir, 'settings.local.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.35',
      });

      expectHookState(copilot, 'configured');
      expectHookConfigPaths(copilot, join(configDir, 'settings.local.json'));
    });
  });

  test('GitHub Copilot CLI: native repository settings outrank cross-tool .claude settings', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const nativeDir = join(projectDir, '.github', 'copilot');
      const claudeDir = join(projectDir, '.claude');
      _writeCopilotInlineConfig(join(nativeDir, 'settings.json'));
      _writeCopilotInlineConfig(join(claudeDir, 'settings.local.json'));
      _writeCopilotInlineConfig(join(claudeDir, 'settings.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.35',
      });

      expectHookState(copilot, 'configured');
      expect(copilot?.configPaths).toEqual([
        join(nativeDir, 'settings.json'),
        join(claudeDir, 'settings.local.json'),
        join(claudeDir, 'settings.json'),
      ]);
    });
  });

  test('GitHub Copilot CLI: ignores a Claude Code hook in repository .claude/settings.json', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      _writeCopilotInlineConfig(
        join(projectDir, '.claude', 'settings.json'),
        'npx -y cc-safety-net hook --claude-code',
      );
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.35',
      });

      expectHookState(copilot, 'n/a');
    });
  });

  test('GitHub Copilot CLI: user disableAllHooks reports disabled', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const hooksDir = join(projectDir, '.github', 'hooks');
      const configDir = join(homeDir, '.copilot');
      mkdirSync(hooksDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      _writeCopilotHook(join(hooksDir, 'safety-net.json'));
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ disableAllHooks: true }));
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.9',
      });

      expectHookState(copilot, 'disabled');
      expectHookConfigPaths(copilot, join(configDir, 'config.json'));
      expect(copilot).not.toHaveProperty('selfTest');
    });
  });

  test('GitHub Copilot CLI: unknown version still honors inline disableAllHooks over repo hook files', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const hooksDir = join(projectDir, '.github', 'hooks');
      const configDir = join(projectDir, '.github', 'copilot');
      mkdirSync(hooksDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      _writeCopilotHook(join(hooksDir, 'safety-net.json'));
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ disableAllHooks: true }));
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'disabled');
      expectHookConfigPaths(copilot, join(configDir, 'settings.json'));
      expect(copilot?.errors?.some((e) => e.includes('version unavailable'))).toBe(true);
      expect(copilot).not.toHaveProperty('selfTest');
    });
  });

  test('GitHub Copilot CLI: repository settings can override user disableAllHooks', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const userConfigDir = join(homeDir, '.copilot');
      const repoConfigDir = join(projectDir, '.github', 'copilot');
      _writeConfigFile(
        join(userConfigDir, 'config.json'),
        JSON.stringify({ disableAllHooks: true }),
      );
      _writeConfigFile(
        join(repoConfigDir, 'settings.json'),
        JSON.stringify({ disableAllHooks: false }),
      );
      _writeCopilotInlineConfig(join(repoConfigDir, 'settings.local.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.9',
      });

      expectHookState(copilot, 'configured');
      expectHookConfigPaths(copilot, join(repoConfigDir, 'settings.local.json'));
    });
  });

  test('GitHub Copilot CLI: settings.local disableAllHooks overrides broader configs', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const userConfigDir = join(homeDir, '.copilot');
      const repoConfigDir = join(projectDir, '.github', 'copilot');
      _writeCopilotInlineConfig(join(userConfigDir, 'config.json'));
      _writeCopilotInlineConfig(join(repoConfigDir, 'settings.json'));
      _writeConfigFile(
        join(repoConfigDir, 'settings.local.json'),
        JSON.stringify({ disableAllHooks: true }),
      );
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.9',
      });

      expectHookState(copilot, 'disabled');
      expectHookConfigPaths(copilot, join(repoConfigDir, 'settings.local.json'));
    });
  });

  test('GitHub Copilot CLI: honors COPILOT_HOME for user config discovery', () => {
    withHookFixture('copilot', ({ tmpBase, homeDir, projectDir }) => {
      const customCopilotHome = join(tmpBase, 'custom-copilot');
      _writeCopilotInlineConfig(join(customCopilotHome, 'config.json'));
      const copilot = withEnv({ COPILOT_HOME: customCopilotHome }, () =>
        findHook('copilot-cli', homeDir, projectDir, { copilotCliVersion: '1.0.9' }),
      );

      expectHookState(copilot, 'configured');
      expectHookConfigPaths(copilot, join(customCopilotHome, 'config.json'));
    });
  });

  test('GitHub Copilot CLI: warns when version is unavailable for gated sources', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(homeDir, '.copilot');
      _writeCopilotInlineConfig(join(configDir, 'config.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'n/a');
      expect(
        copilot?.errors?.some((e) => e.includes('GitHub Copilot CLI version unavailable')),
      ).toBe(true);
    });
  });

  test('GitHub Copilot CLI: does not warn about unsupported inline hooks when none configure CC Safety Net', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(homeDir, '.copilot');
      _writeCopilotInlineConfig(join(configDir, 'config.json'), 'echo safe');
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.7',
      });

      expectHookState(copilot, 'n/a');
      expect(
        copilot?.errors?.some((error) => error.includes('inline hook definitions')) ?? false,
      ).toBe(false);
    });
  });

  test('GitHub Copilot CLI: ignores malformed inline config on unsupported versions', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(homeDir, '.copilot');
      _writeConfigFile(join(configDir, 'config.json'), '{ invalid json }');
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.7',
      });

      expectHookState(copilot, 'n/a');
      expectNoHookError(copilot, 'Failed to parse');
      expectNoHookError(copilot, 'inline hook definitions');
    });
  });

  test('GitHub Copilot CLI: ignores malformed inline config when version is unavailable', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(homeDir, '.copilot');
      _writeConfigFile(join(configDir, 'config.json'), '{ invalid json }');
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'n/a');
      expectNoHookError(copilot, 'Failed to parse');
      expectNoHookError(copilot, 'GitHub Copilot CLI version unavailable');
    });
  });

  test('GitHub Copilot CLI: continues after inline config parse errors', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const configDir = join(homeDir, '.copilot');
      const hooksDir = join(configDir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), '{ invalid json }');
      _writeCopilotHook(join(hooksDir, 'global.json'));
      const copilot = findHook('copilot-cli', homeDir, projectDir, {
        copilotCliVersion: '1.0.9',
      });

      expectHookState(copilot, 'configured');
      expect(copilot?.errors?.some((e) => e.includes('Failed to parse'))).toBe(true);
      expect(copilot?.configPaths).toEqual([join(homeDir, '.copilot', 'hooks', 'global.json')]);
    });
  });

  test('GitHub Copilot CLI: reports an error when the repository hooks path is not a directory', () => {
    withHookFixture('copilot', ({ homeDir, projectDir }) => {
      const githubDir = join(projectDir, '.github');
      mkdirSync(githubDir, { recursive: true });
      writeFileSync(join(githubDir, 'hooks'), 'not a directory');
      const copilot = findHook('copilot-cli', homeDir, projectDir);

      expectHookState(copilot, 'n/a');
      expect(copilot).not.toHaveProperty('selfTest');
      expect(
        copilot?.errors?.some(
          (error) =>
            error.includes('Failed to read') &&
            error.includes(join(projectDir, '.github', 'hooks')),
        ),
      ).toBe(true);
    });
  });

  test('Codex: configured when plugin list line contains repository URL and installed, enabled', () => {
    withHookFixture('codex', ({ homeDir, projectDir }) => {
      const codex = findHook('codex', homeDir, projectDir, {
        codexPluginListOutput:
          'cc-safety-net https://github.com/kenryu42/cc-safety-net.git installed, enabled',
      });

      expectHookState(codex, 'configured');
      expect(codex?.method).toBe('codex plugin list');
      expect(codex?.configPath).toBe('codex plugin list');
      expect(codex?.errors).toBeUndefined();
      expect(codex).not.toHaveProperty('selfTest');
    });
  });

  test('Codex: configured when plugin name changes but repository URL matches', () => {
    withHookFixture('codex', ({ homeDir, projectDir }) => {
      const codex = findHook('codex', homeDir, projectDir, {
        codexPluginListOutput:
          'renamed-plugin https://github.com/kenryu42/cc-safety-net.git installed, enabled',
      });

      expectHookState(codex, 'configured');
      expect(codex?.method).toBe('codex plugin list');
      expect(codex?.errors).toBeUndefined();
    });
  });

  test('Codex: disabled when repository URL line is installed but not enabled', () => {
    withHookFixture('codex', ({ homeDir, projectDir }) => {
      const installedDisabled = findHook('codex', homeDir, projectDir, {
        codexPluginListOutput:
          'cc-safety-net  installed, disabled  0.1.0  https://github.com/kenryu42/cc-safety-net.git',
      });

      expectHookState(installedDisabled, 'disabled');
      expect(
        installedDisabled?.errors?.some((error) =>
          error.includes('must contain installed, enabled'),
        ),
      ).toBe(true);
      expect(installedDisabled?.method).toBe('codex plugin list');
      expect(installedDisabled?.configPath).toBe('codex plugin list');
      expect(installedDisabled).not.toHaveProperty('selfTest');
    });
  });

  test('Codex: n/a when repository URL line is a not installed marketplace row', () => {
    withHookFixture('codex', ({ homeDir, projectDir }) => {
      const notInstalled = findHook('codex', homeDir, projectDir, {
        codexPluginListOutput:
          'cc-safety-net  not installed         https://github.com/kenryu42/cc-safety-net.git',
      });
      const missingEnabled = findHook('codex', homeDir, projectDir, {
        codexPluginListOutput:
          'cc-safety-net https://github.com/kenryu42/cc-safety-net.git installed',
      });

      expectHookState(notInstalled, 'n/a');
      expectHookState(missingEnabled, 'n/a');
      expect(notInstalled).not.toHaveProperty('selfTest');
    });
  });

  test('Codex: n/a when old config is enabled but plugin list output is unavailable', () => {
    withHookFixture('codex', ({ homeDir, projectDir }) => {
      const codexHome = join(homeDir, '.codex');
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(
        join(codexHome, 'config.toml'),
        '[features]\nplugin_hooks = true\n\n[plugins."cc-safety-net@cc-marketplace"]\nenabled = true\n',
      );
      const codex = findHook('codex', homeDir, projectDir, { codexPluginListOutput: null });

      expectHookState(codex, 'n/a');
      expect(codex).not.toHaveProperty('selfTest');
    });
  });

  test('Codex: n/a when output contains marketplace id without repository URL', () => {
    withHookFixture('codex', ({ homeDir, projectDir }) => {
      const codex = findHook('codex', homeDir, projectDir, {
        codexPluginListOutput: 'cc-safety-net@cc-marketplace installed, enabled',
      });

      expectHookState(codex, 'n/a');
      expect(codex).not.toHaveProperty('selfTest');
    });
  });
});

describe('stripJsonComments', () => {
  test('removes single-line comments', () => {
    const input = `{
      "key": "value" // this is a comment
    }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ key: 'value' });
  });

  test('removes multi-line comments', () => {
    const input = `{
      /* comment */
      "key": "value"
    }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ key: 'value' });
  });

  test('removes trailing commas before }', () => {
    const input = `{
      "key": "value",
    }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ key: 'value' });
  });

  test('removes trailing commas before ]', () => {
    const input = `{
      "arr": ["a", "b",]
    }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ arr: ['a', 'b'] });
  });

  test('handles comments inside arrays', () => {
    const input = `{
      "arr": [
        // "commented-out",
        "active"
      ]
    }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ arr: ['active'] });
  });

  test('preserves // inside strings', () => {
    const input = `{
      "url": "https://example.com"
    }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ url: 'https://example.com' });
  });

  test('preserves /* inside strings', () => {
    const input = `{
      "pattern": "/* glob */"
    }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ pattern: '/* glob */' });
  });

  test('handles escaped quotes in strings', () => {
    const input = `{
      "escaped": "say \\"hello\\""
    }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ escaped: 'say "hello"' });
  });

  test('preserves comma-bracket sequences inside strings', () => {
    const input = `{"pattern": ",]", "other": ",}"}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ pattern: ',]', other: ',}' });
  });

  test('preserves complex patterns inside strings with trailing commas outside', () => {
    const input = `{
      "pattern": ",]",
      "arr": ["a", "b",],
    }`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ pattern: ',]', arr: ['a', 'b'] });
  });

  test('handles complex JSONC like opencode config', () => {
    const input = `{
      "$schema": "https://opencode.ai/config.json",
      "plugin": [
        // "disabled-plugin",
        "active-plugin",
      ],
      "options": {
        "key": "value", /* trailing */
      }
    }`;
    const result = stripJsonComments(input);
    const parsed = JSON.parse(result);
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    expect(parsed.plugin).toEqual(['active-plugin']);
    expect(parsed.options).toEqual({ key: 'value' });
  });
});
