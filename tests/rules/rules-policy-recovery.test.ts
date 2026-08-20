import { describe, expect, mock, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  addRulebookSource,
  getProjectRulesConfigPath,
  getProjectRulesDir,
  getRulebookDisplaySource,
  getRulesConfigRuntimeErrorsForConfig,
  getRulesConfigSourceDisplayMap,
  getRulesLockPathForConfigPath,
  getUserRulesConfigPath,
  getUserRulesDir,
  getUserRulesLockPath,
  loadRulesPolicy,
  readRulesConfig,
  removeRulebookSource,
  syncRulesConfig,
  writeDefaultRulesConfig,
  writeStarterRulebook,
} from '@/rules/policy';
import { createAtomicTempPath, validateRulesConfig } from '@/rules/policy/config-file';
import { readLockfile } from '@/rules/policy/lockfile';
import { getProjectRulesLockPath, getRulebookCachePath } from '@/rules/policy/paths';
import {
  discoverGitHubRepositoryRulebooks,
  resolveRulebookSource,
  resolveRulebookSourceForSync,
  sha256Digest,
} from '@/rules/policy/resolver';
import { getUnknownOverrideErrorsForConfig } from '@/rules/policy/scope-policy';
import {
  assertBareRulebookName,
  getRemoveMatches,
  getRulebookSourceSyntaxError,
  getSelectedUpdateSpecs,
  isGitHubRepositorySource,
  isGitHubRulebookSource,
  parseGitHubSource,
} from '@/rules/policy/sources';
import {
  addRulebookSourceWithHooks,
  removeRulebookSourceWithHooks,
  syncRulesConfigWithHooks,
} from '@/rules/policy/sync';
import type { LoadedRulesPolicy, RulebookLockEntry, RulesLockfile } from '@/rules/policy/types';
import { RULEBOOK_LIMIT_ERROR, RULEBOOK_LIMITS } from '@/rules/rulebook-limits';
import type { TestPolicyInput } from '../helpers/policy';
import { analyzeTestCommand as analyzeCommand } from '../helpers/policy';

type RemoveRulebookSourceTestOptions = NonNullable<Parameters<typeof removeRulebookSource>[1]> & {
  _testDeleteLocalSourceDir: (dir: string) => void;
};
type SyncRulesConfigTestOptions = NonNullable<Parameters<typeof syncRulesConfig>[0]> & {
  _testPruneRulebookCacheDir: (dir: string) => void;
};
type PolicyRenameFaultOptions = NonNullable<Parameters<typeof syncRulesConfig>[0]> & {
  _testAfterPolicyRename: (path: string) => void;
};

const CASE_INSENSITIVE_TEMP_FILESYSTEM = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-policy-case-probe-'));
  try {
    writeFileSync(join(dir, 'probe'), 'probe');
    return existsSync(join(dir, 'PROBE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

function loadedRulesTestPolicy(policy: LoadedRulesPolicy): TestPolicyInput {
  if (policy.errors.length === 0) {
    return { rules: policy.rules, transparent_wrappers: policy.transparent_wrappers };
  }
  const reason = policy.errors.join('; ');
  return {
    rules: [],
    transparent_wrappers: [],
    configFallbackReason: /[.!?]$/.test(reason) ? reason : `${reason}.`,
  };
}

function makeTempDir(name: string) {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function unknownOverrideWarning(key: string, configPath: string) {
  return `unknown override key "${key}" in ${configPath}; only that override is ignored and other overrides and rules keep their configured state; correct or remove it in that file`;
}

function writeRulebook(path: string, name = 'project-rules') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rulebookJson(name), 'utf-8');
}

function rulebookJson(name = 'project-rules') {
  return JSON.stringify({
    rulebook_version: 1,
    name,
    version: '1.0.0',
    allowed_commands: ['docker'],
    rules: [
      {
        name: 'block-docker-prune',
        command: 'docker',
        subcommand: 'system',
        block_args: ['prune'],
        reason: 'Use targeted cleanup.',
      },
    ],
    tests: [{ command: 'docker system prune', expect: 'blocked', rule: 'block-docker-prune' }],
  });
}

function overLimitRulebookJson(name = 'project-rules') {
  return JSON.stringify({
    rulebook_version: 1,
    name,
    version: '1.0.0',
    allowed_commands: ['echo'],
    rules: [
      {
        name: 'oversized',
        command: 'echo',
        block_args: Array(RULEBOOK_LIMITS.maxBlockArgsPerRule + 1).fill('TOPSECRET'),
        reason: 'TOPSECRET',
      },
    ],
    tests: [{ command: 'echo TOPSECRET', expect: 'blocked', rule: 'oversized' }],
  });
}

function writeProjectRulebook(tempDir: string, name = 'project-rules') {
  const path = join(getProjectRulesDir(tempDir), name, 'rulebook.json');
  mkdirSync(dirname(path), { recursive: true });
  writeRulebook(path, name);
  return path;
}

function writeProjectRulebookConfig(tempDir: string): void {
  writeProjectRulebook(tempDir);
  writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules']);
}

function writeProjectConfigOnly(tempDir: string): void {
  mkdirSync(getProjectRulesDir(tempDir), { recursive: true });
  writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules']);
}

async function prepareProjectRulesSnapshot(tempDir: string, userConfigDir: string) {
  const configPath = getProjectRulesConfigPath(tempDir);
  const lockPath = getProjectRulesLockPath(tempDir);
  writeProjectRulebookConfig(tempDir);
  expect((await syncRulesConfig({ cwd: tempDir, userConfigDir })).ok).toBe(true);
  return {
    configPath,
    lockPath,
    configBytes: readFileSync(configPath, 'utf-8'),
    lockBytes: readFileSync(lockPath, 'utf-8'),
  };
}

function expectPolicySnapshotRestored(
  result: { ok: boolean; errors: string[] },
  snapshot: Awaited<ReturnType<typeof prepareProjectRulesSnapshot>>,
  tempDir: string,
  userConfigDir: string,
) {
  expect(result.ok).toBe(false);
  expect(result.errors).toEqual(['Unable to access project policy filesystem safely.']);
  expect(readFileSync(snapshot.configPath, 'utf-8')).toBe(snapshot.configBytes);
  expect(readFileSync(snapshot.lockPath, 'utf-8')).toBe(snapshot.lockBytes);
  expect(loadRulesPolicy({ cwd: tempDir, userConfigDir }).errors).toEqual([]);
}

async function writeAndSyncUserRulebook(tempDir: string, userConfigDir: string) {
  writeRulebook(join(userConfigDir, 'user-rules', 'rulebook.json'), 'user-rules');
  writeDefaultRulesConfig(getUserRulesConfigPath({ userConfigDir }), ['user-rules']);
  expect((await syncRulesConfig({ cwd: tempDir, userConfigDir, global: true })).ok).toBe(true);
}

async function syncAndLoadRulesPolicy(tempDir: string, userConfigDir: string) {
  expect((await syncRulesConfig({ cwd: tempDir, userConfigDir })).ok).toBe(true);
  const policy = loadRulesPolicy({ cwd: tempDir, userConfigDir });
  expect(policy.errors).toEqual([]);
  return policy;
}

async function expectProjectRulesDeleteSourceRemoved(tempDir: string): Promise<void> {
  const removed = await removeRulebookSource('project-rules', {
    cwd: tempDir,
    deleteSource: true,
  });

  expect(removed.ok).toBe(true);
  expect(readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.rules).toEqual([]);
  expect(existsSync(join(getProjectRulesDir(tempDir), 'project-rules'))).toBe(false);
}

async function expectProjectRulesDeleteSourcePreflightError(
  name: string,
  setup: (tempDir: string) => void,
  message: string,
): Promise<void> {
  const tempDir = makeTempDir(name);
  try {
    setup(tempDir);
    const result = await removeRulebookSource('project-rules', {
      cwd: tempDir,
      deleteSource: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(message);
    expect(readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.rules).toEqual([
      'project-rules',
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function mockGitHubRepoRulebooksFetch(
  rulebooks: Record<string, string>,
  extraTreeEntries: Array<{ path: string; type: 'blob' }> = [],
): typeof fetch {
  const rawPrefix = 'https://raw.githubusercontent.com/owner/repo/abc123/.cc-safety-net/rules/';
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    switch (url) {
      case 'https://api.github.com/repos/owner/repo':
        return new Response(JSON.stringify({ default_branch: 'main' }));
      case 'https://api.github.com/repos/owner/repo/commits/main':
      case 'https://api.github.com/repos/owner/repo/commits/abc123':
        return new Response(JSON.stringify({ sha: 'abc123' }));
    }
    if (url === 'https://api.github.com/repos/owner/repo/git/trees/abc123?recursive=1') {
      return new Response(
        JSON.stringify({
          tree: [
            ...extraTreeEntries,
            ...Object.keys(rulebooks).map((name) => ({
              path: `.cc-safety-net/rules/${name}/rulebook.json`,
              type: 'blob',
            })),
          ],
        }),
      );
    }
    if (url.startsWith(rawPrefix) && url.endsWith('/rulebook.json')) {
      const name = url.slice(rawPrefix.length).split('/')[0];
      if (name && rulebooks[name]) return new Response(rulebooks[name]);
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('rules policy recovery coverage', () => {
  test('direct sync APIs reject linked project parents without escaping writes', async () => {
    const tempDir = makeTempDir('rules-policy-linked-parent-write');
    const outside = makeTempDir('rules-policy-linked-parent-outside');
    const sentinel = join(outside, 'sentinel');
    try {
      mkdirSync(join(outside, 'rules', 'project-rules'), { recursive: true });
      writeRulebook(join(outside, 'rules', 'project-rules', 'rulebook.json'));
      writeFileSync(sentinel, 'TOPSECRET', 'utf-8');
      symlinkSync(outside, join(tempDir, '.cc-safety-net'), 'dir');

      const added = await addRulebookSource('project-rules', {
        cwd: tempDir,
        userConfigDir: join(tempDir, 'user', 'rules'),
      });

      expect(added).toEqual({
        ok: false,
        errors: ['Unable to access project policy filesystem safely.'],
        warnings: [],
        entries: [],
      });
      expect(readFileSync(sentinel, 'utf-8')).toBe('TOPSECRET');
      expect(existsSync(join(outside, 'rules', 'rule.json'))).toBe(false);
      expect(existsSync(join(outside, 'rules', 'rule.lock'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('first-time add removes its new config when source resolution fails', async () => {
    const tempDir = makeTempDir('rules-policy-first-add-rollback');
    const configPath = getProjectRulesConfigPath(tempDir);
    try {
      mkdirSync(join(getProjectRulesDir(tempDir), 'broken'), { recursive: true });
      writeFileSync(
        join(getProjectRulesDir(tempDir), 'broken', 'rulebook.json'),
        'TOPSECRET invalid rulebook',
      );

      const result = await addRulebookSource('broken', {
        cwd: tempDir,
        userConfigDir: join(tempDir, 'user', 'rules'),
      });

      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('TOPSECRET');
      expect(existsSync(configPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('sync rejects linked lock and cache targets without changing sentinels', async () => {
    const tempDir = makeTempDir('rules-policy-linked-sync-write');
    const userConfigDir = join(tempDir, 'user', 'rules');
    const outsideLock = join(tempDir, 'TOPSECRET-lock');
    const outsideCache = makeTempDir('rules-policy-linked-cache-outside');
    try {
      writeProjectRulebookConfig(tempDir);
      writeFileSync(outsideLock, 'TOPSECRET lock sentinel', 'utf-8');
      symlinkSync(outsideLock, getProjectRulesLockPath(tempDir));

      const linkedLock = await syncRulesConfig({ cwd: tempDir, userConfigDir });
      expect(linkedLock.ok).toBe(false);
      expect(linkedLock.errors).toEqual(['Unable to access project policy filesystem safely.']);
      expect(readFileSync(outsideLock, 'utf-8')).toBe('TOPSECRET lock sentinel');

      rmSync(getProjectRulesLockPath(tempDir));
      rmSync(join(tempDir, '.cc-safety-net', 'cache'), { recursive: true, force: true });
      mkdirSync(join(tempDir, '.cc-safety-net'), { recursive: true });
      writeFileSync(join(outsideCache, 'sentinel'), 'TOPSECRET cache sentinel', 'utf-8');
      symlinkSync(outsideCache, join(tempDir, '.cc-safety-net', 'cache'), 'dir');

      const linkedCache = await syncRulesConfig({ cwd: tempDir, userConfigDir });
      expect(linkedCache.ok).toBe(false);
      expect(linkedCache.errors).toEqual(['Unable to access project policy filesystem safely.']);
      expect(readFileSync(join(outsideCache, 'sentinel'), 'utf-8')).toBe(
        'TOPSECRET cache sentinel',
      );
      expect(readdirSync(outsideCache)).toEqual(['sentinel']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideCache, { recursive: true, force: true });
    }
  });

  test('sync rejects linked local sources and linked cache children with fixed failures', async () => {
    const tempDir = makeTempDir('rules-policy-linked-source-sync');
    const userConfigDir = join(tempDir, 'user', 'rules');
    const outside = join(tempDir, 'TOPSECRET-source');
    try {
      writeProjectConfigOnly(tempDir);
      writeFileSync(outside, 'TOPSECRET unexpected parser payload', 'utf-8');
      mkdirSync(join(getProjectRulesDir(tempDir), 'project-rules'));
      symlinkSync(outside, join(getProjectRulesDir(tempDir), 'project-rules', 'rulebook.json'));

      const linkedSource = await syncRulesConfig({ cwd: tempDir, userConfigDir });
      expect(linkedSource.ok).toBe(false);
      expect(linkedSource.errors).toEqual(['Unable to access project policy filesystem safely.']);
      expect(JSON.stringify(linkedSource)).not.toContain('TOPSECRET');

      rmSync(getProjectRulesDir(tempDir), { recursive: true, force: true });
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir));
      const stale = join(tempDir, '.cc-safety-net', 'cache', 'rulebooks', 'stale');
      mkdirSync(stale, { recursive: true });
      symlinkSync(outside, join(stale, 'linked'));

      const linkedCacheChild = await syncRulesConfig({ cwd: tempDir, userConfigDir });
      expect(linkedCacheChild.ok).toBe(false);
      expect(linkedCacheChild.errors).toEqual([
        'Unable to access project policy filesystem safely.',
      ]);
      expect(existsSync(getProjectRulesLockPath(tempDir))).toBe(false);
      expect(existsSync(join(stale, 'linked'))).toBe(true);
      expect(readFileSync(outside, 'utf-8')).toBe('TOPSECRET unexpected parser payload');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('remove restores exact config and lock bytes when cache pruning fails after publication', async () => {
    const tempDir = makeTempDir('rules-policy-remove-lock-rollback');
    const userConfigDir = join(tempDir, 'user', 'rules');
    const outside = makeTempDir('rules-policy-remove-lock-rollback-outside');
    try {
      const snapshot = await prepareProjectRulesSnapshot(tempDir, userConfigDir);
      const stale = join(tempDir, '.cc-safety-net', 'cache', 'rulebooks', 'stale');
      mkdirSync(stale, { recursive: true });
      writeFileSync(join(outside, 'sentinel'), 'TOPSECRET');
      symlinkSync(outside, join(stale, 'linked'), 'dir');

      const result = await removeRulebookSource('project-rules', {
        cwd: tempDir,
        userConfigDir,
      });

      expectPolicySnapshotRestored(result, snapshot, tempDir, userConfigDir);
      expect(readFileSync(join(outside, 'sentinel'), 'utf-8')).toBe('TOPSECRET');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('post-rename lock failure restores exact prior lock bytes', async () => {
    const tempDir = makeTempDir('rules-policy-lock-post-rename');
    const userConfigDir = join(tempDir, 'user', 'rules');
    try {
      const snapshot = await prepareProjectRulesSnapshot(tempDir, userConfigDir);
      writeRulebook(join(getProjectRulesDir(tempDir), 'project-rules', 'rulebook.json'));
      const options = {
        cwd: tempDir,
        userConfigDir,
        _testAfterPolicyRename: (path: string) => {
          if (path === snapshot.lockPath) throw new Error('post-rename lock fault');
        },
      } satisfies PolicyRenameFaultOptions;

      const result = await syncRulesConfigWithHooks(options, options);

      expectPolicySnapshotRestored(result, snapshot, tempDir, userConfigDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('post-rename add and remove config failures restore their exact snapshots', async () => {
    const tempDir = makeTempDir('rules-policy-config-post-rename');
    const userConfigDir = join(tempDir, 'user', 'rules');
    const configPath = getProjectRulesConfigPath(tempDir);
    const lockPath = getProjectRulesLockPath(tempDir);
    try {
      writeProjectRulebook(tempDir);
      const fault = {
        cwd: tempDir,
        userConfigDir,
        _testAfterPolicyRename: (path: string) => {
          if (path === configPath) throw new Error('post-rename config fault');
        },
      } satisfies PolicyRenameFaultOptions;

      const add = await addRulebookSourceWithHooks('project-rules', fault, fault);
      expect(add.ok).toBe(false);
      expect(add.errors).toEqual(['Unable to access project policy filesystem safely.']);
      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(false);

      const snapshot = await prepareProjectRulesSnapshot(tempDir, userConfigDir);

      const remove = await removeRulebookSourceWithHooks('project-rules', fault, fault);
      expectPolicySnapshotRestored(remove, snapshot, tempDir, userConfigDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the new config and lock active when stale cache removal partially fails',
    async () => {
      const tempDir = makeTempDir('rules-policy-partial-prune');
      const userConfigDir = join(tempDir, 'user', 'rules');
      const stale = join(tempDir, '.cc-safety-net', 'cache', 'rulebooks', 'stale');
      try {
        writeProjectRulebookConfig(tempDir);
        expect((await syncRulesConfig({ cwd: tempDir, userConfigDir })).ok).toBe(true);
        mkdirSync(join(stale, 'child'), { recursive: true });
        writeFileSync(join(stale, 'child', 'entry'), 'stale');
        chmodSync(stale, 0o500);

        const result = await removeRulebookSource('project-rules', {
          cwd: tempDir,
          userConfigDir,
        });

        expect(result.ok).toBe(true);
        expect(result.warnings).toEqual(['Unable to prune rules policy cache safely.']);
        expect(readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.rules).toEqual([]);
        expect(readLockfile(getProjectRulesLockPath(tempDir)).lock?.rulebooks).toEqual([]);
        expect(loadRulesPolicy({ cwd: tempDir, userConfigDir }).errors).toEqual([]);
      } finally {
        chmodSync(stale, 0o700);
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CASE_INSENSITIVE_TEMP_FILESYSTEM)(
    'keeps an active cache whose directory spelling differs only by case',
    async () => {
      const tempDir = makeTempDir('rules-policy-cache-case');
      const userConfigDir = join(tempDir, 'user', 'rules');
      try {
        writeProjectRulebookConfig(tempDir);
        expect((await syncRulesConfig({ cwd: tempDir, userConfigDir })).ok).toBe(true);
        const entry = readLockfile(getProjectRulesLockPath(tempDir)).lock?.rulebooks[0];
        if (!entry) throw new Error('missing lock entry');
        const cacheDir = dirname(
          getRulebookCachePath(entry, { cacheConfigDir: getProjectRulesDir(tempDir) }),
        );
        const caseVariant = join(dirname(cacheDir), basename(cacheDir).toUpperCase());
        const intermediate = `${cacheDir}-rename`;
        renameSync(cacheDir, intermediate);
        renameSync(intermediate, caseVariant);

        const result = await syncRulesConfig({ cwd: tempDir, userConfigDir });

        expect(result.ok).toBe(true);
        expect(existsSync(caseVariant)).toBe(true);
        expect(loadRulesPolicy({ cwd: tempDir, userConfigDir }).errors).toEqual([]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  test('global sync uses the user filesystem capability and attribution', async () => {
    const tempDir = makeTempDir('rules-policy-global-check-scope');
    const userConfigDir = join(tempDir, 'user', 'rules');
    const outside = join(tempDir, 'TOPSECRET-user-rulebook');
    try {
      await writeAndSyncUserRulebook(tempDir, userConfigDir);
      expect(
        (await syncRulesConfig({ cwd: tempDir, userConfigDir, global: true, check: true })).ok,
      ).toBe(true);
      writeFileSync(outside, 'TOPSECRET');
      rmSync(join(userConfigDir, 'user-rules', 'rulebook.json'));
      symlinkSync(outside, join(userConfigDir, 'user-rules', 'rulebook.json'));

      const linked = await syncRulesConfig({ cwd: tempDir, userConfigDir, global: true });
      expect(linked.ok).toBe(false);
      expect(linked.errors).toEqual(['Unable to access user policy filesystem safely.']);
      expect(JSON.stringify(linked)).not.toContain('TOPSECRET');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test('validates and reads rules config files', () => {
    const tempDir = makeTempDir('rules-policy-config');
    const configPath = join(tempDir, 'rule.json');

    try {
      expect(validateRulesConfig(null).errors).toEqual(['Config must be an object']);
      expect(
        validateRulesConfig({
          version: 2,
          rules: ['bad source!', '', 'project-rules', 'project-rules'],
          overrides: {
            missing: {},
            'project-rules/block-docker-prune': { reason: '' },
            'project-rules/bad-intent': { reason: 'No.', intent: 'retry_forever' },
            'project-rules/off-rule': 'off',
          },
        }).errors,
      ).toEqual(
        expect.arrayContaining([
          'version must be 1',
          'rules[0]: Local rulebook sources must be bare names matching /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/: bad source!',
          'rules[1]: must be a non-empty rulebook source string',
          'rules[3]: duplicate rulebook source "project-rules"',
          'overrides.missing: must use <rulebook-name>/<rule-name>',
          'overrides.project-rules/block-docker-prune.reason: required non-empty string',
          'overrides.project-rules/bad-intent.intent: must be one of hard_stop, use_alternative, scope_down, manual_only, stop_and_explain',
        ]),
      );

      writeFileSync(configPath, '', 'utf-8');
      expect(readRulesConfig(configPath).errors).toEqual(['Config file is empty']);
      writeFileSync(configPath, '{bad json', 'utf-8');
      expect(readRulesConfig(configPath).errors[0]).toContain('Invalid JSON');
      writeDefaultRulesConfig(configPath, ['project-rules']);
      expect(readRulesConfig(configPath).config?.rules).toEqual(['project-rules']);
      writeStarterRulebook(join(tempDir, 'starter.json'), 'user-rules');
      expect(readFileSync(join(tempDir, 'starter.json'), 'utf-8')).toContain('User-specific');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // A plugin install with no node_modules cannot load the schema's zod dependency, and that
  // failure landed on the same catch as a parse error — reporting a valid file as Invalid JSON.
  test('a schema failure on valid JSON reports its own message', async () => {
    const tempDir = makeTempDir('rules-policy-config-schema-failure');
    const configPath = join(tempDir, 'rule.json');
    const schema = await import('@/policy/schema');
    const getRulesConfigValidation = schema.getRulesConfigValidation;

    try {
      writeDefaultRulesConfig(configPath, ['project-rules']);
      mock.module('@/policy/schema', () => ({
        ...schema,
        getRulesConfigValidation: () => {
          throw new Error("Cannot find module 'zod'");
        },
      }));

      expect(readRulesConfig(configPath)).toEqual({
        config: null,
        errors: ["Cannot find module 'zod'"],
      });
    } finally {
      mock.module('@/policy/schema', () => ({ ...schema, getRulesConfigValidation }));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('atomic config temp paths use unpredictable filenames', () => {
    const tempDir = makeTempDir('rules-policy-atomic-temp');
    const configPath = join(tempDir, 'rule.json');

    try {
      const tempPaths = Array.from({ length: 4 }, () => createAtomicTempPath(configPath));

      expect(new Set(tempPaths).size).toBe(tempPaths.length);
      for (const tempPath of tempPaths) {
        expect(tempPath.startsWith(`${configPath}.`)).toBe(true);
        expect(tempPath.endsWith('.tmp')).toBe(true);
        expect(tempPath).not.toContain(`.${process.pid}.`);
        expect(tempPath).not.toMatch(/\.\d{13}\.tmp$/);
      }

      writeDefaultRulesConfig(configPath, ['project-rules']);
      expect(readRulesConfig(configPath).config?.rules).toEqual(['project-rules']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('parses lockfiles, paths, source syntax, and match helpers', () => {
    const tempDir = makeTempDir('rules-policy-lock');
    const lockPath = join(tempDir, 'rule.lock');
    const githubEntry = {
      spec: 'owner/repo#main/project-rules',
      kind: 'github' as const,
      owner: 'owner',
      repo: 'repo',
      ref: 'main',
      commit: 'abc123',
      path: '.cc-safety-net/rules/project-rules/rulebook.json',
      name: 'project-rules',
      version: '1.0.0',
      digest: 'sha256:'.padEnd(71, 'a'),
      display_ref: 'feature',
    };

    try {
      expect(readLockfile(lockPath)).toEqual({ lock: null, errors: [] });
      writeFileSync(lockPath, '[]', 'utf-8');
      expect(readLockfile(lockPath).errors[0]).toContain('malformed lockfile');
      writeFileSync(lockPath, JSON.stringify({ version: 1, rulebooks: [{ kind: 'bad' }] }));
      expect(readLockfile(lockPath).errors).toContain(
        `${lockPath}: rulebooks[0].kind: unknown kind "bad"`,
      );
      writeFileSync(
        lockPath,
        JSON.stringify({
          version: 1,
          rulebooks: [{ ...githubEntry, spec: ' ', name: ' ', path: ' ' }],
        }),
      );
      expect(readLockfile(lockPath).errors).toEqual(
        expect.arrayContaining([
          `${lockPath}: rulebooks[0].spec: required string`,
          `${lockPath}: rulebooks[0].name: required string`,
          `${lockPath}: rulebooks[0].path: required string`,
        ]),
      );
      writeFileSync(lockPath, JSON.stringify({ version: 1, rulebooks: [githubEntry] }));
      expect(readLockfile(lockPath).lock?.rulebooks[0]).toEqual(githubEntry);
      expect(getRulebookDisplaySource(githubEntry)).toBe('owner/repo#feature/project-rules');
      expect(getRulebookCachePath(githubEntry, { cacheConfigDir: tempDir })).toContain(
        'owner-repo-feature-project-rules',
      );
      expect(getProjectRulesDir(tempDir)).toBe(join(tempDir, '.cc-safety-net', 'rules'));
      expect(
        getRulebookCachePath(githubEntry, { cacheConfigDir: getProjectRulesDir(tempDir) }),
      ).toContain(join(tempDir, '.cc-safety-net', 'cache', 'rulebooks'));

      expect(getRulebookSourceSyntaxError('bad:source')).toContain('Local rulebook sources');
      expect(getRulebookSourceSyntaxError('project-rules')).toBeNull();
      expect(getRulebookSourceSyntaxError('owner/repo#bad@/name')).toContain(
        'refs must be a single path segment',
      );
      expect(getRulebookSourceSyntaxError('owner/repo#main/bad/name')).toContain(
        'GitHub rulebook sources must be',
      );
      expect(isGitHubRepositorySource('owner/repo')).toBe(true);
      expect(isGitHubRulebookSource('owner/repo#main/project-rules')).toBe(true);
      expect(() => assertBareRulebookName('bad source!')).toThrow('Local rulebook sources');
      expect(parseGitHubSource('owner/repo#main/project-rules')).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        path: '.cc-safety-net/rules/project-rules/rulebook.json',
        name: 'project-rules',
      });
      expect(() => parseGitHubSource('github:owner/repo#main/project-rules')).toThrow();

      const lock: RulesLockfile = {
        version: 1,
        rulebooks: [
          {
            spec: 'one',
            kind: 'local-directory',
            path: 'one',
            name: 'shared',
            version: '1',
            digest: githubEntry.digest,
          },
          {
            spec: 'two',
            kind: 'local-directory',
            path: 'two',
            name: 'shared',
            version: '1',
            digest: githubEntry.digest,
          },
        ],
      };
      expect(
        getSelectedUpdateSpecs(
          { version: 1, rules: ['one'], overrides: {}, transparent_wrappers: [] },
          null,
          'one',
        ),
      ).toEqual({
        ok: true,
        specs: ['one'],
      });
      expect(
        getSelectedUpdateSpecs(
          { version: 1, rules: ['one'], overrides: {}, transparent_wrappers: [] },
          null,
          'missing',
        ),
      ).toEqual(expect.objectContaining({ ok: false }));
      expect(getRemoveMatches(['one', 'two'], lock, 'shared')).toEqual(
        expect.objectContaining({ ok: false }),
      );
      expect(getRemoveMatches(['owner/repo#main/alpha'], null, 'owner/repo#main')).toEqual({
        ok: true,
        specs: ['owner/repo#main/alpha'],
      });
      expect(getRemoveMatches(['owner/repo#main/alpha'], null, 'owner/repo')).toEqual({
        ok: true,
        specs: ['owner/repo#main/alpha'],
      });
      expect(
        getRemoveMatches(['owner/repo#main/alpha', 'owner/repo#dev/beta'], null, 'owner/repo'),
      ).toEqual(expect.objectContaining({ ok: false }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('syncs, loads, repairs, checks, and removes local rulebooks', async () => {
    const tempDir = makeTempDir('rules-policy-sync');
    const userConfigDir = join(tempDir, 'user');

    try {
      writeProjectRulebook(tempDir);
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules']);

      const synced = await syncRulesConfig({ cwd: tempDir, userConfigDir });
      expect(synced.ok).toBe(true);
      expect(synced.entries[0]?.ruleCount).toBe(1);
      expect(existsSync(getProjectRulesLockPath(tempDir))).toBe(true);

      const policy = loadRulesPolicy({ cwd: tempDir, userConfigDir });
      expect(policy.errors).toEqual([]);
      expect(policy.rules[0]?.name).toBe('project-rules/block-docker-prune');
      expect(loadedRulesTestPolicy(policy).rules).toHaveLength(1);
      expect(getRulesConfigSourceDisplayMap(getProjectRulesConfigPath(tempDir))).toEqual(
        new Map([['project-rules', 'project-rules']]),
      );

      writeFileSync(
        getProjectRulesConfigPath(tempDir),
        JSON.stringify({
          version: 1,
          rules: ['project-rules'],
          overrides: { 'project-rules/missing': 'off' },
          transparent_wrappers: ['rtk'],
        }),
      );
      expect(
        getUnknownOverrideErrorsForConfig(
          getProjectRulesConfigPath(tempDir),
          getProjectRulesLockPath(tempDir),
          {
            userConfigDir,
          },
        ),
      ).toEqual([
        unknownOverrideWarning('project-rules/missing', getProjectRulesConfigPath(tempDir)),
      ]);

      const cachePath = getRulebookCachePath(synced.entries[0] as RulebookLockEntry, {
        cacheConfigDir: getProjectRulesDir(tempDir),
        userConfigDir,
      });
      rmSync(cachePath, { force: true });
      expect((await syncRulesConfig({ cwd: tempDir, userConfigDir, check: true })).ok).toBe(false);
      expect(
        getRulesConfigRuntimeErrorsForConfig(
          getProjectRulesConfigPath(tempDir),
          getProjectRulesLockPath(tempDir),
          {
            userConfigDir,
          },
        )[0],
      ).toContain('missing cache entry');

      // Restoring the cache is not enough to report success: the stale override
      // above still degrades the runtime, so sync reports what remains.
      const rebuilt = await syncRulesConfig({ cwd: tempDir, userConfigDir });
      expect(rebuilt.ok).toBe(false);
      expect(rebuilt.errors).toEqual([
        unknownOverrideWarning('project-rules/missing', getProjectRulesConfigPath(tempDir)),
      ]);

      writeFileSync(
        getProjectRulesConfigPath(tempDir),
        JSON.stringify({
          version: 1,
          rules: ['project-rules'],
          overrides: {},
          transparent_wrappers: ['rtk'],
        }),
      );
      expect((await syncRulesConfig({ cwd: tempDir, userConfigDir })).ok).toBe(true);
      expect(
        (await removeRulebookSource('project-rules', { cwd: tempDir, userConfigDir })).ok,
      ).toBe(true);
      expect(readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.rules).toEqual([]);
      expect(
        readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.transparent_wrappers,
      ).toEqual(['rtk']);

      mkdirSync(join(userConfigDir, 'user-rules'), { recursive: true });
      writeRulebook(join(userConfigDir, 'user-rules', 'rulebook.json'), 'user-rules');
      expect(
        (await addRulebookSource('user-rules', { global: true, cwd: tempDir, userConfigDir })).ok,
      ).toBe(true);
      expect(getUserRulesDir({ userConfigDir })).toBe(userConfigDir);
      expect(getUserRulesConfigPath({ userConfigDir })).toBe(join(userConfigDir, 'rule.json'));
      expect(getUserRulesLockPath({ userConfigDir })).toBe(join(userConfigDir, 'rule.lock'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('syncs nonstandard user and project config filenames', async () => {
    const tempDir = makeTempDir('rules-policy-custom-config-paths');
    const userConfigPath = join(tempDir, 'user-rules.custom.json');
    const projectConfigPath = join(tempDir, 'project-rules.custom.json');

    try {
      writeRulebook(join(dirname(userConfigPath), 'user-rules', 'rulebook.json'), 'user-rules');
      writeDefaultRulesConfig(userConfigPath, ['user-rules']);
      writeRulebook(join(dirname(projectConfigPath), 'project-rules', 'rulebook.json'));
      writeDefaultRulesConfig(projectConfigPath, ['project-rules']);

      const userSynced = await syncRulesConfig({ global: true, cwd: tempDir, userConfigPath });
      const projectSynced = await syncRulesConfig({ cwd: tempDir, projectConfigPath });

      expect(userSynced.ok).toBe(true);
      expect(userSynced.entries.map((entry) => entry.name)).toEqual(['user-rules']);
      expect(projectSynced.ok).toBe(true);
      expect(projectSynced.entries.map((entry) => entry.name)).toEqual(['project-rules']);
      expect(
        readLockfile(getRulesLockPathForConfigPath(userConfigPath)).lock?.rulebooks,
      ).toHaveLength(1);
      expect(
        readLockfile(getRulesLockPathForConfigPath(projectConfigPath)).lock?.rulebooks,
      ).toHaveLength(1);
      expect(existsSync(getUserRulesConfigPath({ userConfigPath }))).toBe(false);
      expect(existsSync(getProjectRulesConfigPath(tempDir))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('same-scope rule overrides still disable matching rules', async () => {
    const tempDir = makeTempDir('rules-policy-same-scope-overrides');
    const userConfigDir = join(tempDir, 'user');

    try {
      writeRulebook(join(userConfigDir, 'user-rules', 'rulebook.json'), 'user-rules');
      writeFileSync(
        getUserRulesConfigPath({ userConfigDir }),
        JSON.stringify({
          version: 1,
          rules: ['user-rules'],
          overrides: { 'user-rules/block-docker-prune': 'off' },
        }),
        'utf-8',
      );
      expect((await syncRulesConfig({ cwd: tempDir, userConfigDir, global: true })).ok).toBe(true);

      writeProjectRulebook(tempDir);
      writeFileSync(
        getProjectRulesConfigPath(tempDir),
        JSON.stringify({
          version: 1,
          rules: ['project-rules'],
          overrides: { 'project-rules/block-docker-prune': 'off' },
        }),
        'utf-8',
      );
      const policy = await syncAndLoadRulesPolicy(tempDir, userConfigDir);
      expect(policy.rules.map((rule) => rule.name)).toEqual([]);
      expect(
        analyzeCommand('docker system prune', {
          cwd: tempDir,
          config: loadedRulesTestPolicy(policy),
        }),
      ).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('keeps sibling rulebooks active while one local source drifts', async () => {
    const tempDir = makeTempDir('rules-policy-drift-containment');
    const userConfigDir = join(tempDir, 'user');

    try {
      const rulesDir = getProjectRulesDir(tempDir);
      writeRulebook(join(rulesDir, 'project-rules', 'rulebook.json'));
      writeRulebook(join(rulesDir, 'other-rules', 'rulebook.json'), 'other-rules');
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules', 'other-rules']);
      expect((await syncRulesConfig({ cwd: tempDir, userConfigDir })).ok).toBe(true);

      writeFileSync(
        join(rulesDir, 'project-rules', 'rulebook.json'),
        rulebookJson().replace('Use targeted cleanup.', 'Pending local edit.'),
        'utf-8',
      );

      const policy = loadRulesPolicy({ cwd: tempDir, userConfigDir });

      expect(policy.errors).toEqual([]);
      expect(policy.warnings).toEqual([]);
      expect(policy.rules.map((rule) => rule.name)).toEqual([
        'project-rules/block-docker-prune',
        'other-rules/block-docker-prune',
      ]);
      // The pending local edit is not active: the digest-verified cache answers.
      expect(
        analyzeCommand('docker system prune', {
          cwd: tempDir,
          config: loadedRulesTestPolicy(policy),
        })?.reason,
      ).toBe('[project-rules/block-docker-prune] Use targeted cleanup.');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects lock entries that rebind configured source identity', () => {
    const tempDir = makeTempDir('rules-policy-lock-identity');
    const userConfigDir = join(tempDir, 'user');

    try {
      const localContent = rulebookJson('other-rules');
      const localEntry = {
        spec: 'project-rules',
        kind: 'local-directory' as const,
        path: 'other-rules',
        name: 'other-rules',
        version: '1.0.0',
        digest: sha256Digest(localContent),
      };
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules']);
      writeRulebook(
        join(getProjectRulesDir(tempDir), 'other-rules', 'rulebook.json'),
        'other-rules',
      );
      mkdirSync(
        dirname(
          getRulebookCachePath(localEntry, {
            cacheConfigDir: getProjectRulesDir(tempDir),
            userConfigDir,
          }),
        ),
        { recursive: true },
      );
      writeFileSync(
        getRulebookCachePath(localEntry, {
          cacheConfigDir: getProjectRulesDir(tempDir),
          userConfigDir,
        }),
        localContent,
        'utf-8',
      );
      writeFileSync(
        getProjectRulesLockPath(tempDir),
        JSON.stringify({ version: 1, rulebooks: [localEntry] }),
      );

      const localPolicy = loadRulesPolicy({ cwd: tempDir, userConfigDir });

      expect(localPolicy.rules).toEqual([]);
      expect(localPolicy.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('does not match local source identity')]),
      );

      const githubContent = rulebookJson('beta');
      const githubEntry = {
        spec: 'owner/repo#main/alpha',
        kind: 'github' as const,
        owner: 'attacker',
        repo: 'repo',
        ref: 'main',
        commit: 'abc123',
        path: '.cc-safety-net/rules/beta/rulebook.json',
        name: 'beta',
        version: '1.0.0',
        digest: sha256Digest(githubContent),
      };
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['owner/repo#main/alpha']);
      mkdirSync(
        dirname(
          getRulebookCachePath(githubEntry, {
            cacheConfigDir: getProjectRulesDir(tempDir),
            userConfigDir,
          }),
        ),
        { recursive: true },
      );
      writeFileSync(
        getRulebookCachePath(githubEntry, {
          cacheConfigDir: getProjectRulesDir(tempDir),
          userConfigDir,
        }),
        githubContent,
        'utf-8',
      );
      writeFileSync(
        getProjectRulesLockPath(tempDir),
        JSON.stringify({ version: 1, rulebooks: [githubEntry] }),
      );

      const githubPolicy = loadRulesPolicy({ cwd: tempDir, userConfigDir });

      expect(githubPolicy.rules).toEqual([]);
      expect(githubPolicy.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('does not match GitHub source identity')]),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('cross-scope user override cannot disable project-scoped rule ids', async () => {
    const tempDir = makeTempDir('rules-policy-user-cross-scope-override');
    const userConfigDir = join(tempDir, 'user');

    try {
      mkdirSync(userConfigDir, { recursive: true });
      writeFileSync(
        getUserRulesConfigPath({ userConfigDir }),
        JSON.stringify({
          version: 1,
          rules: [],
          overrides: { 'project-rules/block-docker-prune': 'off' },
        }),
        'utf-8',
      );

      writeProjectRulebook(tempDir);
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules']);
      expect((await syncRulesConfig({ cwd: tempDir, userConfigDir })).ok).toBe(true);

      const policy = loadRulesPolicy({ cwd: tempDir, userConfigDir });
      const config = loadedRulesTestPolicy(policy);

      expect(policy.rules.map((rule) => rule.name)).toEqual(['project-rules/block-docker-prune']);
      expect(policy.errors).toEqual([]);
      expect(policy.warnings).toContain(
        unknownOverrideWarning(
          'project-rules/block-docker-prune',
          getUserRulesConfigPath({ userConfigDir }),
        ),
      );
      expect(config.configFallbackReason).toBeUndefined();
      // Only the unknown override is ignored; the rule it failed to reach stays
      // loaded and keeps blocking.
      expect(
        analyzeCommand('docker system prune', {
          cwd: tempDir,
          config,
        })?.reason,
      ).toBe('[project-rules/block-docker-prune] Use targeted cleanup.');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('project overrides cannot disable user-scoped rule ids', async () => {
    const tempDir = makeTempDir('rules-policy-cross-scope-override');
    const userConfigDir = join(tempDir, 'user');

    try {
      await writeAndSyncUserRulebook(tempDir, userConfigDir);

      const userOnlyConfig = loadedRulesTestPolicy(
        loadRulesPolicy({ cwd: tempDir, userConfigDir }),
      );
      expect(
        analyzeCommand('docker system prune', {
          cwd: tempDir,
          config: userOnlyConfig,
        })?.reason,
      ).toContain('[user-rules/block-docker-prune] Use targeted cleanup.');

      writeProjectRulebook(tempDir);
      writeFileSync(
        getProjectRulesConfigPath(tempDir),
        JSON.stringify({
          version: 1,
          rules: ['project-rules'],
          overrides: { 'user-rules/block-docker-prune': 'off' },
        }),
        'utf-8',
      );
      // The project config names no rule it owns, so sync reports the override as
      // unknown for that scope exactly as `rule verify` and `doctor` do.
      const synced = await syncRulesConfig({ cwd: tempDir, userConfigDir });
      expect(synced.ok).toBe(false);
      expect(synced.errors).toEqual([
        unknownOverrideWarning('user-rules/block-docker-prune', getProjectRulesConfigPath(tempDir)),
      ]);

      const policy = loadRulesPolicy({ cwd: tempDir, userConfigDir });
      const config = loadedRulesTestPolicy(policy);

      expect(policy.rules.map((rule) => rule.name)).toEqual([
        'user-rules/block-docker-prune',
        'project-rules/block-docker-prune',
      ]);
      expect(policy.errors).toEqual([]);
      expect(policy.warnings).toContain(
        `project override cannot target user-scoped rule "user-rules/block-docker-prune" in ${getProjectRulesConfigPath(tempDir)}; only that override is ignored and the rule keeps its user-configured state; remove it from that file`,
      );
      expect(config.configFallbackReason).toBeUndefined();
      expect(analyzeCommand('echo ok', { cwd: tempDir, config })).toBeNull();
      // User policy stays authoritative: the project override never reaches the
      // user-scoped rule, which keeps blocking.
      expect(
        analyzeCommand('docker system prune', {
          cwd: tempDir,
          config,
        })?.reason,
      ).toBe('[user-rules/block-docker-prune] Use targeted cleanup.');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('removes clean local rulebook source directory when requested', async () => {
    const tempDir = makeTempDir('rules-policy-remove-delete-source');

    try {
      writeProjectRulebookConfig(tempDir);
      const synced = await syncRulesConfig({ cwd: tempDir });
      expect(synced.ok).toBe(true);
      const cachePath = getRulebookCachePath(synced.entries[0] as RulebookLockEntry, {
        cacheConfigDir: getProjectRulesDir(tempDir),
      });
      expect(existsSync(cachePath)).toBe(true);

      await expectProjectRulesDeleteSourceRemoved(tempDir);
      expect(readdirSync(join(tempDir, '.cc-safety-net', 'cache', 'rulebooks'))).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('removes clean bare local source without a lockfile when requested', async () => {
    const tempDir = makeTempDir('rules-policy-remove-delete-source-bare');

    try {
      writeProjectRulebookConfig(tempDir);
      await expectProjectRulesDeleteSourceRemoved(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('refuses to delete dirty local or GitHub rulebook sources', async () => {
    const tempDir = makeTempDir('rules-policy-remove-delete-source-refuse');
    const githubEntry = {
      spec: 'owner/repo#main/alpha',
      kind: 'github' as const,
      owner: 'owner',
      repo: 'repo',
      ref: 'main',
      commit: 'abc123',
      path: '.cc-safety-net/rules/alpha/rulebook.json',
      name: 'alpha',
      version: '1.0.0',
      digest: 'sha256:'.padEnd(71, 'a'),
    };

    try {
      writeProjectRulebook(tempDir);
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules']);
      expect((await syncRulesConfig({ cwd: tempDir })).ok).toBe(true);
      writeFileSync(join(getProjectRulesDir(tempDir), 'project-rules', 'notes.txt'), 'keep me');

      const dirtyResult = await removeRulebookSource('project-rules', {
        cwd: tempDir,
        deleteSource: true,
      });

      expect(dirtyResult.ok).toBe(false);
      expect(dirtyResult.errors[0]).toContain('delete manually');
      expect(readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.rules).toEqual([
        'project-rules',
      ]);

      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['owner/repo#main/alpha']);
      writeFileSync(
        getProjectRulesLockPath(tempDir),
        JSON.stringify({ version: 1, rulebooks: [githubEntry] }),
      );
      const githubResult = await removeRulebookSource('alpha', {
        cwd: tempDir,
        deleteSource: true,
      });

      expect(githubResult.ok).toBe(false);
      expect(githubResult.errors).toContain(
        '--delete-source can only delete local rulebook sources',
      );
      expect(readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.rules).toEqual([
        'owner/repo#main/alpha',
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('restores config and lock when delete-source fails after preflight', async () => {
    const tempDir = makeTempDir('rules-policy-remove-delete-source-failure');

    try {
      writeProjectRulebookConfig(tempDir);
      expect((await syncRulesConfig({ cwd: tempDir })).ok).toBe(true);
      const options = {
        cwd: tempDir,
        deleteSource: true,
        _testDeleteLocalSourceDir: () => {
          throw new Error('delete failed');
        },
      } satisfies RemoveRulebookSourceTestOptions;

      const result = await removeRulebookSourceWithHooks('project-rules', options, options);

      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('Failed to delete local rulebook source');
      expect(readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.rules).toEqual([
        'project-rules',
      ]);
      expect(readLockfile(getProjectRulesLockPath(tempDir)).lock?.rulebooks).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('refuses unsafe local source directory shapes before changing config', async () => {
    await expectProjectRulesDeleteSourcePreflightError(
      'rules-policy-remove-delete-source-missing-dir',
      writeProjectConfigOnly,
      'directory not found',
    );
    await expectProjectRulesDeleteSourcePreflightError(
      'rules-policy-remove-delete-source-not-dir',
      (tempDir) => {
        writeProjectConfigOnly(tempDir);
        writeFileSync(join(getProjectRulesDir(tempDir), 'project-rules'), 'not a directory');
      },
      'Unable to access project policy filesystem safely.',
    );
    await expectProjectRulesDeleteSourcePreflightError(
      'rules-policy-remove-delete-source-missing-rulebook',
      (tempDir) => {
        writeProjectConfigOnly(tempDir);
        mkdirSync(join(getProjectRulesDir(tempDir), 'project-rules'));
      },
      'missing rulebook.json',
    );
    await expectProjectRulesDeleteSourcePreflightError(
      'rules-policy-remove-delete-source-rulebook-dir',
      (tempDir) => {
        writeProjectConfigOnly(tempDir);
        mkdirSync(join(getProjectRulesDir(tempDir), 'project-rules', 'rulebook.json'), {
          recursive: true,
        });
      },
      'Unable to access project policy filesystem safely.',
    );
    await expectProjectRulesDeleteSourcePreflightError(
      'rules-policy-remove-delete-source-outside',
      (tempDir) => {
        writeProjectRulebookConfig(tempDir);
        writeFileSync(
          getProjectRulesLockPath(tempDir),
          JSON.stringify({
            version: 1,
            rulebooks: [
              {
                spec: 'project-rules',
                kind: 'local-directory',
                path: '../outside',
                name: 'project-rules',
                version: '1.0.0',
                digest: 'sha256:'.padEnd(71, 'a'),
              },
            ],
          }),
        );
      },
      'outside',
    );
  });

  for (const scenario of [
    {
      name: 'refuses to delete symlinked local source directory',
      tempName: 'rules-policy-remove-delete-source-symlink-dir',
      createSymlink: (tempDir: string, sourceDir: string) => {
        const targetDir = join(tempDir, 'outside-source');
        mkdirSync(targetDir);
        writeRulebook(join(targetDir, 'rulebook.json'));
        symlinkSync(targetDir, sourceDir, 'dir');
        return join(targetDir, 'rulebook.json');
      },
    },
    {
      name: 'refuses to delete symlinked local source rulebook file',
      tempName: 'rules-policy-remove-delete-source-symlink-rulebook',
      createSymlink: (tempDir: string, sourceDir: string) => {
        const targetPath = join(tempDir, 'outside-rulebook.json');
        mkdirSync(sourceDir);
        writeRulebook(targetPath);
        symlinkSync(targetPath, join(sourceDir, 'rulebook.json'));
        return targetPath;
      },
    },
  ]) {
    test(scenario.name, async () => {
      const tempDir = makeTempDir(scenario.tempName);
      try {
        writeProjectConfigOnly(tempDir);
        const protectedPath = scenario.createSymlink(
          tempDir,
          join(getProjectRulesDir(tempDir), 'project-rules'),
        );

        const result = await removeRulebookSource('project-rules', {
          cwd: tempDir,
          deleteSource: true,
        });

        expect(result.ok).toBe(false);
        expect(result.errors[0]).toBe('Unable to access project policy filesystem safely.');
        expect(existsSync(protectedPath)).toBe(true);
        expect(readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.rules).toEqual([
          'project-rules',
        ]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  test('handles GitHub repository inspection errors', async () => {
    const tempDir = makeTempDir('rules-policy-github');
    const originalFetch = globalThis.fetch;

    try {
      writeProjectRulebook(tempDir);

      globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
      expect((await addRulebookSource('owner/repo', { cwd: tempDir })).errors[0]).toContain(
        'GitHub returned 500',
      );

      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith('/repos/owner/repo')) {
          return new Response(JSON.stringify({ default_branch: 'main' }));
        }
        if (url.endsWith('/commits/main')) {
          return new Response(JSON.stringify({ sha: 'abc123' }));
        }
        return new Response(JSON.stringify({ tree: [] }));
      }) as typeof fetch;
      expect((await addRulebookSource('owner/repo', { cwd: tempDir })).errors[0]).toContain(
        'No rulebooks found',
      );
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects over-limit local rulebooks before cache or lock publication', async () => {
    const tempDir = makeTempDir('rules-policy-rulebook-limits');
    const source = join(getProjectRulesDir(tempDir), 'project-rules', 'rulebook.json');
    try {
      writeProjectConfigOnly(tempDir);
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, overLimitRulebookJson());

      const result = await syncRulesConfig({ cwd: tempDir });
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain(RULEBOOK_LIMIT_ERROR);
      expect(result.errors.join('\n')).not.toContain('TOPSECRET');
      expect(existsSync(getProjectRulesLockPath(tempDir))).toBe(false);
      const cacheRoot = join(tempDir, '.cc-safety-net', 'cache', 'rulebooks');
      expect(existsSync(cacheRoot) ? readdirSync(cacheRoot) : []).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('fails closed on a digest-valid over-limit cached rulebook', async () => {
    const tempDir = makeTempDir('rules-policy-cached-rulebook-limits');
    const userConfigDir = join(tempDir, 'user');
    try {
      writeProjectRulebookConfig(tempDir);
      expect((await syncRulesConfig({ cwd: tempDir, userConfigDir })).ok).toBe(true);
      const originalEntry = readLockfile(getProjectRulesLockPath(tempDir)).lock?.rulebooks[0];
      if (!originalEntry) throw new Error('missing local lock entry');

      const content = overLimitRulebookJson();
      const entry = { ...originalEntry, digest: sha256Digest(content) };
      const cachePath = getRulebookCachePath(entry, {
        cacheConfigDir: getProjectRulesDir(tempDir),
        userConfigDir,
      });
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, content);
      writeFileSync(join(getProjectRulesDir(tempDir), 'project-rules', 'rulebook.json'), content);
      writeFileSync(
        getProjectRulesLockPath(tempDir),
        JSON.stringify({ version: 1, rulebooks: [entry] }),
      );

      const policy = loadRulesPolicy({ cwd: tempDir, userConfigDir });
      expect(policy.rules).toEqual([]);
      expect(policy.rulebooks).toEqual([]);
      expect(policy.errors.join('\n')).toContain(RULEBOOK_LIMIT_ERROR);
      expect(policy.errors.join('\n')).not.toContain('TOPSECRET');
      const config = loadedRulesTestPolicy(policy);
      // The oversized rulebook is dropped, so it contributes no rules and denies
      // nothing; the diagnostic rides the snapshot reason without the secret.
      expect(analyzeCommand('echo ok', { cwd: tempDir, config })).toBeNull();
      expect(config.configFallbackReason).toContain(RULEBOOK_LIMIT_ERROR);
      expect(config.configFallbackReason).not.toContain('TOPSECRET');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('syncs and loads a fixture that matches before a long token tail', async () => {
    const tempDir = makeTempDir('rules-policy-early-fixture-match');
    const userConfigDir = join(tempDir, 'user');
    try {
      writeProjectConfigOnly(tempDir);
      const source = join(getProjectRulesDir(tempDir), 'project-rules', 'rulebook.json');
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(
        source,
        JSON.stringify({
          rulebook_version: 1,
          name: 'project-rules',
          version: '1.0.0',
          allowed_commands: ['tool'],
          rules: [
            {
              name: 'early-match',
              command: 'tool',
              subcommand: 'run',
              block_args: ['--admin'],
              reason: 'Blocked.',
            },
          ],
          tests: [
            {
              command: `tool run --admin ${Array(60).fill('x'.repeat(100)).join(' ')}`,
              expect: 'blocked',
              rule: 'early-match',
            },
          ],
        }),
      );

      const policy = await syncAndLoadRulesPolicy(tempDir, userConfigDir);
      expect(policy.rules.map((rule) => rule.name)).toEqual(['project-rules/early-match']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('covers resolver error paths for local and GitHub sources', async () => {
    const tempDir = makeTempDir('rules-policy-resolver-errors');
    const originalFetch = globalThis.fetch;
    const locked = {
      spec: 'owner/repo#main/alpha',
      kind: 'github' as const,
      owner: 'owner',
      repo: 'repo',
      ref: 'main',
      commit: 'abc123',
      path: '.cc-safety-net/rules/alpha/rulebook.json',
      name: 'alpha',
      version: '1.0.0',
      digest: 'sha256:'.padEnd(71, '0'),
    };

    try {
      await expect(resolveRulebookSource('bad:source', tempDir, {})).rejects.toThrow(
        'Local rulebook sources',
      );
      await expect(discoverGitHubRepositoryRulebooks('/repo')).rejects.toThrow(
        'Invalid GitHub repository source',
      );

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
      await expect(discoverGitHubRepositoryRulebooks('owner/repo')).rejects.toThrow(
        'missing default branch',
      );

      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url === 'https://api.github.com/repos/owner/repo') {
          return new Response(JSON.stringify({ default_branch: 'main' }));
        }
        if (url === 'https://api.github.com/repos/owner/repo/commits/main') {
          return new Response(JSON.stringify({ sha: 'abc123' }));
        }
        return new Response('', { status: 500 });
      }) as unknown as typeof fetch;
      await expect(discoverGitHubRepositoryRulebooks('owner/repo')).rejects.toThrow(
        'GitHub tree returned 500',
      );

      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        return url.endsWith('/commits/main')
          ? new Response(JSON.stringify({ sha: 'abc123' }))
          : new Response('', { status: 404 });
      }) as unknown as typeof fetch;
      await expect(resolveRulebookSource('owner/repo#main/alpha', tempDir, {})).rejects.toThrow(
        'GitHub raw returned 404',
      );

      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url === 'https://api.github.com/repos/owner/repo/commits/main') {
          return new Response(JSON.stringify({ sha: 'abc123' }));
        }
        if (url.includes('raw.githubusercontent.com')) {
          return new Response(rulebookJson('other'));
        }
        return new Response('', { status: 404 });
      }) as unknown as typeof fetch;
      await expect(resolveRulebookSource('owner/repo#main/alpha', tempDir, {})).rejects.toThrow(
        'must match GitHub source',
      );

      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.includes('raw.githubusercontent.com')) {
          return new Response(rulebookJson('alpha'));
        }
        return new Response('', { status: 404 });
      }) as unknown as typeof fetch;
      await expect(
        resolveRulebookSourceForSync(
          'owner/repo#main/alpha',
          tempDir,
          {},
          {
            version: 1,
            rulebooks: [locked],
          },
        ),
      ).rejects.toThrow('locked GitHub digest mismatch');

      const mismatchedContent = rulebookJson('beta');
      const mismatchedLocked = {
        ...locked,
        owner: 'attacker',
        path: '.cc-safety-net/rules/beta/rulebook.json',
        name: 'beta',
        digest: sha256Digest(mismatchedContent),
      };
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        return url.includes('raw.githubusercontent.com/attacker/repo/abc123/')
          ? new Response(mismatchedContent)
          : new Response('', { status: 404 });
      }) as unknown as typeof fetch;
      await expect(
        resolveRulebookSourceForSync(
          'owner/repo#main/alpha',
          tempDir,
          {},
          {
            version: 1,
            rulebooks: [mismatchedLocked],
          },
        ),
      ).rejects.toThrow('does not match GitHub source identity');
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('discovers GitHub rulebooks, preserves display refs, and supports partial sync', async () => {
    const tempDir = makeTempDir('rules-policy-github-success');
    const originalFetch = globalThis.fetch;
    const alphaRulebook = rulebookJson('alpha');

    try {
      mkdirSync(dirname(getProjectRulesConfigPath(tempDir)), { recursive: true });
      writeFileSync(
        getProjectRulesConfigPath(tempDir),
        JSON.stringify({ version: 1, rules: [], overrides: {}, transparent_wrappers: ['rtk'] }),
      );
      globalThis.fetch = mockGitHubRepoRulebooksFetch({ alpha: alphaRulebook }, [
        { path: '.cc-safety-net/rules/zeta/ignored.txt', type: 'blob' },
      ]);

      const added = await addRulebookSource('owner/repo', { cwd: tempDir });
      expect(added.ok).toBe(true);
      expect(await discoverGitHubRepositoryRulebooks('owner/repo')).toEqual([
        { spec: 'owner/repo#abc123/alpha', display_ref: 'main' },
      ]);
      expect(readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.rules).toEqual([
        'owner/repo#abc123/alpha',
      ]);
      expect(
        readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.transparent_wrappers,
      ).toEqual(['rtk']);
      expect(getRulesConfigSourceDisplayMap(getProjectRulesConfigPath(tempDir))).toEqual(
        new Map([['owner/repo#abc123/alpha', 'owner/repo#main/alpha']]),
      );

      const syncedFromCache = await syncRulesConfig({
        cwd: tempDir,
        only: 'alpha',
      });
      expect(syncedFromCache.ok).toBe(true);
      expect(syncedFromCache.entries[0]?.kind).toBe('github');
      const locked = readLockfile(getProjectRulesLockPath(tempDir)).lock?.rulebooks[0];
      if (!locked || locked.kind !== 'github') throw new Error('missing GitHub lock entry');
      expect(
        (
          await resolveRulebookSourceForSync(
            'owner/repo#abc123/alpha',
            getProjectRulesDir(tempDir),
            {},
            { version: 1, rulebooks: [locked] },
          )
        ).entry,
      ).toEqual(locked);
      expect(
        (await resolveRulebookSource('owner/repo#abc123/alpha', getProjectRulesDir(tempDir), {}))
          .entry.kind,
      ).toBe('github');
      expect(
        getRemoveMatches(
          ['owner/repo#abc123/alpha'],
          readLockfile(getProjectRulesLockPath(tempDir)).lock,
          'owner/repo',
        ),
      ).toEqual({ ok: true, specs: ['owner/repo#abc123/alpha'] });
      expect(
        getRemoveMatches(
          ['owner/repo#abc123/alpha', 'owner/repo#def456/beta'],
          readLockfile(getProjectRulesLockPath(tempDir)).lock,
          'owner/repo',
        ),
      ).toEqual(expect.objectContaining({ ok: false }));
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('prunes unreferenced local rulebook caches on sync', async () => {
    const tempDir = makeTempDir('rules-policy-prune-local');

    try {
      writeProjectRulebook(tempDir, 'project-rules');
      writeProjectRulebook(tempDir, 'extra-rules');
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules', 'extra-rules']);
      expect((await syncRulesConfig({ cwd: tempDir })).ok).toBe(true);
      const initialLock = readLockfile(getProjectRulesLockPath(tempDir)).lock;
      if (!initialLock) throw new Error('missing lockfile');
      const extraEntry = initialLock.rulebooks.find((entry) => entry.name === 'extra-rules');
      if (!extraEntry) throw new Error('missing extra-rules entry');
      const extraCachePath = getRulebookCachePath(extraEntry, {
        cacheConfigDir: getProjectRulesDir(tempDir),
      });
      expect(existsSync(extraCachePath)).toBe(true);

      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules']);
      expect((await syncRulesConfig({ cwd: tempDir })).ok).toBe(true);
      expect(existsSync(extraCachePath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('prunes unreferenced GitHub rulebook caches on sync', async () => {
    const tempDir = makeTempDir('rules-policy-prune-github');
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = mockGitHubRepoRulebooksFetch({
        alpha: rulebookJson('alpha'),
        beta: rulebookJson('beta'),
      });

      const added = await addRulebookSource('owner/repo', { cwd: tempDir });
      expect(added.ok).toBe(true);
      const initialLock = readLockfile(getProjectRulesLockPath(tempDir)).lock;
      if (!initialLock) throw new Error('missing lockfile');
      const betaEntry = initialLock.rulebooks.find(
        (entry) => entry.kind === 'github' && entry.name === 'beta',
      );
      if (!betaEntry) throw new Error('missing beta entry');
      const betaCachePath = getRulebookCachePath(betaEntry, {
        cacheConfigDir: getProjectRulesDir(tempDir),
      });
      expect(existsSync(betaCachePath)).toBe(true);

      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['owner/repo#abc123/alpha']);
      expect((await syncRulesConfig({ cwd: tempDir })).ok).toBe(true);
      expect(existsSync(betaCachePath)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('continues sync when cache pruning fails', async () => {
    const tempDir = makeTempDir('rules-policy-prune-warn');

    const cacheDir = join(dirname(getProjectRulesDir(tempDir)), 'cache', 'rulebooks', 'stale');
    try {
      writeProjectRulebook(tempDir, 'project-rules');
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules']);
      expect((await syncRulesConfig({ cwd: tempDir })).ok).toBe(true);

      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, 'rulebook.json'), '{}', 'utf-8');
      const options = {
        cwd: tempDir,
        _testPruneRulebookCacheDir: () => {
          throw new Error('prune failed');
        },
      } satisfies SyncRulesConfigTestOptions;
      const synced = await syncRulesConfigWithHooks(options, options);
      expect(synced.ok).toBe(true);
      expect(synced.warnings.length).toBeGreaterThan(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('covers lock validation, duplicate names, and sync rollback branches', async () => {
    const tempDir = makeTempDir('rules-policy-validation');
    const userConfigDir = join(tempDir, 'user');
    const localEntry = {
      spec: 'project-rules',
      kind: 'local-directory' as const,
      path: 'project-rules',
      name: 'project-rules',
      version: '1.0.0',
      digest: 'sha256:'.padEnd(71, 'a'),
    };

    try {
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules']);
      writeFileSync(
        getProjectRulesLockPath(tempDir),
        JSON.stringify({ version: 1, rulebooks: [localEntry] }),
      );
      expect((await syncRulesConfig({ cwd: tempDir, only: 'missing' })).errors[0]).toContain(
        'No configured rulebook matches missing',
      );
      expect((await syncRulesConfig({ cwd: tempDir, only: 'project-rules' })).errors[0]).toContain(
        'Rulebook source not found',
      );

      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['owner/repo#main/alpha']);
      writeFileSync(getProjectRulesLockPath(tempDir), '{not json', 'utf-8');
      expect(
        (await removeRulebookSource('alpha', { cwd: tempDir, userConfigDir })).errors[0],
      ).toContain('malformed lockfile');
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['project-rules']);
      writeFileSync(
        getProjectRulesLockPath(tempDir),
        JSON.stringify({ version: 1, rulebooks: [localEntry] }),
      );

      writeRulebook(
        join(getProjectRulesDir(tempDir), 'project-rules', 'rulebook.json'),
        'actual-name',
      );
      expect((await syncRulesConfig({ cwd: tempDir })).errors[0]).toContain(
        'must match local source',
      );
      expect(readRulesConfig(getProjectRulesConfigPath(tempDir)).config?.rules).toEqual([
        'project-rules',
      ]);

      writeProjectRulebook(tempDir);
      expect((await syncRulesConfig({ cwd: tempDir })).ok).toBe(true);
      const syncedEntry = readLockfile(getProjectRulesLockPath(tempDir)).lock?.rulebooks[0];
      if (!syncedEntry || syncedEntry.kind !== 'local-directory') {
        throw new Error('missing local lock entry');
      }
      expect(
        sha256Digest(
          readFileSync(
            join(getProjectRulesDir(tempDir), 'project-rules', 'rulebook.json'),
            'utf-8',
          ),
        ),
      ).toBe(syncedEntry.digest);
      writeFileSync(
        getProjectRulesLockPath(tempDir),
        JSON.stringify({ version: 1, rulebooks: [{ ...syncedEntry, path: '../outside' }] }),
      );
      expect((await syncRulesConfig({ cwd: tempDir, check: true })).errors).toEqual(
        expect.arrayContaining([expect.stringContaining('does not match local source identity')]),
      );
      writeFileSync(
        getProjectRulesLockPath(tempDir),
        JSON.stringify({ version: 1, rulebooks: [syncedEntry] }),
      );
      writeFileSync(join(getProjectRulesDir(tempDir), 'project-rules', 'rulebook.json'), '{}');
      expect((await syncRulesConfig({ cwd: tempDir })).errors[0]).toContain(
        'rulebook_version must be 1',
      );

      writeRulebook(join(userConfigDir, 'shared', 'rulebook.json'), 'shared');
      writeDefaultRulesConfig(getUserRulesConfigPath({ userConfigDir }), ['shared']);
      expect((await syncRulesConfig({ cwd: tempDir, userConfigDir, global: true })).ok).toBe(true);
      writeProjectRulebook(tempDir, 'shared');
      writeDefaultRulesConfig(getProjectRulesConfigPath(tempDir), ['shared']);
      // The collision resolves in favour of the first claim rather than failing the
      // scope being set up, so sync succeeds and the runtime warns instead.
      const collided = await syncRulesConfig({ cwd: tempDir, userConfigDir });
      expect(collided.ok).toBe(true);
      const merged = loadRulesPolicy({ cwd: tempDir, userConfigDir });
      expect(merged.warnings).toContainEqual(
        expect.stringContaining(
          'duplicate active rulebook name "shared" for shared; keeping the first',
        ),
      );
      // The user scope claimed the name first, so exactly one rulebook is active.
      expect(merged.rulebooks.map((rulebook) => rulebook.source)).toEqual(['user']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('loads user rule config once when cwd is the home directory', async () => {
    const tempDir = makeTempDir('rules-policy-home-cwd');
    const homeDir = join(tempDir, 'home');
    const userConfigDir = join(homeDir, '.cc-safety-net', 'rules');

    try {
      writeRulebook(join(userConfigDir, 'user-rules', 'rulebook.json'), 'user-rules');
      writeDefaultRulesConfig(getUserRulesConfigPath({ userConfigDir }), ['user-rules']);
      expect((await syncRulesConfig({ cwd: homeDir, userConfigDir, global: true })).ok).toBe(true);

      const policy = loadRulesPolicy({ cwd: homeDir, userConfigDir });
      const config = loadedRulesTestPolicy(policy);

      expect(policy.errors).toEqual([]);
      expect(policy.rulebooks.map((rulebook) => rulebook.source)).toEqual(['user']);
      expect(policy.rules.map((rule) => rule.name)).toEqual(['user-rules/block-docker-prune']);
      expect(config.configFallbackReason).toBeUndefined();
      expect(analyzeCommand('echo ok', { cwd: homeDir, config })).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('fails sync while an unknown override remains in the runtime policy', async () => {
    const tempDir = makeTempDir('rules-policy-sync-truth');
    const userConfigDir = join(tempDir, 'user');
    const writeProjectOverrides = (overrides: Record<string, string>) =>
      writeFileSync(
        getProjectRulesConfigPath(tempDir),
        JSON.stringify({ version: 1, rules: ['project-rules'], overrides }),
      );

    try {
      writeProjectRulebookConfig(tempDir);
      expect((await syncRulesConfig({ cwd: tempDir, userConfigDir })).ok).toBe(true);

      writeProjectOverrides({ 'project-rules/nope': 'off' });

      // The `CONFIG_LOCKOUT.md` sync row: publishing a lock is not proof the
      // runtime loads cleanly, so the reload decides what sync reports.
      const stale = await syncRulesConfig({ cwd: tempDir, userConfigDir });
      expect(stale.ok).toBe(false);
      expect(stale.errors).toEqual([
        unknownOverrideWarning('project-rules/nope', getProjectRulesConfigPath(tempDir)),
      ]);
      expect(loadRulesPolicy({ cwd: tempDir, userConfigDir }).warnings).toContain(
        unknownOverrideWarning('project-rules/nope', getProjectRulesConfigPath(tempDir)),
      );
      const checked = await syncRulesConfig({ cwd: tempDir, userConfigDir, check: true });
      expect(checked.ok).toBe(false);
      expect(checked.errors).toContain(
        unknownOverrideWarning('project-rules/nope', getProjectRulesConfigPath(tempDir)),
      );

      writeProjectOverrides({ 'project-rules/block-docker-prune': 'off' });

      const repaired = await syncRulesConfig({ cwd: tempDir, userConfigDir });
      expect(repaired.ok).toBe(true);
      expect(repaired.errors).toEqual([]);
      expect((await syncRulesConfig({ cwd: tempDir, userConfigDir, check: true })).ok).toBe(true);
      expect(loadRulesPolicy({ cwd: tempDir, userConfigDir }).warnings).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('promotes a pending local edit on the next sync', async () => {
    const tempDir = makeTempDir('rules-policy-sync-promotion');
    const userConfigDir = join(tempDir, 'user');

    try {
      writeProjectRulebookConfig(tempDir);
      expect((await syncRulesConfig({ cwd: tempDir, userConfigDir })).ok).toBe(true);
      writeFileSync(
        join(getProjectRulesDir(tempDir), 'project-rules', 'rulebook.json'),
        rulebookJson().replace('Use targeted cleanup.', 'Promoted by sync.'),
        'utf-8',
      );

      const promoted = await syncRulesConfig({ cwd: tempDir, userConfigDir });

      expect(promoted.ok).toBe(true);
      const runtime = loadRulesPolicy({ cwd: tempDir, userConfigDir });
      expect(runtime.errors).toEqual([]);
      expect(runtime.warnings).toEqual([]);
      expect(
        analyzeCommand('docker system prune', {
          cwd: tempDir,
          config: loadedRulesTestPolicy(runtime),
        })?.reason,
      ).toBe('[project-rules/block-docker-prune] Promoted by sync.');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
