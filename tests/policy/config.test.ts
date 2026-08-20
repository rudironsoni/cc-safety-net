import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadPolicySnapshot } from '@/policy/snapshot';
import {
  getLegacyProjectConfigPath,
  validateConfig,
  validateConfigFile,
  validateRulesConfigFile,
} from '@/rules/config';
import { validateRulesConfig } from '@/rules/policy/config-file';
import { SECRET_DEFAULT_OFF_RULE_ID_SET } from '@/rules/secret-protection-rules';
import { analyzeTestCommand as analyzeCommand, loadTestPolicy } from '../helpers/policy';
import { withEnv, writeLockedGitHubRulebookPolicy } from '../helpers.ts';

const legacyRule = {
  name: 'block-git-add-all',
  command: 'git',
  subcommand: 'add',
  block_args: ['-A'],
  reason: 'Use specific files.',
};

describe('legacy inline config validation', () => {
  test('accepts legacy inline rules for migration tools', () => {
    const result = validateConfig({ version: 1, rules: [legacyRule] });

    expect(result.errors).toEqual([]);
    expect(result.ruleNames).toEqual(new Set(['block-git-add-all']));
  });

  test('rejects malformed legacy inline rules', () => {
    expect(validateConfig(null).errors).toEqual(['Config must be an object']);
    expect(validateConfig({ rules: [] }).errors).toContain('version must be 1');
    expect(validateConfig({ version: 2 }).errors).toContain('version must be 1');
    expect(validateConfig({ version: 1, rules: {} }).errors).toContain('rules must be an array');
    expect(validateConfig({ version: 1, rules: ['bad'] }).errors).toContain(
      'rules[0]: must be an object',
    );
    expect(validateConfig({ version: 1, rules: [{ ...legacyRule, name: '1bad' }] }).errors).toEqual(
      expect.arrayContaining([
        'rules[0].name: must match pattern (letters, numbers, hyphens, underscores; max 64 chars)',
      ]),
    );
    expect(
      validateConfig({
        version: 1,
        rules: [legacyRule, { ...legacyRule, name: legacyRule.name.toUpperCase() }],
      }).errors,
    ).toContain('rules[1].name: duplicate rule name "BLOCK-GIT-ADD-ALL"');
    expect(
      validateConfig({ version: 1, rules: [{ ...legacyRule, command: 'git add' }] }).errors,
    ).toEqual(
      expect.arrayContaining([
        'rules[0].command: must match pattern (letters, numbers, hyphens, underscores)',
      ]),
    );
    expect(
      validateConfig({ version: 1, rules: [{ ...legacyRule, subcommand: 1 }] }).errors,
    ).toContain('rules[0].subcommand: must be a string if provided');
    expect(
      validateConfig({ version: 1, rules: [{ ...legacyRule, subcommand: 'add files' }] }).errors,
    ).toEqual(
      expect.arrayContaining([
        'rules[0].subcommand: must match pattern (letters, numbers, hyphens, underscores)',
      ]),
    );
    expect(
      validateConfig({ version: 1, rules: [{ ...legacyRule, block_args: undefined }] }).errors,
    ).toContain('rules[0].block_args: required array');
    expect(
      validateConfig({ version: 1, rules: [{ ...legacyRule, block_args: [] }] }).errors,
    ).toEqual(expect.arrayContaining(['rules[0].block_args: must have at least one element']));
    expect(
      validateConfig({ version: 1, rules: [{ ...legacyRule, block_args: ['-A', 1] }] }).errors,
    ).toContain('rules[0].block_args[1]: must be a string');
    expect(
      validateConfig({ version: 1, rules: [{ ...legacyRule, block_args: ['-A', ''] }] }).errors,
    ).toContain('rules[0].block_args[1]: must not be empty');
    expect(
      validateConfig({ version: 1, rules: [{ ...legacyRule, reason: undefined }] }).errors,
    ).toContain('rules[0].reason: required string');
    expect(validateConfig({ version: 1, rules: [{ ...legacyRule, reason: '' }] }).errors).toContain(
      'rules[0].reason: must not be empty',
    );
    expect(
      validateConfig({ version: 1, rules: [{ ...legacyRule, reason: 'x'.repeat(257) }] }).errors,
    ).toContain('rules[0].reason: must be at most 256 characters');
  });
});

describe('runtime config loading', () => {
  let tempDir: string;
  let userRulesDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'safety-net-config-'));
    userRulesDir = join(tempDir, 'home', '.cc-safety-net', 'rules');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('no config returns built-in only config', () => {
    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });

    expect(config.rules).toEqual([]);
    expect(config.secretProtection?.enabled).toBe(true);
  });

  test('loads transparent wrappers from user and project configs', () => {
    writeRulesConfigWithTransparentWrappers(userRulesDir, ['rtk']);
    writeRulesConfigWithTransparentWrappers(join(tempDir, '.cc-safety-net', 'rules'), ['wrap']);

    expect(loadTestPolicy(tempDir, { userConfigDir: userRulesDir }).transparent_wrappers).toEqual([
      'rtk',
      'wrap',
    ]);
  });

  test('deduplicates transparent wrappers across scopes', () => {
    writeRulesConfigWithTransparentWrappers(userRulesDir, ['rtk']);
    writeRulesConfigWithTransparentWrappers(join(tempDir, '.cc-safety-net', 'rules'), ['rtk']);

    expect(loadTestPolicy(tempDir, { userConfigDir: userRulesDir }).transparent_wrappers).toEqual([
      'rtk',
    ]);
  });

  function writeRulesConfigWithTransparentWrappers(
    configDir: string,
    transparentWrappers: string[],
  ): void {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'rule.json'),
      JSON.stringify({
        version: 1,
        rules: [],
        overrides: {},
        transparent_wrappers: transparentWrappers,
      }),
    );
  }

  function writeUserPolicy(policy: unknown): void {
    mkdirSync(dirname(userRulesDir), { recursive: true });
    writeFileSync(join(dirname(userRulesDir), 'policy.json'), JSON.stringify(policy), 'utf-8');
  }

  function writeUserPolicyRaw(policy: string): void {
    mkdirSync(dirname(userRulesDir), { recursive: true });
    writeFileSync(join(dirname(userRulesDir), 'policy.json'), policy, 'utf-8');
  }

  function writeProjectPolicy(policy: unknown): void {
    mkdirSync(join(tempDir, '.cc-safety-net'), { recursive: true });
    writeFileSync(join(tempDir, '.cc-safety-net', 'policy.json'), JSON.stringify(policy), 'utf-8');
  }

  /**
   * An unreadable policy file degrades: ordinary analysis keeps running on the
   * fallback policy and the diagnostics ride the snapshot reason instead of a
   * fail-closed denial.
   */
  function degradedReason(): string {
    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });
    expect(analyzeCommand('echo ok', { cwd: tempDir, config })).toBeNull();
    const snapshot = loadPolicySnapshot({ cwd: tempDir, userConfigDir: userRulesDir });
    expect(snapshot.state).toBe('degraded');
    return snapshot.state === 'degraded' ? snapshot.reason : '';
  }

  test('uses protective defaults for an empty user policy file', () => {
    writeUserPolicyRaw('  \n');

    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });
    const snapshot = loadPolicySnapshot({ cwd: tempDir, userConfigDir: userRulesDir });

    expect(config.destructiveCommandProtectionEnabled).toBe(true);
    expect(config.secretProtection?.enabled).toBe(true);
    expect(snapshot.state).toBe('degraded');
    expect(snapshot.state === 'degraded' ? snapshot.reason : '').toContain('Config file is empty');
  });

  test('user policy safety overrides affect command analysis without env flags', () => {
    writeUserPolicy({
      version: 1,
      safety: { level: 'standard', overrides: { paranoid_rm: true } },
    });

    const result = analyzeCommand('rm -rf build', {
      cwd: tempDir,
      config: loadTestPolicy(tempDir, { userConfigDir: userRulesDir }),
    });

    expect(result?.ruleId).toBe('rm.recursive-force-paranoid');
    expect(result?.reason).toContain('active safety policy');
  });

  test('env flags still enable capabilities when policy sets false', () => {
    writeUserPolicy({
      version: 1,
      safety: { level: 'standard', overrides: { paranoid_rm: false } },
    });

    withEnv({ CC_SAFETY_NET_PARANOID_RM: '1' }, () => {
      const result = analyzeCommand('rm -rf build', {
        cwd: tempDir,
        config: loadTestPolicy(tempDir, { userConfigDir: userRulesDir }),
      });

      expect(result).toMatchObject({
        ruleId: 'rm.recursive-force-paranoid',
        reason: expect.stringContaining('active safety policy'),
      });
    });
  });

  test('user policy disables only the matching built-in id', () => {
    writeUserPolicy({
      version: 1,
      destructive_command_protection: { overrides: { 'git.reset-hard': 'off' } },
    });

    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });

    expect(analyzeCommand('git reset --hard', { cwd: tempDir, config })).toBeNull();
    expect(analyzeCommand('git clean -f', { cwd: tempDir, config })?.reason).toContain(
      'git clean -f',
    );
  });

  test('built-in ids are granular within command families', () => {
    writeUserPolicy({
      version: 1,
      destructive_command_protection: { overrides: { 'git.checkout-force': 'off' } },
    });

    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });

    expect(analyzeCommand('git checkout --force main', { cwd: tempDir, config })).toBeNull();
    expect(analyzeCommand('git checkout -- src/index.ts', { cwd: tempDir, config })?.reason).toBe(
      "git checkout -- discards uncommitted changes permanently. Use 'git stash' first.",
    );
  });

  test('rm built-in ids are granular by target classification', () => {
    writeUserPolicy({
      version: 1,
      destructive_command_protection: { overrides: { 'rm.recursive-force-outside-cwd': 'off' } },
    });

    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });

    expect(analyzeCommand('rm -rf ../outside', { cwd: tempDir, config })).toBeNull();
    expect(analyzeCommand('rm -rf /', { cwd: tempDir, config })?.reason).toContain(
      'root or home directory',
    );
  });

  test('PowerShell Remove-Item built-in ids are granular by target classification', () => {
    writeUserPolicy({
      version: 1,
      destructive_command_protection: {
        overrides: { 'powershell.remove-item-recursive-force-cwd-self': 'off' },
      },
    });

    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });

    expect(
      analyzeCommand('Remove-Item . -Recurse -Force', {
        cwd: tempDir,
        config,
        shell: 'powershell',
      }),
    ).toBeNull();
    expect(
      analyzeCommand('Remove-Item ~ -Recurse -Force', {
        cwd: tempDir,
        config,
        shell: 'powershell',
      })?.reason,
    ).toContain('root or home directory');
  });

  test('nested and dynamic execution built-in ids honor overrides', () => {
    writeUserPolicy({
      version: 1,
      destructive_command_protection: {
        overrides: {
          'interpreter.dangerous-command': 'off',
          'shred.target': 'off',
          'xargs.shell-dynamic': 'off',
          'parallel.shell-dynamic': 'off',
        },
      },
    });

    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });

    expect(analyzeCommand("node -e 'shred file.txt'", { cwd: tempDir, config })).toBeNull();
    expect(analyzeCommand('echo ok | xargs bash -c', { cwd: tempDir, config })).toBeNull();
    expect(analyzeCommand('parallel bash -c ::: ok', { cwd: tempDir, config })).toBeNull();
  });

  test('destructive command protection can be disabled without disabling custom rules', () => {
    writeUserPolicy({
      version: 1,
      destructive_command_protection: { enabled: false, overrides: {} },
    });
    writeLockedGitHubRulebookPolicy(
      tempDir,
      JSON.stringify({
        rulebook_version: 1,
        name: 'policy',
        version: '1.0.0',
        allowed_commands: ['git'],
        rules: [legacyRule],
        tests: [
          {
            command: 'git add -A',
            expect: 'blocked',
            rule: legacyRule.name,
          },
        ],
      }),
    );

    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });

    expect(analyzeCommand('git reset --hard', { cwd: tempDir, config })).toBeNull();
    expect(analyzeCommand('rm -rf /', { cwd: tempDir, config })?.ruleId).toBe(
      'rm.recursive-force-root-or-home',
    );
    expect(analyzeCommand('git add -A', { cwd: tempDir, config })?.reason).toContain(
      'Use specific files.',
    );
  });

  test('catastrophic root and home deletion ignores master and exact-rule overrides', () => {
    expect(
      analyzeCommand('find / -delete', {
        cwd: tempDir,
        config: { destructiveCommandProtectionEnabled: false },
      })?.ruleId,
    ).toBe('rm.recursive-force-root-or-home');
    expect(
      analyzeCommand('rm -r /', {
        cwd: tempDir,
        config: {
          destructiveCommandRuleOverrides: { 'rm.recursive-force-root-or-home': 'off' },
        },
      })?.ruleId,
    ).toBe('rm.recursive-force-root-or-home');
    expect(
      analyzeCommand('Remove-Item ~ -Recurse -Force', {
        cwd: tempDir,
        shell: 'powershell',
        config: { destructiveCommandProtectionEnabled: false },
      })?.ruleId,
    ).toBe('powershell.remove-item-recursive-force-root-or-home');
    expect(
      analyzeCommand('Remove-Item ~ -Recurse -Force', {
        cwd: tempDir,
        shell: 'powershell',
        config: {
          destructiveCommandRuleOverrides: {
            'powershell.remove-item-recursive-force-root-or-home': 'off',
          },
        },
      })?.ruleId,
    ).toBe('powershell.remove-item-recursive-force-root-or-home');
  });

  test('project policy is ignored', () => {
    writeProjectPolicy({
      version: 1,
      destructive_command_protection: { overrides: { 'git.reset-hard': 'off' } },
      secret_protection: { overrides: { 'secret.ext.pem': 'off' } },
      workflow: { worktree_mode: true },
    });

    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });

    expect(config.configFallbackReason).toBeUndefined();
    expect(config.destructiveCommandRuleOverrides).toEqual({});
    // The project override is ignored, so only the built-in default-off tier remains.
    expect(config.secretProtection?.disabledRules).toEqual(SECRET_DEFAULT_OFF_RULE_ID_SET);
    expect(config.safety).toEqual({});
    expect(config.worktreeMode).toBe(false);
  });

  test('invalid policy fields degrade with every rejected field named', () => {
    writeUserPolicy({
      version: 1,
      destructive_command_protection: {
        enabled: 'yes',
        overrides: { 'git.unknown': 'off', 'git.reset-hard': 'allow' },
      },
      secret_protection: { overrides: { 'secret.unknown': 'off', 'secret.ext.pem': 'allow' } },
      extra: true,
    });

    const reason = degradedReason();

    expect(reason).toContain('invalid policy config');
    expect(reason).toContain('unknown field "extra"');
    expect(reason).toContain('destructive_command_protection.enabled must be a boolean');
    expect(reason).toContain('unknown destructive command rule id "git.unknown"');
    expect(reason).toContain(
      'destructive_command_protection.overrides.git.reset-hard must be "on" or "off"',
    );
    expect(reason).toContain('unknown secret protection rule id "secret.unknown"');
    expect(reason).toContain('secret_protection.overrides.secret.ext.pem must be "on" or "off"');
  });

  test('malformed policy JSON degrades without exposing policy bytes', () => {
    const token = 'sk-proj_1234567890abcdefghijklmnopqrstuv';
    writeUserPolicyRaw(`{"version":1,"token":"${token}"`);

    const reason = degradedReason();

    expect(reason).toContain('Invalid JSON');
    expect(reason).toContain('Fix the policy file manually');
    expect(reason).not.toContain(token);
    expect(reason).not.toContain('Invalid JSON:');
  });

  // Only a parse failure means invalid JSON; any other read failure has to name itself,
  // or a perfectly valid file gets reported as malformed.
  test('an unreadable policy file reports the read failure instead of Invalid JSON', () => {
    mkdirSync(join(dirname(userRulesDir), 'policy.json'), { recursive: true });

    const reason = degradedReason();

    expect(reason).toContain('EISDIR');
    expect(reason).not.toContain('Invalid JSON');
  });

  test('user secret overrides and deny paths apply', () => {
    writeUserPolicy({
      version: 1,
      secret_protection: {
        enabled: false,
        overrides: { 'secret.ext.pem': 'off' },
        deny_paths: ['user.key'],
      },
    });
    writeProjectPolicy({
      version: 1,
      secret_protection: { enabled: true, deny_paths: ['project.key'] },
    });

    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });

    expect(config.secretProtection?.enabled).toBe(false);
    expect(config.secretProtection?.disabledRules).toEqual(
      new Set([...SECRET_DEFAULT_OFF_RULE_ID_SET, 'secret.ext.pem']),
    );
    expect(config.secretProtection?.denyPaths).toEqual(['user.key']);
  });

  test('validates transparent wrapper config', () => {
    expect(
      validateRulesConfig({
        version: 1,
        rules: [],
        transparent_wrappers: ['rtk', 'bad command', 'rtk', 1],
      }).errors,
    ).toEqual([
      'transparent_wrappers[1]: must match command pattern',
      'transparent_wrappers[2]: duplicate command "rtk"',
      'transparent_wrappers[3]: must be a command string',
    ]);
  });

  test('validates custom rule intent', () => {
    expect(
      validateConfig({
        version: 1,
        rules: [{ ...legacyRule, intent: 'use_alternative' }],
      }).errors,
    ).toEqual([]);
    expect(
      validateConfig({
        version: 1,
        rules: [{ ...legacyRule, intent: 'retry_forever' }],
      }).errors,
    ).toEqual([
      'rules[0].intent: must be one of hard_stop, use_alternative, scope_down, manual_only, stop_and_explain',
    ]);
  });

  test('rejects transparent wrappers that collide with analyzed commands', () => {
    expect(
      validateRulesConfig({
        version: 1,
        rules: [],
        transparent_wrappers: ['xargs'],
      }).errors,
    ).toEqual(['transparent_wrappers[0]: reserved command "xargs" cannot be a wrapper']);
  });

  /** An unverifiable rule source is dropped, never enforced, and never blocking. */
  function expectRuleSourceDropped(reason: string): void {
    const config = loadTestPolicy(tempDir, { userConfigDir: userRulesDir });

    expect(config.rules).toEqual([]);
    expect(config.configFallbackReason).toContain(reason);
    expect(analyzeCommand('echo ok', { cwd: tempDir, config })).toBeNull();
  }

  test('unreadable rulebook cache entries are dropped', () => {
    writeLockedGitHubRulebookPolicy(tempDir, '{}', { cacheAsDirectory: true });

    expectRuleSourceDropped('Unable to access project policy filesystem safely.');
  });

  test('invalid rulebook cache JSON is dropped', () => {
    writeLockedGitHubRulebookPolicy(tempDir, '{');

    expectRuleSourceDropped('invalid cached rulebook');
  });
});

describe('validate config file', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'safety-net-validate-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('valid legacy file returns empty errors for migration tools', () => {
    const path = join(tempDir, 'config.json');
    writeFileSync(path, JSON.stringify({ version: 1 }), 'utf-8');

    expect(validateConfigFile(path).errors).toEqual([]);
  });

  test('invalid legacy file returns validation errors', () => {
    const path = join(tempDir, 'config.json');
    writeFileSync(path, JSON.stringify({ version: 2 }), 'utf-8');

    expect(validateConfigFile(path).errors).toEqual(['version must be 1']);
  });

  test('file read errors are reported', () => {
    expect(validateConfigFile('/nonexistent/config.json').errors[0]).toContain('not found');
    const path = join(tempDir, 'config.json');
    writeFileSync(path, '', 'utf-8');
    expect(validateConfigFile(path).errors).toEqual(['Config file is empty']);
    writeFileSync(path, '{bad json', 'utf-8');
    expect(validateConfigFile(path).errors).toEqual(['Invalid JSON']);
  });

  // Reporting a read failure as invalid JSON hides what actually went wrong on a valid file.
  test('an unexpected read failure reports its own message instead of Invalid JSON', async () => {
    const filesystem = await import('@/rules/policy/filesystem');
    const readPolicyFile = filesystem.readPolicyFile;
    const path = join(tempDir, 'config.json');
    writeFileSync(path, JSON.stringify({ version: 1 }), 'utf-8');

    try {
      mock.module('@/rules/policy/filesystem', () => ({
        ...filesystem,
        readPolicyFile: () => {
          throw new Error("Cannot find module 'zod'");
        },
      }));

      expect(validateConfigFile(path).errors).toEqual(["Cannot find module 'zod'"]);
    } finally {
      mock.module('@/rules/policy/filesystem', () => ({ ...filesystem, readPolicyFile }));
    }
  });

  test('validates rulebook source config files', () => {
    const path = join(tempDir, 'rule.json');
    writeFileSync(
      path,
      JSON.stringify({ version: 1, rules: ['project-rules'], overrides: {} }),
      'utf-8',
    );

    const result = validateRulesConfigFile(path);

    expect(result.errors).toEqual([]);
    expect(result.ruleNames).toEqual(new Set(['project-rules']));
  });
});

describe('config path helpers', () => {
  test('getLegacyProjectConfigPath resolves cwd', () => {
    expect(getLegacyProjectConfigPath('/tmp')).toBe(resolve('/tmp', '.safety-net.json'));
  });
});
