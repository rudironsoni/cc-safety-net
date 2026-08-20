/**
 * Tests for the doctor command formatting functions.
 */

import { describe, expect, test } from 'bun:test';
import { getEnvironmentInfo } from '@/cli/doctor/environment';
import {
  formatActivitySection,
  formatConfigSection,
  formatEffectiveSafetySection,
  formatEngineSelfTestSection,
  formatEnvironmentSection,
  formatFindingsSection,
  formatHooksSection,
  formatRulesTable,
  formatSummary,
  formatSystemInfoSection,
  formatUpdateSection,
} from '@/cli/doctor/format';
import type {
  DoctorReport,
  EffectiveRule,
  HookStatus,
  SystemInfo,
} from '@/integrations/doctor-types';
import { getSystemInfo } from '@/integrations/system-info';
import { mockVersionFetcher, withStdoutColor } from '../../helpers.ts';

function createSystemInfo(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    version: '0.6.0',
    versions: {},
    codexPluginListOutput: null,
    ampPluginListOutput: null,
    nodeVersion: '22.0.0',
    npmVersion: '10.0.0',
    bunVersion: '1.0.0',
    platform: 'darwin',
    ...overrides,
  };
}

function createDoctorReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    hooks: [],
    configState: { state: 'ready' },
    engineSelfTest: {
      passed: 3,
      failed: 0,
      total: 3,
      results: [],
    },
    userConfig: { path: '', exists: false, valid: false, ruleCount: 0 },
    projectConfig: { path: '', exists: false, valid: false, ruleCount: 0 },
    effectiveRules: [],
    shadowedRules: [],
    environment: [],
    effectiveSafety: {
      selectedPreset: 'standard',
      level: 'standard',
      capabilities: {
        fail_closed: {
          enabled: false,
          source: 'preset',
          sources: ['policy safety.level=standard'],
        },
        paranoid_rm: {
          enabled: false,
          source: 'preset',
          sources: ['policy safety.level=standard'],
        },
        paranoid_interpreters: {
          enabled: false,
          source: 'preset',
          sources: ['policy safety.level=standard'],
        },
      },
      ruleOverrides: {},
      weakenedRuleOverrides: [],
      ruleCounts: { stored: 0, effective: 0 },
    },
    posture: { directories: [] },
    findings: [],
    activity: { totalBlocked: 0, sessionCount: 0, recentEntries: [], unreadable: 0 },
    update: { currentVersion: '0.6.0', latestVersion: '0.6.0', updateAvailable: false },
    system: createSystemInfo(),
    ...overrides,
  };
}

describe('formatRulesTable', () => {
  test('formats rules as ASCII table', () => {
    const rules: EffectiveRule[] = [
      {
        source: 'user',
        name: 'no-npm-publish',
        command: 'npm',
        blockArgs: ['publish'],
        reason: 'Block publishing',
      },
      {
        source: 'project',
        name: 'block-deploy',
        command: 'deploy',
        blockArgs: ['--prod'],
        reason: 'Block prod deploys',
      },
    ];

    const table = formatRulesTable(rules);
    expect(table).toContain('Source');
    expect(table).toContain('Name');
    expect(table).toContain('Command');
    expect(table).toContain('Block Args');
    expect(table).toContain('no-npm-publish');
    expect(table).toContain('block-deploy');
    expect(table).toContain('user');
    expect(table).toContain('project');
  });

  test('handles empty rules list', () => {
    const table = formatRulesTable([]);
    expect(table).toContain('no custom rules');
  });

  test('handles rules with subcommand', () => {
    const rules: EffectiveRule[] = [
      {
        source: 'user',
        name: 'no-git-push-force',
        command: 'git',
        subcommand: 'push',
        blockArgs: ['--force'],
        reason: 'Block force push',
      },
    ];

    const table = formatRulesTable(rules);
    expect(table).toContain('git push');
  });
});

describe('formatHooksSection', () => {
  test('formats detected and configured integrations without host-test wording', () => {
    const hooks: HookStatus[] = [
      {
        platform: 'claude-code',
        detected: true,
        configured: true,
        inspectionStatus: 'verified',
        method: 'marketplace plugin',
      },
    ];

    const output = formatHooksSection(hooks);
    expect(output).toContain('Hook Integration');
    expect(output).toContain('Claude Code');
    expect(output).toContain('Detected');
    expect(output).toContain('Configured');
    expect(output).toContain('Verified');
    expect(output).not.toContain('Tests');
    expect(output).not.toContain('3/3');
  });

  test('formats not-applicable integrations explicitly', () => {
    const hooks: HookStatus[] = [
      {
        platform: 'gemini-cli',
        detected: false,
        configured: false,
        inspectionStatus: 'not-applicable',
      },
    ];

    const output = formatHooksSection(hooks);
    expect(output).toContain('Gemini CLI');
    expect(output).toContain('Not detected');
    expect(output).toContain('Not applicable');
  });

  test('formats not-inspected integrations without claiming they are absent', () => {
    const output = formatHooksSection([
      {
        platform: 'claude-code',
        detected: false,
        configured: false,
        inspectionStatus: 'not-inspected',
      },
    ]);

    expect(output).toContain('Claude Code');
    expect(output).toContain('Not inspected');
    expect(output).not.toContain('Not detected');
    expect(output).not.toContain('Not applicable');
  });

  test('formats GitHub Copilot CLI hooks', () => {
    const hooks: HookStatus[] = [
      {
        platform: 'copilot-cli',
        detected: true,
        configured: true,
        inspectionStatus: 'verified',
      },
    ];

    const output = formatHooksSection(hooks);
    expect(output).toContain('GitHub Copilot CLI');
    expect(output).toContain('Configured');
  });

  test('formats Kimi Code hooks', () => {
    const hooks: HookStatus[] = [
      {
        platform: 'kimi-code',
        detected: true,
        configured: true,
        inspectionStatus: 'verified',
      },
    ];

    const output = formatHooksSection(hooks);
    expect(output).toContain('Kimi Code');
    expect(output).toContain('Configured');
  });

  test('formats Pi hooks', () => {
    const hooks: HookStatus[] = [
      { platform: 'pi', detected: true, configured: true, inspectionStatus: 'verified' },
    ];

    const output = formatHooksSection(hooks);
    expect(output).toContain('Pi');
    expect(output).toContain('Configured');
  });

  test('does not show config source paths in text output', () => {
    const hooks: HookStatus[] = [
      {
        platform: 'copilot-cli',
        detected: true,
        configured: true,
        inspectionStatus: 'verified',
        configPaths: ['/repo/.github/copilot/settings.json', '/repo/.github/hooks/safety-net.json'],
      },
    ];

    const output = formatHooksSection(hooks);
    expect(output).not.toContain('Sources (GitHub Copilot CLI):');
    expect(output).not.toContain('/repo/.github/copilot/settings.json');
    expect(output).not.toContain('/repo/.github/hooks/safety-net.json');
  });

  test('shows error for failed detection', () => {
    const hooks: HookStatus[] = [
      {
        platform: 'opencode',
        detected: false,
        configured: false,
        inspectionStatus: 'failed',
        errors: ['Parse error'],
      },
    ];

    const output = formatHooksSection(hooks);
    expect(output).toContain('Error (OpenCode): Parse error');
  });

  test('shows hook errors in red when colors are enabled', () => {
    withStdoutColor(true, () => {
      const hooks: HookStatus[] = [
        {
          platform: 'codex',
          detected: false,
          configured: false,
          inspectionStatus: 'failed',
          errors: ['Parse error'],
        },
      ];
      expect(formatHooksSection(hooks)).toContain('\x1b[31m   Error (Codex): Parse error\x1b[0m');
    });
  });

  test('shows warning for configured hooks with errors', () => {
    const hooks: HookStatus[] = [
      {
        platform: 'claude-code',
        detected: true,
        configured: true,
        inspectionStatus: 'verified',
        errors: ['Something went wrong during detection'],
      },
    ];

    const output = formatHooksSection(hooks);
    expect(output).toContain('Warning (Claude Code): Something went wrong during detection');
  });

  test('formats detected but misconfigured hooks', () => {
    const hooks: HookStatus[] = [
      {
        platform: 'claude-code',
        detected: true,
        configured: false,
        inspectionStatus: 'verified',
      },
    ];

    const output = formatHooksSection(hooks);
    expect(output).toContain('Claude Code');
    expect(output).toContain('Not configured');
  });
});

describe('formatEngineSelfTestSection', () => {
  test('formats the shared guard-engine self-test in its own section', () => {
    const output = formatEngineSelfTestSection({
      passed: 3,
      failed: 0,
      total: 3,
      results: [],
    });

    expect(output).toContain('Guard Engine Verification');
    expect(output).toContain('Synthetic self-test');
    expect(output).toContain('3/3 passed');
  });

  test('shows shared engine failures without host-integration wording', () => {
    const output = formatEngineSelfTestSection({
      passed: 2,
      failed: 1,
      total: 3,
      results: [
        {
          command: 'rm -rf /',
          description: 'rm -rf /',
          expected: 'blocked',
          actual: 'allowed',
          passed: false,
        },
      ],
    });

    expect(output).toContain('2/3 FAIL');
    expect(output).toContain('Failures:');
    expect(output).toContain('rm -rf /');
    expect(output).toContain('expected blocked, got allowed');
    expect(output).not.toContain('Claude Code');
  });
});

describe('formatEnvironmentSection', () => {
  test('formats environment variables as table', () => {
    const envVars = getEnvironmentInfo();
    const output = formatEnvironmentSection(envVars);
    expect(output).toContain('Environment');
    // Should be a table with Variable and Status columns
    expect(output).toContain('Variable');
    expect(output).toContain('Status');
    expect(output).toContain('CC_SAFETY_NET_STRICT');
    // Should have table borders
    expect(output).toContain('┌');
    expect(output).toContain('┘');
  });

  test('shows ✓ for enabled variables', () => {
    const envVars = [
      {
        name: 'CC_SAFETY_NET_STRICT',
        description: 'Fail-closed',
        defaultBehavior: 'permissive',
        value: '1',
        isSet: true,
        legacyName: 'SAFETY_NET_STRICT',
        legacyValue: undefined,
        legacyIsSet: false,
      },
    ];
    const output = formatEnvironmentSection(envVars);
    expect(output).toContain('✓');
  });

  test('shows ✗ for disabled variables', () => {
    const envVars = [
      {
        name: 'CC_SAFETY_NET_STRICT',
        description: 'Fail-closed',
        defaultBehavior: 'permissive',
        value: undefined,
        isSet: false,
        legacyName: 'SAFETY_NET_STRICT',
        legacyValue: undefined,
        legacyIsSet: false,
      },
    ];
    const output = formatEnvironmentSection(envVars);
    expect(output).toContain('✗');
  });
});

describe('formatEffectiveSafetySection', () => {
  test('formats effective level and capability sources', () => {
    const output = formatEffectiveSafetySection(
      createDoctorReport({
        effectiveSafety: {
          selectedPreset: 'standard',
          level: 'custom',
          capabilities: {
            fail_closed: {
              enabled: true,
              source: 'environment',
              sources: ['env CC_SAFETY_NET_STRICT'],
            },
            paranoid_rm: { enabled: false, source: 'preset', sources: [] },
            paranoid_interpreters: {
              enabled: true,
              source: 'capability_override',
              sources: ['policy safety.overrides.paranoid_interpreters'],
            },
          },
          ruleOverrides: { 'shell.dynamic-executable': 'on' },
          weakenedRuleOverrides: [],
          ruleCounts: { stored: 1, effective: 1 },
        },
      }),
    );

    expect(output).toContain('Effective Safety');
    expect(output).toContain('Effective: custom');
    expect(output).toContain('fail_closed');
    expect(output).toContain('env CC_SAFETY_NET_STRICT');
  });
});

describe('formatActivitySection', () => {
  test('formats empty activity', () => {
    const activity = { totalBlocked: 0, sessionCount: 0, recentEntries: [], unreadable: 0 };
    const output = formatActivitySection(activity);
    expect(output).toContain('Recent Activity');
    expect(output).toContain('No blocked commands');
    expect(output).not.toContain('incomplete');
  });

  test('says an empty summary is incomplete when sources could not be read', () => {
    // Otherwise "no blocked commands" reads as evidence of safety it does not have.
    const output = formatActivitySection({
      totalBlocked: 0,
      sessionCount: 0,
      recentEntries: [],
      unreadable: 2,
    });
    expect(output).toContain('2 audit log sources could not be read');
    expect(output).toContain('incomplete');
  });

  test('formats activity with entries', () => {
    const activity = {
      totalBlocked: 3,
      sessionCount: 2,
      unreadable: 0,
      recentEntries: [
        {
          timestamp: '2025-01-01T00:00:00Z',
          command: 'git reset --hard',
          reason: 'Blocked',
          relativeTime: '1h ago',
        },
      ],
    };
    const output = formatActivitySection(activity);
    // Header now shows summary in compact format
    expect(output).toContain('3 blocked');
    expect(output).toContain('2 sessions');
    // Table format
    expect(output).toContain('Time');
    expect(output).toContain('Command');
    expect(output).toContain('1h ago');
    expect(output).toContain('git reset --hard');
    // Should have table borders
    expect(output).toContain('┌');
    expect(output).toContain('┘');
  });

  test('keeps multiline commands within one table row', () => {
    const output = formatActivitySection({
      totalBlocked: 1,
      sessionCount: 1,
      unreadable: 0,
      recentEntries: [
        {
          timestamp: '2025-01-01T00:00:00Z',
          command: 'git status --short\nfind src/secrets -maxdepth 2 -type f -print',
          reason: 'Blocked',
          relativeTime: '54m ago',
        },
      ],
    });

    expect(output).toContain('git status --short ↵ find src/secrets...');
    expect(output).not.toContain('git status --short\nfind');
  });

  test('escapes terminal control bytes in activity commands', () => {
    const output = formatActivitySection({
      totalBlocked: 1,
      sessionCount: 1,
      unreadable: 0,
      recentEntries: [
        {
          timestamp: '2025-01-01T00:00:00Z',
          command: 'printf \x1b[31mred',
          reason: 'Blocked',
          relativeTime: '1h ago',
        },
      ],
    });

    expect(output).toContain(String.raw`printf \x1b[31mred`);
    expect(output).not.toContain('\x1b');
  });
});

describe('formatUpdateSection', () => {
  test('formats update available as table', () => {
    const update = {
      currentVersion: '0.6.0',
      latestVersion: '0.7.0',
      updateAvailable: true,
    };
    const output = formatUpdateSection(update);
    expect(output).toContain('Update Check');
    expect(output).toContain('Update Available');
    expect(output).toContain('0.6.0');
    expect(output).toContain('0.7.0');
    expect(output).toContain('bunx');
    expect(output).toContain('npx');
    // Should have table borders
    expect(output).toContain('┌');
    expect(output).toContain('┘');
  });

  test('formats up to date as table', () => {
    const update = {
      currentVersion: '0.7.0',
      latestVersion: '0.7.0',
      updateAvailable: false,
    };
    const output = formatUpdateSection(update);
    expect(output).toContain('Update Check');
    expect(output).toContain('Up to date');
    expect(output).toContain('0.7.0');
    // Should have table borders
    expect(output).toContain('┌');
    expect(output).toContain('┘');
  });

  test('formats skipped update check as table', () => {
    const update = {
      currentVersion: '0.6.0',
      latestVersion: null,
      updateAvailable: false,
    };
    const output = formatUpdateSection(update);
    expect(output).toContain('Update Check');
    expect(output).toContain('Skipped');
    expect(output).toContain('0.6.0');
    // Should have table borders
    expect(output).toContain('┌');
    expect(output).toContain('┘');
  });

  test('formats error as table', () => {
    const update = {
      currentVersion: '0.6.0',
      latestVersion: null,
      updateAvailable: false,
      error: 'Network error',
    };
    const output = formatUpdateSection(update);
    expect(output).toContain('Update Check');
    expect(output).toContain('Error');
    expect(output).toContain('0.6.0');
    expect(output).toContain('Network error');
    // Should have table borders
    expect(output).toContain('┌');
    expect(output).toContain('┘');
  });
});

describe('formatSystemInfoSection', () => {
  test('formats system info as table', async () => {
    const sysInfo = await getSystemInfo(mockVersionFetcher);
    const output = formatSystemInfoSection(sysInfo);
    expect(output).toContain('System Info');
    // Table headers
    expect(output).toContain('Component');
    expect(output).toContain('Version');
    // Component names (without colons since it's a table)
    expect(output).toContain('cc-safety-net');
    expect(output).toContain('Platform');
    expect(output).toContain('Bun');
    expect(output).toContain('GitHub Copilot CLI');
    expect(output).toContain('Antigravity CLI');
    expect(output).toContain('Amp Code');
    expect(output).toContain('Codex');
    expect(output).toContain('Cursor');
    expect(output).toContain('Kimi Code');
    expect(output).toContain('Pi');
    expect(output.indexOf('cc-safety-net')).toBeLessThan(output.indexOf('Claude Code'));
    expect(output.indexOf('Claude Code')).toBeLessThan(output.indexOf('Amp Code'));
    expect(output.indexOf('Amp Code')).toBeLessThan(output.indexOf('Antigravity CLI'));
    expect(output.indexOf('Antigravity CLI')).toBeLessThan(output.indexOf('Codex'));
    expect(output.indexOf('Codex')).toBeLessThan(output.indexOf('Cursor'));
    expect(output.indexOf('Cursor')).toBeLessThan(output.indexOf('Gemini CLI'));
    expect(output.indexOf('Gemini CLI')).toBeLessThan(output.indexOf('GitHub Copilot CLI'));
    expect(output.indexOf('GitHub Copilot CLI')).toBeLessThan(output.indexOf('Hermes Agent'));
    expect(output.indexOf('Hermes Agent')).toBeLessThan(output.indexOf('Kimi Code'));
    expect(output.indexOf('Kimi Code')).toBeLessThan(output.indexOf('OpenClaw'));
    expect(output.indexOf('OpenClaw')).toBeLessThan(output.indexOf('OpenCode'));
    expect(output.indexOf('OpenCode')).toBeLessThan(output.indexOf('Pi'));
    expect(output.indexOf('Pi')).toBeLessThan(output.indexOf('Node.js'));
    expect(output.indexOf('Node.js')).toBeLessThan(output.indexOf('npm'));
    expect(output.indexOf('npm')).toBeLessThan(output.indexOf('Bun'));
    expect(output.indexOf('Bun')).toBeLessThan(output.indexOf('Platform'));
    // Should have table borders
    expect(output).toContain('┌');
    expect(output).toContain('┘');
  });

  test('formats null versions as "not found"', () => {
    const sysInfo = createSystemInfo({
      version: 'dev',
      npmVersion: null,
      platform: 'darwin arm64',
    });
    const output = formatSystemInfoSection(sysInfo);
    expect(output).toContain('not found');
  });
});

describe('formatConfigSection', () => {
  test('formats config with no rules', () => {
    const report = createDoctorReport({
      userConfig: {
        path: '/home/user/.cc-safety-net/rules/rule.json',
        exists: false,
        valid: false,
        ruleCount: 0,
      },
      projectConfig: {
        path: './.cc-safety-net/rules/rule.json',
        exists: false,
        valid: false,
        ruleCount: 0,
      },
    });
    const output = formatConfigSection(report);
    expect(output).toContain('Configuration');
    expect(output).toContain('User');
    expect(output).toContain('Project');
    expect(output).toContain('N/A');
  });

  test('formats config with shadow warnings', () => {
    const report = createDoctorReport({
      userConfig: {
        path: '/home/user/.cc-safety-net/rules/rule.json',
        exists: true,
        valid: true,
        ruleCount: 1,
      },
      projectConfig: {
        path: './.cc-safety-net/rules/rule.json',
        exists: true,
        valid: true,
        ruleCount: 1,
      },
      effectiveRules: [
        {
          source: 'project',
          name: 'test-rule',
          command: 'test',
          blockArgs: ['--flag'],
          reason: 'Test',
        },
      ],
      shadowedRules: [{ name: 'test-rule', shadowedBy: 'project' }],
    });
    const output = formatConfigSection(report);
    expect(output).toContain('shadows user rule');
  });

  test('formats config with invalid config showing errors', () => {
    const report = createDoctorReport({
      userConfig: {
        path: '/home/user/.cc-safety-net/rules/rule.json',
        exists: true,
        valid: false,
        ruleCount: 0,
        errors: ['Invalid version: expected 1, got 99'],
      },
      projectConfig: {
        path: './.cc-safety-net/rules/rule.json',
        exists: true,
        valid: false,
        ruleCount: 0,
        errors: ['Malformed JSON'],
      },
    });
    const output = formatConfigSection(report);
    expect(output).toContain('Invalid');
    expect(output).toContain('Invalid version: expected 1, got 99');
    expect(output).toContain('Malformed JSON');
  });
});

describe('formatSummary', () => {
  test('reports no findings without claiming uninspected controls are healthy', () => {
    const report = createDoctorReport({
      hooks: [
        {
          platform: 'claude-code',
          detected: true,
          configured: true,
          inspectionStatus: 'verified',
        },
      ],
      activity: { totalBlocked: 1, sessionCount: 1, recentEntries: [], unreadable: 0 },
    });
    const output = formatSummary(report);
    expect(output).toContain('No findings from inspected doctor facts');
    expect(output).not.toContain('All checks passed');
  });

  test('counts warnings from typed findings only', () => {
    const report = createDoctorReport({
      findings: [
        {
          checkId: 'test.warning',
          severity: 'warning',
          title: 'Warning',
          detail: 'Warning detail',
        },
      ],
      update: { currentVersion: '0.6.0', latestVersion: '0.7.0', updateAvailable: true },
    });
    const output = formatSummary(report);
    expect(output).toContain('1 finding: 1 warning');
  });

  test('counts errors from typed findings only', () => {
    const report = createDoctorReport({
      findings: [
        {
          checkId: 'test.error',
          severity: 'error',
          title: 'Error',
          detail: 'Error detail',
        },
      ],
    });
    const output = formatSummary(report);
    expect(output).toContain('1 finding: 1 error');
  });
});

describe('formatFindingsSection', () => {
  test.each([
    ['warning', '[WARNING] test.warning'],
    ['info', '[INFO] test.info'],
  ] as const)('labels %s findings', (severity, expected) => {
    const output = formatFindingsSection([
      {
        checkId: `test.${severity}`,
        severity,
        title: `${severity} title`,
        detail: `${severity} detail`,
      },
    ]);

    expect(output).toContain(expected);
  });

  test('formats the same typed fields exposed by JSON', () => {
    const output = formatFindingsSection([
      {
        checkId: 'config.user-invalid',
        severity: 'error',
        title: 'User configuration is invalid',
        detail: 'Doctor could not load a valid user rules configuration.',
        fixHint: 'Run `cc-safety-net rule verify`.',
        path: '/home/user/.cc-safety-net/rules/rule.json',
      },
    ]);

    expect(output).toContain('Findings');
    expect(output).toContain('[ERROR] config.user-invalid');
    expect(output).toContain('Doctor could not load a valid user rules configuration.');
    expect(output).toContain('Path: /home/user/.cc-safety-net/rules/rule.json');
    expect(output).toContain('Fix: Run `cc-safety-net rule verify`.');
  });

  test('reports no findings from the inspected facts', () => {
    expect(formatFindingsSection([])).toContain('No findings from inspected doctor facts.');
  });
});
