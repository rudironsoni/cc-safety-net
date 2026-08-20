/**
 * Tests for the doctor command system-info functions.
 */

import { describe, expect, test } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultVersionFetcher,
  getPackageVersion,
  getSystemInfo,
} from '@/integrations/system-info';
import { mockVersionFetcher, withEnv, withTempDir } from '../helpers.ts';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createCopilotDeferredFetcher() {
  const calls: string[][] = [];
  const binaryVersion = createDeferred<string | null>();
  const fallbackVersion = createDeferred<string | null>();
  const fetcher = (args: string[]): Promise<string | null> => {
    calls.push(args);
    if (args[0] === 'copilot' && args[1] === '--binary-version') {
      return binaryVersion.promise;
    }
    if (args[0] === 'copilot' && args[1] === '--version') {
      return fallbackVersion.promise;
    }
    return Promise.resolve(null);
  };
  return { binaryVersion, calls, fallbackVersion, fetcher };
}

describe('getSystemInfo', () => {
  test('detects Bun version with mock fetcher', async () => {
    const sysInfo = await getSystemInfo(mockVersionFetcher);
    expect(sysInfo.bunVersion).toBe('1.0.0');
  });

  test('includes GitHub Copilot CLI version with mock fetcher', async () => {
    const sysInfo = await getSystemInfo(mockVersionFetcher);
    expect(sysInfo.versions['copilot-cli']).toBe('1.0.9');
  });

  test('includes Antigravity CLI version with mock fetcher', async () => {
    const sysInfo = await getSystemInfo(mockVersionFetcher);
    expect(sysInfo.versions['antigravity-cli']).toBe('2.0.0');
  });

  test('probes the Hermes executable with mock fetcher', async () => {
    const sysInfo = await getSystemInfo(mockVersionFetcher);
    expect(sysInfo.versions['hermes-agent']).toBe('1.5.0');
  });

  test('probes the OpenClaw executable with mock fetcher', async () => {
    const sysInfo = await getSystemInfo(mockVersionFetcher);
    expect(sysInfo.versions.openclaw).toBe('2026.8.1');
  });

  test('includes Kimi Code version with mock fetcher', async () => {
    const sysInfo = await getSystemInfo(mockVersionFetcher);
    expect(sysInfo.versions['kimi-code']).toBe('0.3.0');
  });

  test('includes Pi CLI version with mock fetcher', async () => {
    const sysInfo = await getSystemInfo(mockVersionFetcher);
    expect(sysInfo.versions.pi).toBe('0.4.0');
  });

  test('includes Codex CLI version with mock fetcher', async () => {
    const sysInfo = await getSystemInfo(mockVersionFetcher);
    expect(sysInfo.versions.codex).toBe('1.2.0');
  });

  test('includes Codex plugin list output with mock fetcher', async () => {
    const sysInfo = await getSystemInfo(mockVersionFetcher);
    expect(sysInfo.codexPluginListOutput).toContain(
      'https://github.com/kenryu42/cc-safety-net.git',
    );
  });

  test('gives the Codex plugin probe the same generous timeout as the Amp one', async () => {
    const calls: { argv: string; timeoutMs: number | undefined }[] = [];
    await getSystemInfo(async (args, timeoutMs) => {
      calls.push({ argv: args.join(' '), timeoutMs });
      return null;
    });

    // A cold `codex plugin list` outlasts the default 5s probe timeout, which would silently
    // report Codex as not installed in `doctor` while `install` still sees it.
    expect({
      amp: calls.find((call) => call.argv === 'amp plugins list')?.timeoutMs,
      codex: calls.find((call) => call.argv === 'codex plugin list')?.timeoutMs,
    }).toEqual({ amp: 30_000, codex: 30_000 });
  });

  test('parses Kimi Code version output through existing parser', async () => {
    const sysInfo = await getSystemInfo(async (args) => {
      if (args[0] === 'kimi') return 'Kimi Code v1.2.3';
      return null;
    });

    expect(sysInfo.versions['kimi-code']).toBe('1.2.3');
  });

  test('parses Antigravity CLI version output through existing parser', async () => {
    const sysInfo = await getSystemInfo(async (args) => {
      if (args[0] === 'agy') return 'Antigravity CLI v2.1.3';
      return mockVersionFetcher(args);
    });

    expect(sysInfo.versions['antigravity-cli']).toBe('2.1.3');
  });

  test('parses Codex CLI version output through existing parser', async () => {
    const sysInfo = await getSystemInfo(async (args) => {
      if (args[0] === 'codex') return 'Codex CLI v1.2.3';
      return null;
    });

    expect(sysInfo.versions.codex).toBe('1.2.3');
  });

  test('never starts copilot --version when --binary-version answers', async () => {
    const probes = createCopilotDeferredFetcher();
    const sysInfoPromise = getSystemInfo(probes.fetcher);
    await Promise.resolve();

    probes.binaryVersion.resolve('Copilot binary version: 1.0.9');
    const sysInfo = await sysInfoPromise;

    expect(sysInfo.versions['copilot-cli']).toBe('1.0.9');
    // The fallback downloads a ~160 MB package cache, so it must never be spawned in vain.
    expect(probes.calls.map((args) => args.join(' '))).not.toContain('copilot --version');
  });

  test('reports no Copilot version rather than running the probe that downloads 160 MB', async () => {
    const calls: string[][] = [];
    const fetcher = async (args: string[]) => {
      calls.push(args);
      if (args[0] !== 'copilot') return null;
      if (args[1] === '--version') return 'copilot 1.0.8';
      return null;
    };

    const sysInfo = await getSystemInfo(fetcher);

    expect(sysInfo.versions['copilot-cli']).toBeNull();
    expect(calls.map((args) => args.join(' '))).not.toContain('copilot --version');
  });

  test('handles commands that exit with non-zero code', async () => {
    const failingFetcher = async (_args: string[]) => null;
    const result = await getSystemInfo(failingFetcher);
    expect(result.versions['claude-code']).toBeNull();
    expect(result.versions['copilot-cli']).toBeNull();
    expect(result.versions.codex).toBeNull();
    expect(result.codexPluginListOutput).toBeNull();
    expect(result.versions['kimi-code']).toBeNull();
    expect(result.versions.pi).toBeNull();
    expect(result.bunVersion).toBeNull();
    expect(result.nodeVersion).toBeNull();
  });

  test('never runs the probes that write into the user config directories', async () => {
    const calls: string[][] = [];
    const sysInfo = await getSystemInfo(async (args) => {
      calls.push(args);
      return mockVersionFetcher(args);
    });
    const argv = calls.map((args) => args.join(' '));

    expect(argv).not.toContain('claude plugin list');
    expect(argv).not.toContain('gemini extensions list');
    expect(argv).not.toContain('copilot plugin list');
    expect(argv).toContain('codex plugin list');
    // `copilot --version` bootstraps a ~160 MB cache, so it must not run once the cheap
    // probe has answered.
    expect(argv).toContain('copilot --binary-version');
    expect(argv).not.toContain('copilot --version');
    expect(sysInfo.versions['copilot-cli']).not.toBeNull();
  });

  test('handles empty version output', async () => {
    const emptyFetcher = async (_args: string[]) => '';
    const result = await getSystemInfo(emptyFetcher);
    expect(result.versions['claude-code']).toBeNull();
    expect(result.versions['copilot-cli']).toBeNull();
    expect(result.versions.codex).toBeNull();
    expect(result.bunVersion).toBeNull();
  });
});

describe('defaultVersionFetcher', () => {
  test('returns null for non-existent commands', async () => {
    const result = await defaultVersionFetcher([
      '__nonexistent_command_that_definitely_does_not_exist__',
      '--version',
    ]);
    expect(result).toBeNull();
  });

  test('returns null for empty args', async () => {
    const result = await defaultVersionFetcher([]);
    expect(result).toBeNull();
  });

  test('returns null when spawn throws synchronously for invalid command input', async () => {
    const result = await defaultVersionFetcher(['\u0000']);
    expect(result).toBeNull();
  });

  test('returns version for existing commands', async () => {
    const result = await defaultVersionFetcher(['bun', '--version']);
    expect(result).not.toBeNull();
    expect(result).toMatch(/^\d+\.\d+/);
  });

  test('strips terminal control sequences from successful command output', async () => {
    const [stdoutResult, stderrResult] = await Promise.all([
      defaultVersionFetcher([
        'bun',
        '-e',
        'process.stdout.write("\\u001b[32mstdout output\\u001b[0m")',
      ]),
      defaultVersionFetcher([
        'bun',
        '-e',
        'process.stderr.write("\\u001b[31mstderr-only output\\u001b[0m")',
      ]),
    ]);
    expect({ stderrResult, stdoutResult }).toEqual({
      stderrResult: 'stderr-only output',
      stdoutResult: 'stdout output',
    });
  });

  test('returns null for commands that time out', async () => {
    const startedAt = Date.now();
    const result = await defaultVersionFetcher(['bun', '-e', 'setTimeout(() => {}, 30000)'], 25);
    const durationMs = Date.now() - startedAt;

    expect(result).toBeNull();
    expect(durationMs).toBeLessThan(1000);
  }, 1000);

  test('returns null for commands that exit with non-zero code', async () => {
    const result = await defaultVersionFetcher(['false']);
    expect(result).toBeNull();
  });

  test('preserves arguments when resolving Windows exe commands', async () => {
    if (process.platform === 'win32') return;

    await withTempDir('doctor-windows-exe-', async (tmpDir) => {
      const commandPath = join(tmpDir, 'fake.EXE');
      writeFileSync(commandPath, '#!/bin/sh\nprintf "%s" "$1"\n');
      chmodSync(commandPath, 0o755);

      const result = await withEnv(
        {
          PATH: tmpDir,
          PATHEXT: '.EXE;.CMD',
          _CC_SAFETY_NET_TEST_SPAWN_PLATFORM: 'win32',
        },
        () => defaultVersionFetcher(['fake', 'stderr-only output']),
      );

      expect(result).toBe('stderr-only output');
    });
  });

  test('wraps Windows cmd shims without shelling exe commands', async () => {
    if (process.platform === 'win32') return;

    await withTempDir('doctor-windows-cmd-', async (tmpDir) => {
      const extensionlessPath = join(tmpDir, 'fake');
      const commandPath = join(tmpDir, 'fake.CMD');
      const comspecPath = join(tmpDir, 'cmd');
      writeFileSync(extensionlessPath, '#!/bin/sh\nprintf "extensionless"\n');
      writeFileSync(commandPath, '');
      writeFileSync(comspecPath, '#!/bin/sh\nprintf "%s" "$3"\n');
      chmodSync(extensionlessPath, 0o755);
      chmodSync(comspecPath, 0o755);

      const result = await withEnv(
        {
          COMSPEC: comspecPath,
          PATH: '',
          Path: tmpDir,
          PATHEXT: '.CMD',
          _CC_SAFETY_NET_TEST_SPAWN_PLATFORM: 'win32',
        },
        () => defaultVersionFetcher(['fake', 'arg with space']),
      );

      expect(result).toContain(join(tmpDir, 'fake.CMD'));
      expect(result).toContain('"arg with space"');
    });
  });
});

describe('version comparison', () => {
  test('getPackageVersion returns version string', () => {
    const version = getPackageVersion();
    expect(typeof version).toBe('string');
    expect(version === 'dev' || /^\d+\.\d+\.\d+/.test(version)).toBe(true);
  });
});
