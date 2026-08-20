/**
 * The read-only engine facade: the single module the diagnostic surfaces
 * (explain, doctor, status, statusline, logs, GUI) consume instead of reaching
 * into core, config, and parser directly. `tests/architecture.test.ts` enforces
 * that boundary.
 *
 * Write paths stay out by design — rules administration (`cli/rule`) and the
 * GUI policy editor (`gui`) keep their own read-write imports as the two
 * named exceptions in that test.
 */

export { PathCanonicalizationLimitError } from '@/analyzer/path-canonicalization';
export { isReservedTransparentWrapper } from '@/analyzer/transparent-wrappers';
export { getAuditLogHomeDir, getAuditLogsDir } from '@/engine/audit';
export { formatRelativeTime } from '@/engine/audit-display';
export { pruneExpiredAuditLogs, resolveAuditRetentionDays } from '@/engine/audit-retention';
export {
  commandSignature,
  findSuspectEntries,
  listAuditLogFiles,
  readAuditLogEntries,
} from '@/engine/audit-scan';
export { explainCommand } from '@/engine/explain';
export { StructuralShellSyntaxLimitError } from '@/guards/semantic-facts';
export { ToolInputLimitError } from '@/parser/tool-input';
export {
  ENV_FLAGS,
  type EnvFlag,
  envFlagIsSet,
  envTruthy,
  getCCSafetyNetEnvModes,
  getEnvFlagValue,
  resolveAuditScope,
} from '@/policy/env';
export { getUserPolicyDiagnostics } from '@/policy/schema';
export {
  createPolicySnapshot,
  describeConfigState,
  loadPolicySnapshot,
} from '@/policy/snapshot';
export { getUserPolicyPath } from '@/policy/store';
export { type ValidationResult, validateRulesConfigFile } from '@/rules/config';
export { COMMAND_PATTERN } from '@/rules/constants';
export { resolveEffectiveDestructiveCommandRules } from '@/rules/destructive-command-rules';
export {
  getProjectRulesConfigPath,
  getRulesConfigRuntimeErrorsForConfig,
  getRulesLockPathForConfigPath,
  getUserRulesConfigPath,
  getUserRulesLockPath,
  loadRulesPolicy,
} from '@/rules/policy';
export {
  PolicyFilesystemError,
  type PolicyFilesystemScope,
  type PolicyFilesystemTarget,
  readPolicyFile,
} from '@/rules/policy/filesystem';
export { getPolicyPaths } from '@/rules/policy/paths';
export type { RulesPolicyOptions } from '@/rules/policy/types';
