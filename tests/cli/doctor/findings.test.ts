import { describe, expect, test } from 'bun:test';
import { deriveDoctorFindings } from '@/cli/doctor/findings';
import type { DoctorReport } from '@/integrations/doctor-types';

type DoctorFacts = Omit<DoctorReport, 'findings'>;

function createReport(overrides: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    hooks: [
      {
        platform: 'claude-code',
        detected: true,
        configured: true,
        inspectionStatus: 'verified',
      },
    ],
    engineSelfTest: { passed: 3, failed: 0, total: 3, results: [] },
    userConfig: {
      path: '/home/user/.cc-safety-net/rules/rule.json',
      exists: false,
      valid: false,
      ruleCount: 0,
    },
    projectConfig: {
      path: '/project/.cc-safety-net/rules/rule.json',
      exists: false,
      valid: false,
      ruleCount: 0,
    },
    configState: { state: 'ready' },
    effectiveRules: [],
    shadowedRules: [],
    environment: [],
    effectiveSafety: {
      selectedPreset: 'standard',
      level: 'standard',
      capabilities: {
        fail_closed: { enabled: false, source: 'preset', sources: [] },
        paranoid_rm: { enabled: false, source: 'preset', sources: [] },
        paranoid_interpreters: { enabled: false, source: 'preset', sources: [] },
      },
      ruleOverrides: {},
      weakenedRuleOverrides: [],
      ruleCounts: { stored: 0, effective: 0 },
    },
    posture: { directories: [] },
    activity: { totalBlocked: 0, sessionCount: 0, recentEntries: [], unreadable: 0 },
    update: { currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false },
    system: {
      version: '1.0.0',
      versions: {},
      codexPluginListOutput: null,
      ampPluginListOutput: null,
      nodeVersion: null,
      npmVersion: null,
      bunVersion: null,
      platform: 'test',
    },
    ...overrides,
  };
}

describe('deriveDoctorFindings', () => {
  test('returns no findings when all collected facts are healthy', () => {
    expect(deriveDoctorFindings(createReport())).toEqual([]);
  });

  test('reports no configured integration as an error with an install action', () => {
    const findings = deriveDoctorFindings(
      createReport({
        hooks: [
          {
            platform: 'claude-code',
            detected: true,
            configured: false,
            inspectionStatus: 'verified',
          },
        ],
      }),
    );

    expect(findings).toContainEqual({
      checkId: 'integration.none-configured',
      severity: 'error',
      title: 'No integration configured',
      detail: 'CC Safety Net is not connected to any supported coding-agent integration.',
      fixHint: 'Run `cc-safety-net install` and configure at least one integration.',
    });
    expect(deriveDoctorFindings(createReport())).not.toContainEqual(
      expect.objectContaining({ checkId: 'integration.none-configured' }),
    );
  });

  test('reports an integration inspection failure without copying its raw error', () => {
    const findings = deriveDoctorFindings(
      createReport({
        hooks: [
          {
            platform: 'claude-code',
            detected: true,
            configured: true,
            inspectionStatus: 'failed',
            errors: ['sensitive-inspection-value'],
          },
        ],
      }),
    );

    expect(findings).toContainEqual({
      checkId: 'integration.inspection-failed',
      severity: 'error',
      title: 'Claude Code inspection failed',
      detail: 'Doctor could not verify the Claude Code integration configuration.',
      fixHint:
        'Correct the reported Claude Code configuration error, then run `cc-safety-net doctor` again.',
      integration: 'claude-code',
    });
    expect(JSON.stringify(findings)).not.toContain('sensitive-inspection-value');
    expect(deriveDoctorFindings(createReport())).not.toContainEqual(
      expect.objectContaining({ checkId: 'integration.inspection-failed' }),
    );
  });

  for (const scope of ['user', 'project'] as const) {
    test(`reports an invalid ${scope} configuration as an error with a verification action`, () => {
      const config = {
        path: `/${scope}/rule.json`,
        exists: true,
        valid: false,
        ruleCount: 0,
        errors: ['sensitive-config-value'],
      };
      const findings = deriveDoctorFindings(
        createReport(scope === 'user' ? { userConfig: config } : { projectConfig: config }),
      );

      expect(findings).toContainEqual({
        checkId: `config.${scope}-invalid`,
        severity: 'error',
        title: `${scope === 'user' ? 'User' : 'Project'} configuration is invalid`,
        detail: `Doctor could not load a valid ${scope} rules configuration.`,
        fixHint: 'Run `cc-safety-net rule verify`, correct the reported error, then rerun doctor.',
        path: `/${scope}/rule.json`,
      });
      expect(JSON.stringify(findings)).not.toContain('sensitive-config-value');

      const valid = { ...config, valid: true, errors: undefined };
      expect(
        deriveDoctorFindings(
          createReport(scope === 'user' ? { userConfig: valid } : { projectConfig: valid }),
        ),
      ).not.toContainEqual(expect.objectContaining({ checkId: `config.${scope}-invalid` }));
    });
  }

  test('reports the degraded runtime configuration state with its full reason', () => {
    const expected = {
      checkId: 'config.runtime-degraded',
      severity: 'warning' as const,
      title: 'Runtime is enforcing a fallback configuration',
      detail:
        'The rejected candidate configuration is not active: local source digest mismatch for ./rules; enforcing the verified cached rulebook; the local edit is pending; run `cc-safety-net rule sync`.',
      fixHint:
        'Correct the named source, run `cc-safety-net rule sync` for a rule source, then rerun doctor.',
    };
    const reason = expected.detail.slice(expected.detail.indexOf(': ') + 2);

    expect(
      deriveDoctorFindings(createReport({ configState: { state: 'degraded', reason } })),
    ).toContainEqual(expected);
    expect(deriveDoctorFindings(createReport())).not.toContainEqual(
      expect.objectContaining({ checkId: expected.checkId }),
    );
  });

  test('reports an unrecognized audit scope and never echoes its value', () => {
    const environment = (value: string | undefined) => [
      {
        name: 'CC_SAFETY_NET_AUDIT_SCOPE',
        value,
        isSet: value !== undefined,
        description: 'audit scope',
        defaultBehavior: 'all',
      },
    ];

    for (const value of ['', 'ALL', 'Blocked', 'sensitive-env-value']) {
      const findings = deriveDoctorFindings(createReport({ environment: environment(value) }));
      expect(findings).toContainEqual({
        checkId: 'environment.audit-scope-invalid',
        severity: 'warning',
        title: 'Audit scope value is invalid',
        detail:
          'CC_SAFETY_NET_AUDIT_SCOPE is not `all` or `blocked`, so allowed command decisions are not recorded.',
        fixHint:
          'Set CC_SAFETY_NET_AUDIT_SCOPE to `all` or `blocked`, then restart the integration.',
      });
      expect(JSON.stringify(findings)).not.toContain('sensitive-env-value');
    }
    for (const value of [undefined, 'all', 'blocked']) {
      expect(
        deriveDoctorFindings(createReport({ environment: environment(value) })),
      ).not.toContainEqual(expect.objectContaining({ checkId: 'environment.audit-scope-invalid' }));
    }
  });

  test('debug no longer produces an allow-logging finding', () => {
    expect(
      deriveDoctorFindings(
        createReport({
          environment: [
            {
              name: 'CC_SAFETY_NET_DEBUG',
              value: '1',
              isSet: true,
              description: 'debug',
              defaultBehavior: 'off',
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  for (const kind of ['policy', 'config', 'audit'] as const) {
    test(`reports an unsafe ${kind} directory as an integrity error`, () => {
      const findings = deriveDoctorFindings(
        createReport({
          posture: {
            directories: [
              {
                kind,
                path: `/home/user/.cc-safety-net/${kind}`,
                status: 'unsafe',
                issues: ['permissions'],
              },
            ],
          },
        }),
      );

      expect(findings).toContainEqual({
        checkId: `posture.${kind}-directory-unsafe`,
        severity: 'error',
        title: `${kind[0]?.toUpperCase()}${kind.slice(1)} directory is unsafe`,
        detail: `The ${kind} directory has unsafe permissions.`,
        fixHint:
          'Ensure this is a real directory owned by the current user with no group or other write access, then rerun doctor.',
        path: `/home/user/.cc-safety-net/${kind}`,
      });

      expect(
        deriveDoctorFindings(
          createReport({
            posture: {
              directories: [
                {
                  kind,
                  path: `/home/user/.cc-safety-net/${kind}`,
                  status: 'safe',
                  issues: [],
                },
              ],
            },
          }),
        ),
      ).not.toContainEqual(
        expect.objectContaining({ checkId: `posture.${kind}-directory-unsafe` }),
      );
    });
  }

  for (const evidence of [
    { issue: 'ownership', detail: 'is not owned by the current user' },
    { issue: 'permissions', detail: 'has unsafe permissions' },
    { issue: 'symlink', detail: 'is a symbolic link' },
    { issue: 'not-directory', detail: 'is not a directory' },
  ] as const) {
    test(`describes unsafe directory ${evidence.issue} evidence`, () => {
      const findings = deriveDoctorFindings(
        createReport({
          posture: {
            directories: [
              {
                kind: 'policy',
                path: '/policy',
                status: 'unsafe',
                issues: [evidence.issue],
              },
            ],
          },
        }),
      );

      expect(findings[0]?.detail).toBe(`The policy directory ${evidence.detail}.`);
    });
  }

  test('reports only explicit overrides that weaken resolved preset enforcement', () => {
    for (const selectedPreset of ['standard', 'strict', 'paranoid'] as const) {
      const effectiveSafety = {
        ...createReport().effectiveSafety,
        selectedPreset,
        ruleOverrides: { 'git.force-delete': 'off' as const, 'rm.paranoid': 'on' as const },
        weakenedRuleOverrides: ['git.force-delete'],
        ruleCounts: { stored: 2, effective: 2 },
      };
      expect(deriveDoctorFindings(createReport({ effectiveSafety }))).toContainEqual({
        checkId: 'posture.rule-overrides-weaken-preset',
        severity: 'warning',
        title: 'Rule overrides weaken the selected preset',
        detail:
          'Explicit overrides disable rules the resolved preset would enable: git.force-delete.',
        fixHint: 'Remove these `off` overrides or set them to `on`: git.force-delete.',
      });
    }

    const customizationWithoutWeakening = {
      ...createReport().effectiveSafety,
      ruleOverrides: { 'rm.paranoid': 'off' as const },
      weakenedRuleOverrides: [],
      ruleCounts: { stored: 1, effective: 0 },
    };
    expect(
      deriveDoctorFindings(createReport({ effectiveSafety: customizationWithoutWeakening })),
    ).not.toContainEqual(
      expect.objectContaining({ checkId: 'posture.rule-overrides-weaken-preset' }),
    );
  });

  test('orders findings by severity and then stable catalog order', () => {
    const report = createReport({
      hooks: [
        {
          platform: 'claude-code',
          detected: true,
          configured: false,
          inspectionStatus: 'verified',
        },
      ],
      userConfig: {
        path: '/user/rule.json',
        exists: true,
        valid: false,
        ruleCount: 0,
        errors: ['invalid'],
      },
      environment: [
        {
          name: 'CC_SAFETY_NET_AUDIT_SCOPE',
          value: 'everything',
          isSet: true,
          description: 'audit scope',
          defaultBehavior: 'all',
        },
      ],
      effectiveSafety: {
        ...createReport().effectiveSafety,
        ruleOverrides: { 'git.force-delete': 'off' },
        weakenedRuleOverrides: ['git.force-delete'],
        ruleCounts: { stored: 1, effective: 1 },
      },
      posture: {
        directories: [
          {
            kind: 'audit',
            path: '/audit',
            status: 'unsafe',
            issues: ['symlink'],
          },
        ],
      },
    });

    expect(deriveDoctorFindings(report).map((finding) => finding.checkId)).toEqual([
      'integration.none-configured',
      'config.user-invalid',
      'posture.audit-directory-unsafe',
      'environment.audit-scope-invalid',
      'posture.rule-overrides-weaken-preset',
    ]);
  });
});
