import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  addRulebookSource,
  getProjectRulesConfigPath,
  getProjectRulesDir,
  getRulesLockPathForConfigPath,
  getUserRulesConfigPath,
  syncRulesConfig,
} from '@/rules/policy';
import { getRulebookCachePath } from '@/rules/policy/paths';
import { fetchGitHubResource } from '@/rules/policy/resolver';
import {
  createRuleSyncOperation,
  createRuleSyncResourceBudget,
  RULE_SYNC_RESOURCE_LIMITS,
  type RuleSyncOperation,
  reserveGitHubRequest,
  reserveGitHubResponseBytes,
} from '@/rules/policy/resource-limits';
import {
  addRulebookSourceWithOperation,
  mapRulebookSources,
  syncRulesConfigWithOperation,
} from '@/rules/policy/sync';
import { withLoopbackServer } from '../helpers/loopback-server';

const SOURCE_LIMIT_ERROR = "Rule config exceeds CC Safety Net's safe source limit.";
const RESOURCE_LIMIT_ERROR = "Rule synchronization exceeds CC Safety Net's safe resource limits.";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rulebook(name: string) {
  return JSON.stringify({
    rulebook_version: 1,
    name,
    version: '1.0.0',
    allowed_commands: ['echo'],
    rules: [],
    tests: [],
  });
}

describe('rulebook sync source fanout limits', () => {
  test('maps at concurrency four, preserves order, and drains started work after first failure', async () => {
    const controls = Array.from({ length: 8 }, () => deferred<number>());
    const started: number[] = [];
    const operation = mapRulebookSources(controls, async (control, index, signal) => {
      started.push(index);
      if (index !== 3) signal.addEventListener('abort', () => {}, { once: true });
      return control.promise;
    });
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);

    controls[2]?.resolve(20);
    await Bun.sleep(0);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    controls[0]?.resolve(0);
    await Bun.sleep(0);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    controls[1]?.resolve(10);
    await Bun.sleep(0);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
    controls[4]?.resolve(40);
    await Bun.sleep(0);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    controls[3]?.resolve(30);
    controls[5]?.resolve(50);
    controls[6]?.resolve(60);
    controls[7]?.resolve(70);
    await expect(operation).resolves.toEqual([0, 10, 20, 30, 40, 50, 60, 70]);

    const failureControls = Array.from({ length: 8 }, () => deferred<number>());
    const failureStarted: number[] = [];
    const initiatingError = new Error('initiating failure');
    const failed = mapRulebookSources(failureControls, async (control, index) => {
      failureStarted.push(index);
      return control.promise;
    });
    await Promise.resolve();
    failureControls[1]?.reject(initiatingError);
    await Promise.resolve();
    await Promise.resolve();
    expect(failureStarted).toEqual([0, 1, 2, 3]);

    let settled = false;
    failed
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    failureControls[0]?.resolve(0);
    failureControls[2]?.resolve(2);
    await Promise.resolve();
    expect(settled).toBe(false);
    failureControls[3]?.resolve(3);
    await expect(failed).rejects.toBe(initiatingError);
    expect(failureStarted).toEqual([0, 1, 2, 3]);
  });

  test('accepts 64 real local sources in order and rejects 65 before lock or cache writes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rule-sync-source-limit-'));
    try {
      const names = Array.from(
        { length: 64 },
        (_, index) => `rules-${String(index).padStart(2, '0')}`,
      );
      for (const name of names) {
        const path = join(getProjectRulesDir(cwd), name, 'rulebook.json');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, rulebook(name));
      }
      const configPath = getProjectRulesConfigPath(cwd);
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ version: 1, rules: names.slice(0, 64) }));

      const accepted = await syncRulesConfig({ cwd });
      expect(accepted.ok).toBe(true);
      expect(accepted.entries.map((entry) => entry.spec)).toEqual(names.slice(0, 64));
      const lockPath = getRulesLockPathForConfigPath(configPath);
      const lockBefore = readFileSync(lockPath, 'utf8');
      const firstEntry = accepted.entries[0];
      if (!firstEntry) throw new Error('missing accepted entry');
      const cachePath = getRulebookCachePath(firstEntry, {
        cacheConfigDir: getProjectRulesDir(cwd),
      });
      const cacheBefore = readFileSync(cachePath, 'utf8');

      writeFileSync(
        configPath,
        JSON.stringify({ version: 1, rules: [...names.slice(0, 64), 'TOPSECRET'] }),
      );
      const rejected = await syncRulesConfig({ cwd });
      expect(rejected).toEqual({
        ok: false,
        errors: [SOURCE_LIMIT_ERROR],
        warnings: [],
        entries: [],
      });
      expect(JSON.stringify(rejected)).not.toContain('TOPSECRET');
      expect(readFileSync(lockPath, 'utf8')).toBe(lockBefore);
      expect(readFileSync(cachePath, 'utf8')).toBe(cacheBefore);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    // Two full syncs over 64 real sources exceed the 5s default on slow CI runners.
  }, 20_000);

  test('applies the same source preflight to user scope', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rule-sync-global-source-limit-'));
    const userConfigDir = join(cwd, 'user', 'rules');
    try {
      const configPath = getUserRulesConfigPath({ userConfigDir });
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          rules: [...Array.from({ length: 64 }, (_, index) => `rules-${index}`), 'TOPSECRET'],
        }),
      );
      const result = await syncRulesConfig({ cwd, userConfigDir, global: true });
      expect(result.errors).toEqual([SOURCE_LIMIT_ERROR]);
      expect(JSON.stringify(result)).not.toContain('TOPSECRET');
      expect(existsSync(getRulesLockPathForConfigPath(configPath))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('public sync and add ignore own and inherited operation getters', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rule-sync-public-operation-option-'));
    try {
      for (const name of ['project-rules', 'extra-rules']) {
        const path = join(getProjectRulesDir(cwd), name, 'rulebook.json');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, rulebook(name));
      }
      writeFileSync(
        getProjectRulesConfigPath(cwd),
        JSON.stringify({ version: 1, rules: ['project-rules'] }),
      );
      for (const shape of ['enumerable-own', 'non-enumerable-own', 'enumerable-inherited']) {
        let reads = 0;
        const inherited = {};
        const options = (shape === 'enumerable-inherited' ? Object.create(inherited) : {}) as {
          cwd: string;
        };
        options.cwd = cwd;
        Object.defineProperty(
          shape === 'enumerable-inherited' ? inherited : options,
          '_operation',
          {
            enumerable: shape !== 'non-enumerable-own',
            get() {
              reads++;
              throw new Error(`public operation option was read: ${shape}`);
            },
          },
        );

        expect((await syncRulesConfig(options)).ok).toBe(true);
        expect((await addRulebookSource('extra-rules', options)).ok).toBe(true);
        expect(reads).toBe(0);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('rulebook sync aggregate fetch budget', () => {
  test('enforces exact request and streamed-byte boundaries with one fixed diagnostic', async () => {
    const requestBudget = createRuleSyncResourceBudget();
    for (let index = 0; index < RULE_SYNC_RESOURCE_LIMITS.maxRequests; index++) {
      reserveGitHubRequest(requestBudget);
    }
    expect(() => reserveGitHubRequest(requestBudget)).toThrow(RESOURCE_LIMIT_ERROR);

    const byteBudget = createRuleSyncResourceBudget();
    reserveGitHubResponseBytes(byteBudget, RULE_SYNC_RESOURCE_LIMITS.maxResponseBytes - 1);
    reserveGitHubResponseBytes(byteBudget, 1);
    expect(() => reserveGitHubResponseBytes(byteBudget, 1)).toThrow(RESOURCE_LIMIT_ERROR);
    expect(byteBudget.responseBytes).toBe(RULE_SYNC_RESOURCE_LIMITS.maxResponseBytes + 1);

    const overflowClosed = deferred<void>();
    const overflowRelease = deferred<void>();
    let redirectTargetRequests = 0;
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/bytes') {
          response.write(Buffer.from([65]));
          response.end(Buffer.from([66, 67]));
          return;
        }
        if (request.url === '/overflow') {
          response.on('close', () => overflowClosed.resolve());
          response.write(Buffer.alloc(2));
          overflowRelease.promise.then(() => response.end()).catch(() => {});
          return;
        }
        if (request.url === '/non-ok') {
          response.writeHead(500);
          response.end('unread');
          return;
        }
        if (request.url === '/redirect') {
          response.writeHead(302, { location: '/redirect-target' }).end();
          return;
        }
        if (request.url === '/redirect-target') redirectTargetRequests++;
        response.end('unexpected');
      },
      async (origin) => {
        const exactBudget = createRuleSyncResourceBudget({
          maxRequests: 2,
          maxResponseBytes: 3,
        });
        await expect(
          fetchGitHubResource(`${origin}/bytes`, 'metadata', { budget: exactBudget }),
        ).resolves.toEqual(expect.objectContaining({ content: 'ABC' }));
        await expect(
          fetchGitHubResource(`${origin}/bytes`, 'metadata', { budget: exactBudget }),
        ).rejects.toThrow(RESOURCE_LIMIT_ERROR);

        const nonOkBudget = createRuleSyncResourceBudget({ maxRequests: 1, maxResponseBytes: 0 });
        await expect(
          fetchGitHubResource(`${origin}/non-ok`, 'metadata', { budget: nonOkBudget }),
        ).resolves.toEqual(expect.objectContaining({ content: '' }));
        expect(() => reserveGitHubRequest(nonOkBudget)).toThrow(RESOURCE_LIMIT_ERROR);

        const overflowBudget = createRuleSyncResourceBudget({ maxResponseBytes: 1 });
        await expect(
          fetchGitHubResource(`${origin}/overflow`, 'metadata', { budget: overflowBudget }),
        ).rejects.toThrow(RESOURCE_LIMIT_ERROR);
        overflowRelease.resolve();
        await overflowClosed.promise;
        expect(overflowBudget.responseBytes).toBe(2);

        await expect(fetchGitHubResource(`${origin}/redirect`, 'metadata')).rejects.toThrow();
        expect(redirectTargetRequests).toBe(0);
      },
    );
  });

  test('does not reserve or fetch when pre-aborted and distinguishes operation abort from timeout', async () => {
    const activeStarted = deferred<void>();
    const timeoutStarted = deferred<void>();
    let preAbortedRequests = 0;
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/pre-aborted') {
          preAbortedRequests++;
          response.end();
          return;
        }
        if (request.url === '/active') activeStarted.resolve();
        if (request.url === '/timeout') timeoutStarted.resolve();
      },
      async (origin) => {
        const budget = createRuleSyncResourceBudget({ maxRequests: 1 });
        const controller = new AbortController();
        const operationError = new Error('operation failed');
        controller.abort(operationError);
        await expect(
          fetchGitHubResource(`${origin}/pre-aborted`, 'metadata', {
            budget,
            signal: controller.signal,
          }),
        ).rejects.toBe(operationError);
        expect(preAbortedRequests).toBe(0);
        expect(() => reserveGitHubRequest(budget)).not.toThrow();

        const active = new AbortController();
        const request = fetchGitHubResource(`${origin}/active`, 'metadata', {
          signal: active.signal,
          timeoutMs: 10_000,
        });
        await activeStarted.promise;
        active.abort(operationError);
        await expect(request).rejects.toBe(operationError);

        const timedOut = fetchGitHubResource(`${origin}/timeout`, 'metadata', { timeoutMs: 10 });
        await timeoutStarted.promise;
        await expect(timedOut).rejects.toThrow('GitHub request timed out');
      },
    );
  });
});

describe('GitHub repository discovery source boundaries', () => {
  test('shares the 131-request budget across discovery and 64 ordered resolutions', async () => {
    const names = Array.from(
      { length: 64 },
      (_, index) => `rules-${String(index).padStart(2, '0')}`,
    );
    await withGitHubRulebooks('boundary', names, async (cwd, requests, operation) => {
      await expectSuccessfulRepositoryAdd(cwd, requests, names, operation());
    });
  });

  test('keeps config bytes and publication state unchanged when discovery would add source 65', async () => {
    const names = Array.from(
      { length: 65 },
      (_, index) => `rules-${String(index).padStart(2, '0')}`,
    );
    const config =
      '{\n  "version": 1,\n  "rules": [],\n  "overrides": {},\n  "transparent_wrappers": ["rtk"]\n}\n';
    await withGitHubRulebooks('over-limit', names, async (cwd, requests, operation) => {
      const configPath = getProjectRulesConfigPath(cwd);
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, config);
      const result = await addRulebookSourceWithOperation('owner/repo', { cwd }, operation());

      expect(result).toEqual({
        ok: false,
        errors: [SOURCE_LIMIT_ERROR],
        warnings: [],
        entries: [],
      });
      expect(readFileSync(configPath, 'utf8')).toBe(config);
      expect(existsSync(getRulesLockPathForConfigPath(configPath))).toBe(false);
      expect(existsSync(join(cwd, '.cc-safety-net', 'cache'))).toBe(false);
      expect(requests).toHaveLength(3);
    });
  });

  test('deduplicates repository tree entries before enforcing the source boundary', async () => {
    const names = Array.from({ length: 65 }, () => 'rules-00');
    await withGitHubRulebooks('deduplicate', names, async (cwd, requests, operation) => {
      const result = await addRulebookSourceWithOperation('owner/repo', { cwd }, operation());
      expect(result.ok).toBe(true);
      expect(result.entries.map((entry) => entry.name)).toEqual(['rules-00']);
      expect(requests).toHaveLength(5);
    });
  });

  test('preserves request counts for pinned, restored, refreshed, partial, and check paths', async () => {
    await withGitHubRulebooks('request-counts', ['rules-00'], async (cwd, requests, operation) => {
      const configPath = getProjectRulesConfigPath(cwd);
      const localPath = join(getProjectRulesDir(cwd), 'local-rules', 'rulebook.json');
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, rulebook('local-rules'));
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          rules: ['owner/repo#main/rules-00', 'local-rules'],
        }),
      );
      expect((await syncRulesConfigWithOperation({ cwd }, operation())).ok).toBe(true);
      expect(requests).toHaveLength(2);
      requests.length = 0;
      expect((await syncRulesConfigWithOperation({ cwd }, operation())).ok).toBe(true);
      expect(requests).toHaveLength(0);

      const lockPath = getRulesLockPathForConfigPath(configPath);
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        rulebooks: Array<Parameters<typeof getRulebookCachePath>[0]>;
      };
      const remote = lock.rulebooks.find((entry) => entry.kind === 'github');
      if (!remote) throw new Error('missing remote lock entry');
      const cachePath = getRulebookCachePath(remote, {
        cacheConfigDir: getProjectRulesDir(cwd),
      });
      rmSync(cachePath);
      expect((await syncRulesConfigWithOperation({ cwd }, operation())).ok).toBe(true);
      expect(requests).toHaveLength(1);

      requests.length = 0;
      const lockBeforeCheck = readFileSync(lockPath, 'utf8');
      const cacheBeforeCheck = readFileSync(cachePath, 'utf8');
      expect((await syncRulesConfigWithOperation({ cwd, check: true }, operation())).ok).toBe(true);
      expect(requests).toHaveLength(0);
      expect(readFileSync(lockPath, 'utf8')).toBe(lockBeforeCheck);
      expect(readFileSync(cachePath, 'utf8')).toBe(cacheBeforeCheck);

      expect(
        (await syncRulesConfigWithOperation({ cwd, only: 'rules-00', refresh: true }, operation()))
          .ok,
      ).toBe(true);
      expect(requests).toHaveLength(2);
      expect(
        (
          JSON.parse(readFileSync(lockPath, 'utf8')) as { rulebooks: Array<{ name: string }> }
        ).rulebooks.map((entry) => entry.name),
      ).toEqual(['rules-00', 'local-rules']);
    });
  });
});

async function expectSuccessfulRepositoryAdd(
  cwd: string,
  requests: string[],
  names: string[],
  operation: RuleSyncOperation,
): Promise<void> {
  const result = await addRulebookSourceWithOperation('owner/repo', { cwd }, operation);
  expect(result.ok).toBe(true);
  expect(result.entries.map((entry) => entry.name)).toEqual(names);
  expect(requests).toHaveLength(RULE_SYNC_RESOURCE_LIMITS.maxRequests);
}

async function withGitHubRulebooks(
  name: string,
  names: string[],
  run: (cwd: string, requests: string[], operation: () => RuleSyncOperation) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), `rule-sync-github-${name}-`));
  const requests: string[] = [];
  try {
    await withLoopbackServer(
      (request, response) => {
        const target = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('target');
        if (!target) {
          response.writeHead(404).end();
          return;
        }
        requests.push(target);
        respondToGitHubRequest(target, names, response);
      },
      async (origin) =>
        run(cwd, requests, () =>
          createRuleSyncOperation((url) => `${origin}/github?target=${encodeURIComponent(url)}`),
        ),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function respondToGitHubRequest(url: string, names: string[], response: ServerResponse): void {
  if (url === 'https://api.github.com/repos/owner/repo') {
    response.end(JSON.stringify({ default_branch: 'main' }));
    return;
  }
  if (url.endsWith('/commits/main') || url.endsWith('/commits/abc123')) {
    response.end(JSON.stringify({ sha: 'abc123' }));
    return;
  }
  if (url.endsWith('/git/trees/abc123?recursive=1')) {
    response.end(
      JSON.stringify({
        tree: names.map((rulebookName) => ({
          path: `.cc-safety-net/rules/${rulebookName}/rulebook.json`,
          type: 'blob',
        })),
      }),
    );
    return;
  }
  const rulebookName = names.find((candidate) =>
    url.endsWith(`/.cc-safety-net/rules/${candidate}/rulebook.json`),
  );
  if (rulebookName) {
    response.end(rulebook(rulebookName));
    return;
  }
  response.writeHead(404).end();
}
