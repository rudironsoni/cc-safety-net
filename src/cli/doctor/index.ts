/**
 * Main entry point for the doctor command.
 */

import { getActivitySummary } from '@/cli/doctor/activity';
import { getConfigInfo } from '@/cli/doctor/config';
import { getEnvironmentInfo } from '@/cli/doctor/environment';
import { deriveDoctorFindings } from '@/cli/doctor/findings';
import {
  formatActivitySection,
  formatConfigSection,
  formatEffectiveSafetySection,
  formatEngineSelfTestSection,
  formatEnvironmentSection,
  formatFindingsSection,
  formatHooksSection,
  formatSummary,
  formatSystemInfoSection,
  formatUpdateSection,
} from '@/cli/doctor/format';
import { getDoctorPosture } from '@/cli/doctor/posture';
import { checkForUpdates } from '@/cli/doctor/updates';
import { printInstallBanner } from '@/cli/install/banner';
import { resolveAfterOptionalBanner } from '@/cli/startup/banner';
import {
  describeConfigState,
  getCCSafetyNetEnvModes,
  loadPolicySnapshot,
  resolveEffectiveDestructiveCommandRules,
} from '@/engine/facade';
import { detectAllHooks } from '@/integrations/detect';
import type {
  ConfigSourceInfo,
  DoctorOptions,
  DoctorReport,
  HookStatus,
} from '@/integrations/doctor-types';
import { runIntegrationSelfTest } from '@/integrations/self-test';
import { getPackageVersion, getSystemInfo } from '@/integrations/system-info';

export { parseDoctorFlags } from '@/cli/doctor/flags';

export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  const report = await resolveAfterOptionalBanner(
    !options.json,
    () => {
      const reportPromise = collectDoctorReport(options);
      return {
        ready: reportPromise,
        finish: () => reportPromise,
      };
    },
    () => printInstallBanner(),
    { loadingMessage: 'Checking system status…' },
  );

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  return doctorHasFailure(report.hooks, report.engineSelfTest, {
    userConfig: report.userConfig,
    projectConfig: report.projectConfig,
  })
    ? 1
    : 0;
}

async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();

  const system = await getSystemInfo();
  const hooks = detectAllHooks(cwd, {
    ampPluginListOutput: system.ampPluginListOutput,
    codexPluginListOutput: system.codexPluginListOutput,
    copilotCliVersion: system.versions['copilot-cli'],
  });
  const configInfo = getConfigInfo(cwd);
  const environment = getEnvironmentInfo();
  const snapshot = loadPolicySnapshot({ cwd });
  const policy = snapshot.policy;
  const modes = getCCSafetyNetEnvModes(policy);
  const ruleStates = resolveEffectiveDestructiveCommandRules(policy, modes.capabilities);
  const activity = getActivitySummary(7);
  const update = options.skipUpdateCheck
    ? {
        currentVersion: getPackageVersion(),
        latestVersion: null,
        updateAvailable: false,
      }
    : await checkForUpdates();

  const report: Omit<DoctorReport, 'findings'> = {
    hooks,
    engineSelfTest: runIntegrationSelfTest(),
    userConfig: configInfo.userConfig,
    projectConfig: configInfo.projectConfig,
    configState: describeConfigState(snapshot),
    effectiveRules: configInfo.effectiveRules,
    shadowedRules: configInfo.shadowedRules,
    environment,
    effectiveSafety: {
      selectedPreset: policy.safety.level ?? 'standard',
      level: modes.effectiveLevel,
      capabilities: modes.capabilities,
      ruleOverrides: policy.destructiveCommandRuleOverrides,
      weakenedRuleOverrides: Object.entries(ruleStates)
        .filter(
          ([, state]) =>
            state.source === 'rule_override' &&
            state.override === 'off' &&
            state.inheritedEnabled &&
            state.changesInherited,
        )
        .map(([id]) => id),
      ruleCounts: {
        stored: Object.keys(policy.destructiveCommandRuleOverrides).length,
        effective: Object.values(ruleStates).filter((state) => state.changesInherited).length,
      },
    },
    posture: getDoctorPosture(configInfo.userConfig.path),
    activity,
    update,
    system,
  };
  return { ...report, findings: deriveDoctorFindings(report) };
}

function doctorHasFailure(
  hooks: readonly HookStatus[],
  engineSelfTest: DoctorReport['engineSelfTest'],
  configInfo: { userConfig: ConfigSourceInfo; projectConfig: ConfigSourceInfo },
): boolean {
  return (
    (hooks.length > 0 && hooks.every((hook) => !hook.configured)) ||
    hooks.some((hook) => hook.inspectionStatus === 'failed') ||
    engineSelfTest.failed > 0 ||
    (configInfo.userConfig.exists && !configInfo.userConfig.valid) ||
    (configInfo.projectConfig.exists && !configInfo.projectConfig.valid)
  );
}

function printReport(report: DoctorReport): void {
  // 1. Hook integration
  console.log();
  console.log(formatHooksSection(report.hooks));
  console.log();

  // 2. Shared guard engine verification
  console.log(formatEngineSelfTestSection(report.engineSelfTest));
  console.log();

  // 3. Configuration with Rules Table
  console.log(formatConfigSection(report));
  console.log();

  // 4. Environment
  console.log(formatEnvironmentSection(report.environment));
  console.log();

  // 5. Effective safety
  console.log(formatEffectiveSafetySection(report));
  console.log();

  // 6. Findings
  console.log(formatFindingsSection(report.findings));
  console.log();

  // 7. Activity
  console.log(formatActivitySection(report.activity));
  console.log();

  // 8. System Info
  console.log(formatSystemInfoSection(report.system));
  console.log();

  // 9. Update Check
  console.log(formatUpdateSection(report.update));

  // Summary
  console.log(formatSummary(report));
}
