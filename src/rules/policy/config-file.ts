import { getRulesConfigSchema, getRulesConfigValidation } from '@/policy/schema';
import {
  bindDelegatedPolicyFilesystemTarget,
  PolicyFilesystemError,
  type PolicyFilesystemTarget,
  readPolicyFile,
  writePolicyFileAtomic,
} from './filesystem';
import { DEFAULT_CONFIG, type RulesConfig, type SyncRulesConfigResult } from './types';

export function validateRulesConfig(config: unknown): { errors: string[]; sources: Set<string> } {
  return getRulesConfigValidation(config);
}

export function readRulesConfig(path: string | PolicyFilesystemTarget): {
  config: RulesConfig | null;
  errors: string[];
} {
  try {
    const content = readPolicyFile(toTarget(path));
    if (content === null) return { config: null, errors: [] };
    if (!content.trim()) {
      return { config: null, errors: ['Config file is empty'] };
    }

    const parsed = JSON.parse(content) as unknown;
    const validation = validateRulesConfig(parsed);
    if (validation.errors.length > 0) {
      return { config: null, errors: validation.errors };
    }
    const cfg = getRulesConfigSchema().parse(parsed);
    return {
      config: {
        version: 1,
        rules: cfg.rules ?? [],
        overrides: cfg.overrides ?? {},
        transparent_wrappers: cfg.transparent_wrappers ?? [],
      },
      errors: [],
    };
  } catch (error) {
    if (error instanceof PolicyFilesystemError) {
      return { config: null, errors: [error.message] };
    }
    // Only a parse failure means the file is malformed; anything else — a schema
    // dependency that will not load, say — has to name itself instead of blaming
    // valid JSON.
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: null,
      errors: [error instanceof SyntaxError ? 'Invalid JSON' : message],
    };
  }
}

export function readScopeRulesConfig(
  path: string | PolicyFilesystemTarget,
): { ok: true; config: RulesConfig } | { ok: false; result: SyncRulesConfigResult } {
  const loaded = readRulesConfig(path);
  if (loaded.errors.length > 0) {
    return { ok: false, result: { ok: false, errors: loaded.errors, warnings: [], entries: [] } };
  }
  return { ok: true, config: loaded.config ?? DEFAULT_CONFIG };
}

export function writeDefaultRulesConfig(
  path: string | PolicyFilesystemTarget,
  rules: string[] = [],
): void {
  writeJsonAtomic(path, { version: 1, rules, overrides: {}, transparent_wrappers: [] });
}

export function writeStarterRulebook(
  path: string | PolicyFilesystemTarget,
  name = 'project-rules',
): void {
  writeJsonAtomic(path, {
    rulebook_version: 1,
    name,
    version: '1.0.0',
    description:
      name === 'project-rules'
        ? 'Project-specific CC Safety Net rules.'
        : 'User-specific CC Safety Net rules.',
    author: name === 'project-rules' ? 'project' : 'user',
    allowed_commands: ['docker'],
    rules: [
      {
        name: 'block-docker-system-prune',
        command: 'docker',
        subcommand: 'system',
        block_args: ['prune'],
        reason: 'Use targeted cleanup instead.',
      },
    ],
    tests: [
      {
        command: 'docker system prune',
        expect: 'blocked',
        rule: 'block-docker-system-prune',
      },
    ],
  });
}

/** @internal */
export function createAtomicTempPath(path: string): string {
  return `${path}.${randomBytes(8).toString('hex')}.tmp`;
}

export function writeJsonAtomic(
  path: string | PolicyFilesystemTarget,
  value: unknown,
  mode?: number,
  afterRename?: (path: string) => void,
): void {
  writePolicyFileAtomic(toTarget(path), `${JSON.stringify(value, null, 2)}\n`, mode, afterRename);
}

function toTarget(path: string | PolicyFilesystemTarget): PolicyFilesystemTarget {
  return typeof path === 'string' ? bindDelegatedPolicyFilesystemTarget(path) : path;
}

import { randomBytes } from 'node:crypto';
