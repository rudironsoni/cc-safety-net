import { resolve } from 'node:path';
import { collectCustomRuleNames, formatSchemaIssues, getLegacyConfigSchema } from '@/policy/schema';
import { validateRulesConfig } from './policy/config-file';
import {
  bindDelegatedPolicyFilesystemTarget,
  PolicyFilesystemError,
  type PolicyFilesystemTarget,
  readPolicyFile,
} from './policy/filesystem';

/** Result of config validation */
export interface ValidationResult {
  /** List of validation error messages */
  errors: string[];
  /** Set of rule names found (for duplicate detection) */
  ruleNames: Set<string>;
}

export function validateConfig(config: unknown): ValidationResult {
  const parsed = getLegacyConfigSchema().safeParse(config);
  return {
    errors: parsed.success ? [] : formatSchemaIssues(parsed.error.issues),
    ruleNames: new Set(collectCustomRuleNames(config).map((name) => name.toLowerCase())),
  };
}

export function validateConfigFile(path: string | PolicyFilesystemTarget): ValidationResult {
  const loaded = readConfigFileInput(path);
  if (!loaded.ok) return loaded.result;
  return validateConfig(loaded.parsed);
}

type ConfigFileInput = { ok: true; parsed: unknown } | { ok: false; result: ValidationResult };

function readConfigFileInput(path: string | PolicyFilesystemTarget): ConfigFileInput {
  const errors: string[] = [];
  const ruleNames = new Set<string>();

  try {
    const target = typeof path === 'string' ? bindDelegatedPolicyFilesystemTarget(path) : path;
    const content = readPolicyFile(target);
    if (content === null) {
      errors.push(`File not found: ${target.path}`);
      return { ok: false, result: { errors, ruleNames } };
    }
    if (!content.trim()) {
      errors.push('Config file is empty');
      return { ok: false, result: { errors, ruleNames } };
    }

    return { ok: true, parsed: JSON.parse(content) as unknown };
  } catch (error) {
    if (error instanceof PolicyFilesystemError) {
      errors.push(error.message);
      return { ok: false, result: { errors, ruleNames } };
    }
    // Only a parse failure means malformed JSON; every other failure names itself.
    const message = error instanceof Error ? error.message : String(error);
    errors.push(error instanceof SyntaxError ? 'Invalid JSON' : message);
    return { ok: false, result: { errors, ruleNames } };
  }
}

export function getLegacyProjectConfigPath(cwd?: string): string {
  return resolve(cwd ?? process.cwd(), '.safety-net.json');
}

export function validateRulesConfigFile(path: string | PolicyFilesystemTarget): ValidationResult {
  const loaded = readConfigFileInput(path);
  if (!loaded.ok) return loaded.result;
  const result = validateRulesConfig(loaded.parsed);
  return { errors: result.errors, ruleNames: result.sources };
}
