import {
  getIntegrationDisplayName,
  type IntegrationId,
  installIntegrationMetadata,
} from '@/integrations/catalog';
import type { NativeCommand } from '@/integrations/install/native';

export type InstallAction = 'install' | 'uninstall';
export type InstallTarget = IntegrationId;

export const INSTALL_TARGETS: readonly {
  target: InstallTarget;
  flag: string;
  label: string;
  probeCommand: NativeCommand;
}[] = installIntegrationMetadata.map((integration) => ({
  target: integration.id,
  flag: integration.flag,
  label: getIntegrationDisplayName(integration.id),
  probeCommand: integration.probeCommand,
}));

export const TARGET_FLAGS = new Map<string, InstallTarget>(
  INSTALL_TARGETS.map((target) => [target.flag, target.target]),
);

export function orderInstallTargets(targets: readonly InstallTarget[]): InstallTarget[] {
  const selectedTargets = new Set(targets);
  return INSTALL_TARGETS.map((target) => target.target).filter((target) =>
    selectedTargets.has(target),
  );
}

export async function runInstallTargetsInOrder(
  targets: readonly InstallTarget[],
  runTarget: (target: InstallTarget) => Promise<void>,
): Promise<void> {
  for (const target of targets) await runTarget(target);
}
