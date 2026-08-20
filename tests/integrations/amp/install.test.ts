/**
 * Amp personal-scope install: the plugin is pushed to the user's Amp Personal Plugins
 * repository over hidden git plumbing. Every `amp`/`git` call goes through the injected
 * runner, so no test here touches the network or a real Amp repository.
 */

import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildAmpArtifactHeader } from '@/integrations/amp/artifact';
import { getAmpPluginPath, installAmp, uninstallAmp } from '@/integrations/amp/install';
import type { AmpRunner } from '@/integrations/amp/run';
import { getPackageVersion } from '@/integrations/system-info';
import { normalizeGuiPolicy } from '@/policy/store';
import { withEnv } from '../../helpers.ts';
import { makeTempHome } from '../hook-helpers.ts';

const CLONE_REF = 'jliew/-/plugins';
const PLUGIN_DIRECTORY = 'cc-safety-net';
const PLUGIN_ENTRY = join(PLUGIN_DIRECTORY, 'index.ts');
const LEGACY_PLUGIN_FILE = 'cc-safety-net.ts';
/** A file the user keeps beside our entry; install and uninstall must never touch it. */
const EXTRA_FILE = 'README.md';
const REPOSITORIES_JSON = JSON.stringify(
  [
    {
      scope: 'user',
      exists: true,
      cloneURL: 'https://ampcode.com/git/@jliew/-/plugins',
      viewerCanWrite: true,
      cloneRef: CLONE_REF,
    },
  ],
  null,
  2,
);

function writeArtifactFixture(dir: string): string {
  const artifactPath = join(dir, 'artifact.ts');
  writeFileSync(artifactPath, `${buildAmpArtifactHeader('9.9.9')}export default function () {}\n`);
  return artifactPath;
}

function writeCheckoutPlugin(checkout: string, content: string | Buffer): void {
  mkdirSync(join(checkout, PLUGIN_DIRECTORY), { recursive: true });
  writeFileSync(join(checkout, PLUGIN_ENTRY), content);
}

type StubOptions = {
  /** Response for `amp plugins repositories --json`. */
  repositories?: { status?: number | null; errorCode?: string; stdout?: string; stderr?: string };
  /** Populate the fake checkout the way the hosted repository would. */
  seedCheckout?: (checkout: string) => void;
  /** Joined command prefix that should fail. */
  failCommand?: string;
  /** Emulate core.autocrlf: staging renormalizes the file back to HEAD, so the tree stays clean. */
  stageLeavesTreeClean?: boolean;
};

function makeAmpStub(options: StubOptions = {}) {
  const calls: string[] = [];
  // The checkout is removed once the run finishes, so on-disk facts are captured at staging time.
  const state: {
    checkout?: string;
    staged?: string;
    dirty?: boolean;
    legacyAtStage?: boolean;
    extraAtStage?: boolean;
  } = {};
  const run: AmpRunner = (command, cwd) => {
    const line = command.join(' ');
    calls.push(line);

    if (line === 'amp plugins repositories --json') {
      return {
        status:
          options.repositories && 'status' in options.repositories
            ? (options.repositories.status ?? null)
            : 0,
        errorCode: options.repositories?.errorCode,
        stdout: options.repositories?.stdout ?? REPOSITORIES_JSON,
        stderr: options.repositories?.stderr ?? '',
      };
    }
    if (options.failCommand && line.startsWith(options.failCommand)) {
      return { status: 1, stdout: '', stderr: `${command[0]}: boom` };
    }
    if (line === 'git status --porcelain') {
      return { status: 0, stdout: state.dirty ? 'M  cc-safety-net/index.ts\n' : '', stderr: '' };
    }
    if (command[1] === 'clone') {
      state.checkout = command[3];
      if (command[3]) options.seedCheckout?.(command[3]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (line.startsWith('git add') && cwd) {
      const staged = join(cwd, PLUGIN_ENTRY);
      state.staged = existsSync(staged) ? readFileSync(staged, 'utf-8') : undefined;
    }
    if ((line.startsWith('git add') || line.startsWith('git rm')) && cwd) {
      state.legacyAtStage = existsSync(join(cwd, LEGACY_PLUGIN_FILE));
      state.extraAtStage = existsSync(join(cwd, PLUGIN_DIRECTORY, EXTRA_FILE));
    }
    if (line.startsWith('git add') || line.startsWith('git rm')) {
      state.dirty = !options.stageLeavesTreeClean;
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  return { calls, run, state };
}

/** Stub whose checkout already holds the exact bytes of the packaged artifact. */
function makeCurrentCheckoutStub(artifactPath: string) {
  return makeAmpStub({
    seedCheckout: (checkout) => writeCheckoutPlugin(checkout, readFileSync(artifactPath)),
  });
}

function gitCalls(calls: readonly string[]): string[] {
  return calls.filter((call) => call.startsWith('git '));
}

/** Pins the policy lookup inside the temporary home, so an exported CC_SAFETY_NET_HOME
 * from the developer's environment can never stamp a policy onto the published artifact. */
async function withTempHome<T>(name: string, run: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = makeTempHome(name);
  try {
    return await withEnv({ CC_SAFETY_NET_HOME: join(homeDir, 'safety-net-home') }, () =>
      run(homeDir),
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function writeLocalPlugin(homeDir: string, content: string): string {
  const localPath = getAmpPluginPath(homeDir);
  mkdirSync(join(localPath, '..'), { recursive: true });
  writeFileSync(localPath, content);
  return localPath;
}

/** The shipped directory layout, hand-copied into the local system-scope plugins folder. */
function writeLocalDirectoryPlugin(homeDir: string, content: string, extra?: string): string {
  const localDir = join(homeDir, '.config', 'amp', 'plugins', PLUGIN_DIRECTORY);
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, 'index.ts'), content);
  if (extra !== undefined) writeFileSync(join(localDir, EXTRA_FILE), extra);
  return localDir;
}

/** Bytes of a managed plugin that is ours but out of date. */
const MANAGED_PLUGIN = `${buildAmpArtifactHeader('1.0.0')}export default 0;\n`;

/** Populates the fake checkout with the entries the hosted repository would hold. */
function seedCheckout(entries: { plugin?: string; extra?: string; legacy?: string }) {
  return (checkout: string) => {
    if (entries.plugin !== undefined) writeCheckoutPlugin(checkout, entries.plugin);
    if (entries.extra !== undefined)
      writeFileSync(join(checkout, PLUGIN_DIRECTORY, EXTRA_FILE), entries.extra);
    if (entries.legacy !== undefined)
      writeFileSync(join(checkout, LEGACY_PLUGIN_FILE), entries.legacy);
  };
}

/**
 * Installs with the user policy file at `<homeDir>/.cc-safety-net/policy.json`.
 * CC_SAFETY_NET_HOME redirects the policy lookup and HOME redirects the home-relative path
 * repair that normalization performs, so no case here reads the developer's real home.
 */
function installWithUserPolicy(
  homeDir: string,
  artifactPath: string,
  run: AmpRunner,
  policyJson?: string,
) {
  const safetyNetHome = join(homeDir, '.cc-safety-net');
  mkdirSync(safetyNetHome, { recursive: true });
  if (policyJson !== undefined) writeFileSync(join(safetyNetHome, 'policy.json'), policyJson);
  return withEnv({ CC_SAFETY_NET_HOME: safetyNetHome, HOME: homeDir }, () =>
    installAmp(homeDir, artifactPath, run),
  );
}

/** The published bytes past the packaged artifact: the policy stamp, or '' when unstamped. */
function stampedSuffix(staged: string | undefined, artifactPath: string): string {
  return String(staged).slice(readFileSync(artifactPath, 'utf-8').length);
}

describe('Amp personal install', () => {
  test('pushes the packaged artifact to the personal plugins repository', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub();

      const result = await installAmp(homeDir, artifactPath, stub.run);

      expect(result.alreadyInstalled).toBe(false);
      expect(result.path).toBe(`${CLONE_REF}/cc-safety-net`);
      expect(stub.calls[0]).toBe('amp plugins repositories --json');
      expect(stub.calls[1]).toBe(`amp clone user-plugins ${stub.state.checkout}`);
      expect(stub.state.staged).toBe(readFileSync(artifactPath, 'utf-8'));
      expect(gitCalls(stub.calls)).toEqual([
        'git add -- cc-safety-net/index.ts',
        'git status --porcelain',
        `git -c commit.gpgsign=false -c user.name=cc-safety-net -c user.email=cc-safety-net@localhost commit -m chore: update cc-safety-net plugin to v${getPackageVersion()}`,
        'git push origin HEAD',
      ]);
      expect(existsSync(String(stub.state.checkout))).toBe(false);
    });
  });

  test('reports already installed and pushes nothing when the bytes match', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeCurrentCheckoutStub(artifactPath);

      const result = await installAmp(homeDir, artifactPath, stub.run);

      expect(result.alreadyInstalled).toBe(true);
      expect(result.path).toBe(`${CLONE_REF}/cc-safety-net`);
      expect(gitCalls(stub.calls)).toEqual([]);
    });
  });

  test('replaces an outdated managed artifact in the checkout', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({
        seedCheckout: (checkout) =>
          writeCheckoutPlugin(checkout, `${buildAmpArtifactHeader('0.0.1')}export default 0;\n`),
      });

      expect((await installAmp(homeDir, artifactPath, stub.run)).alreadyInstalled).toBe(false);
      expect(stub.state.staged).toBe(readFileSync(artifactPath, 'utf-8'));
    });
  });

  test('migrates the managed legacy root file to a directory plugin', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({
        seedCheckout: seedCheckout({
          legacy: `${buildAmpArtifactHeader('0.0.1')}export default 0;\n`,
        }),
      });

      const result = await installAmp(homeDir, artifactPath, stub.run);

      expect(result.alreadyInstalled).toBe(false);
      expect(stub.state.staged).toBe(readFileSync(artifactPath, 'utf-8'));
      // The migration only completes if the root file is really gone before it is staged.
      expect(stub.state.legacyAtStage).toBe(false);
      expect(gitCalls(stub.calls)).toContain('git add -- cc-safety-net/index.ts cc-safety-net.ts');
    });
  });

  test('installs beside an unmanaged file the user keeps in the plugin directory', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({
        seedCheckout: seedCheckout({ plugin: MANAGED_PLUGIN, extra: '# notes\n' }),
      });

      const result = await installAmp(homeDir, artifactPath, stub.run);

      expect(result.alreadyInstalled).toBe(false);
      expect(stub.state.extraAtStage).toBe(true);
      expect(gitCalls(stub.calls)).toContain('git add -- cc-safety-net/index.ts');
    });
  });

  test('refuses an unmanaged legacy root file', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({
        seedCheckout: (checkout) =>
          writeFileSync(join(checkout, LEGACY_PLUGIN_FILE), 'export default 1;\n'),
      });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        'Refusing to overwrite unmanaged file cc-safety-net.ts',
      );
      expect(gitCalls(stub.calls)).toEqual([]);
    });
  });

  test('refuses an unmanaged file in the personal plugins repository', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({
        seedCheckout: (checkout) => writeCheckoutPlugin(checkout, 'export default 1;\n'),
      });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        'Refusing to overwrite unmanaged file',
      );
      expect(gitCalls(stub.calls)).toEqual([]);
      expect(existsSync(String(stub.state.checkout))).toBe(false);
    });
  });

  test('reports already installed when staging renormalizes the checkout back to HEAD', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({
        // core.autocrlf smudges the committed LF plugin to CRLF, so the bytes differ even
        // though `git add` renormalizes the index straight back to HEAD.
        seedCheckout: (checkout) =>
          writeCheckoutPlugin(
            checkout,
            readFileSync(artifactPath, 'utf-8').replaceAll('\n', '\r\n'),
          ),
        stageLeavesTreeClean: true,
      });

      const result = await installAmp(homeDir, artifactPath, stub.run);

      expect(result.alreadyInstalled).toBe(true);
      expect(gitCalls(stub.calls)).toEqual([
        'git add -- cc-safety-net/index.ts',
        'git status --porcelain',
      ]);
    });
  });

  test.each([
    [
      'a symlink',
      (checkout: string, target: string) => symlinkSync(target, join(checkout, PLUGIN_DIRECTORY)),
    ],
    [
      'a non-directory',
      (checkout: string) => writeFileSync(join(checkout, PLUGIN_DIRECTORY), 'not a directory'),
    ],
  ])('refuses %s at the plugin path in the personal plugins repository', async (_label, seed) => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({ seedCheckout: (checkout) => seed(checkout, artifactPath) });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        'not a regular directory',
      );
      expect(gitCalls(stub.calls)).toEqual([]);
    });
  });

  test('fails with an actionable message when the amp CLI is missing', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({
        repositories: { status: null, errorCode: 'ENOENT', stderr: 'spawn amp ENOENT' },
      });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        'Amp CLI not found',
      );
      expect(stub.calls).toEqual(['amp plugins repositories --json']);
    });
  });

  test('does not blame a missing CLI when the amp command times out', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({
        repositories: { status: null, errorCode: 'ETIMEDOUT', stderr: 'spawnSync amp ETIMEDOUT' },
      });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        /did not finish \(ETIMEDOUT\)/,
      );
    });
  });

  test('fails on the preflight step when amp plugins repositories exits non-zero', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({
        repositories: { status: 1, stdout: '', stderr: 'not signed in' },
      });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        /amp plugins repositories --json/,
      );
      expect(stub.calls).toEqual(['amp plugins repositories --json']);
    });
  });

  test('fails when no writable personal plugins repository exists', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({
        repositories: {
          stdout: JSON.stringify([
            { scope: 'user', exists: true, viewerCanWrite: false, cloneRef: CLONE_REF },
          ]),
        },
      });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        /Personal Plugins repository/,
      );
      expect(stub.calls).toEqual(['amp plugins repositories --json']);
    });
  });

  test('fails with the actionable message when the repositories output is not JSON', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({ repositories: { stdout: 'not json' } });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        /Personal Plugins repository/,
      );
      expect(stub.calls).toEqual(['amp plugins repositories --json']);
    });
  });

  test('reports the failed step and removes the checkout when the push fails', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({ failCommand: 'git push' });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        /git push origin HEAD/,
      );
      expect(existsSync(String(stub.state.checkout))).toBe(false);
    });
  });

  test('reports the failed step when the staged-status probe fails', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({ failCommand: 'git status' });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        'Failed to run git status --porcelain (exit 1).',
      );
      expect(gitCalls(stub.calls)).toEqual([
        'git add -- cc-safety-net/index.ts',
        'git status --porcelain',
      ]);
    });
  });

  test('reports the failed step when the clone fails', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub({ failCommand: 'amp clone' });

      await expect(installAmp(homeDir, artifactPath, stub.run)).rejects.toThrow(
        /amp clone user-plugins/,
      );
    });
  });

  test('removes a leftover managed local plugin that would mask the personal one', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const localPath = writeLocalPlugin(
        homeDir,
        `${buildAmpArtifactHeader('0.0.1')}export default 0;\n`,
      );
      const stub = makeAmpStub();

      await installAmp(homeDir, artifactPath, stub.run);

      expect(existsSync(localPath)).toBe(false);
    });
  });

  test('removes the masking local plugin even when the personal copy is current', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const localPath = writeLocalPlugin(homeDir, readFileSync(artifactPath, 'utf-8'));
      const stub = makeCurrentCheckoutStub(artifactPath);

      const result = await installAmp(homeDir, artifactPath, stub.run);

      expect(result.alreadyInstalled).toBe(true);
      expect(existsSync(localPath)).toBe(false);
    });
  });

  test('keeps an unmanaged local file at the system plugin path but fails the install', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const localPath = writeLocalPlugin(homeDir, 'export default 1;\n');

      await expect(installAmp(homeDir, artifactPath, makeAmpStub().run)).rejects.toThrow(
        'masks the personal plugin',
      );

      expect(readFileSync(localPath, 'utf-8')).toBe('export default 1;\n');
    });
  });

  test('keeps a symlink at the system plugin path but fails the install', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const localPath = getAmpPluginPath(homeDir);
      mkdirSync(join(localPath, '..'), { recursive: true });
      symlinkSync(artifactPath, localPath);

      await expect(installAmp(homeDir, artifactPath, makeAmpStub().run)).rejects.toThrow(
        'masks the personal plugin',
      );
      expect(lstatSync(localPath).isSymbolicLink()).toBe(true);

      await uninstallAmp(homeDir, makeAmpStub().run);
      expect(lstatSync(localPath).isSymbolicLink()).toBe(true);
    });
  });

  test('removes a leftover managed local directory plugin', async () => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const localDir = writeLocalDirectoryPlugin(
        homeDir,
        `${buildAmpArtifactHeader('0.0.1')}export default 0;\n`,
      );

      await installAmp(homeDir, artifactPath, makeAmpStub().run);

      expect(existsSync(localDir)).toBe(false);
    });
  });

  test.each([
    ['an unmanaged entry', 'export default 1;\n', undefined],
    ['a file of the user beside our entry', `${buildAmpArtifactHeader('0.0.1')}\n`, '# notes\n'],
  ])('keeps a local directory plugin holding %s but fails the install', async (_label, content, extra) => {
    await withTempHome('safety-net-amp-personal', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const localDir = writeLocalDirectoryPlugin(homeDir, content, extra);

      await expect(installAmp(homeDir, artifactPath, makeAmpStub().run)).rejects.toThrow(
        'masks the personal plugin',
      );
      expect(readFileSync(join(localDir, 'index.ts'), 'utf-8')).toBe(content);

      await uninstallAmp(homeDir, makeAmpStub().run);
      expect(readFileSync(join(localDir, 'index.ts'), 'utf-8')).toBe(content);
    });
  });
});

describe('Amp personal install policy snapshot', () => {
  const POLICY_JSON = JSON.stringify({
    version: 1,
    safety: { level: 'strict', overrides: {} },
    destructive_command_protection: {
      enabled: true,
      overrides: { 'git.reset-hard': 'off', 'bogus.rule': 'off' },
      allow_paths: [],
    },
    smuggled: '";process.exit(1);//',
  });

  test('appends the normalized policy snapshot to the published artifact', async () => {
    await withTempHome('safety-net-amp-policy', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub();

      await installWithUserPolicy(homeDir, artifactPath, stub.run, POLICY_JSON);

      const stamp = stampedSuffix(stub.state.staged, artifactPath);
      expect(stamp).toBe(
        `;globalThis.__CC_SAFETY_NET_EMBEDDED_POLICY__ = ${JSON.stringify(
          normalizeGuiPolicy(JSON.parse(POLICY_JSON)),
        )};\n`,
      );
      // Normalization, not the raw file bytes, is what reaches the emitted code.
      expect(stamp).not.toContain('smuggled');
      expect(stamp).not.toContain('bogus.rule');
      expect(stamp).toContain('"level":"strict"');
    });
  });

  test.each([
    ['no policy file', undefined],
    ['an empty policy file', '  \n'],
    ['an unparseable policy file', '{ not json'],
    ['a policy file that is not a JSON object', '"paranoid"'],
  ])('publishes the bare artifact with %s', async (_label, policyJson) => {
    await withTempHome('safety-net-amp-policy', async (homeDir) => {
      const artifactPath = writeArtifactFixture(homeDir);
      const stub = makeAmpStub();

      await installWithUserPolicy(homeDir, artifactPath, stub.run, policyJson);

      expect(stub.state.staged).toBe(readFileSync(artifactPath, 'utf-8'));
    });
  });

  /** Publishes with POLICY_JSON, then reinstalls over a checkout already holding those bytes. */
  async function reinstallOverPublished(homeDir: string, policyJson: string) {
    const artifactPath = writeArtifactFixture(homeDir);
    const first = makeAmpStub();
    await installWithUserPolicy(homeDir, artifactPath, first.run, POLICY_JSON);

    const second = makeAmpStub({
      seedCheckout: (checkout) => writeCheckoutPlugin(checkout, String(first.state.staged)),
    });
    return {
      artifactPath,
      stub: second,
      result: await installWithUserPolicy(homeDir, artifactPath, second.run, policyJson),
    };
  }

  test('reports already installed when the checkout already holds the stamped artifact', async () => {
    await withTempHome('safety-net-amp-policy', async (homeDir) => {
      const reinstall = await reinstallOverPublished(homeDir, POLICY_JSON);

      expect(reinstall.result.alreadyInstalled).toBe(true);
      expect(gitCalls(reinstall.stub.calls)).toEqual([]);
    });
  });

  test('republishes after the user edits the policy file', async () => {
    await withTempHome('safety-net-amp-policy', async (homeDir) => {
      const reinstall = await reinstallOverPublished(
        homeDir,
        JSON.stringify({ version: 1, safety: { level: 'paranoid', overrides: {} } }),
      );

      expect(reinstall.result.alreadyInstalled).toBe(false);
      expect(gitCalls(reinstall.stub.calls)).toContain('git push origin HEAD');
      expect(stampedSuffix(reinstall.stub.state.staged, reinstall.artifactPath)).toContain(
        '"level":"paranoid"',
      );
    });
  });
});

describe('Amp personal uninstall', () => {
  test('removes, commits and pushes the managed file', async () => {
    await withTempHome('safety-net-amp-personal-uninstall', async (homeDir) => {
      const stub = makeAmpStub({
        seedCheckout: (checkout) => writeCheckoutPlugin(checkout, MANAGED_PLUGIN),
      });

      const result = await uninstallAmp(homeDir, stub.run);

      expect(result.alreadyInstalled).toBe(true);
      expect(result.path).toBe(`${CLONE_REF}/cc-safety-net`);
      expect(gitCalls(stub.calls)).toEqual([
        'git rm -- cc-safety-net/index.ts',
        'git status --porcelain',
        `git -c commit.gpgsign=false -c user.name=cc-safety-net -c user.email=cc-safety-net@localhost commit -m chore: remove cc-safety-net plugin v${getPackageVersion()}`,
        'git push origin HEAD',
      ]);
      expect(existsSync(String(stub.state.checkout))).toBe(false);
    });
  });

  test('reports not installed when the personal repository has no plugin', async () => {
    await withTempHome('safety-net-amp-personal-uninstall', async (homeDir) => {
      const stub = makeAmpStub();

      const result = await uninstallAmp(homeDir, stub.run);

      expect(result.alreadyInstalled).toBe(false);
      expect(gitCalls(stub.calls)).toEqual([]);
    });
  });

  test('refuses to remove an unmanaged file from the personal repository', async () => {
    await withTempHome('safety-net-amp-personal-uninstall', async (homeDir) => {
      const stub = makeAmpStub({
        seedCheckout: (checkout) => writeCheckoutPlugin(checkout, 'export default 1;\n'),
      });

      await expect(uninstallAmp(homeDir, stub.run)).rejects.toThrow(
        'Refusing to remove unmanaged file cc-safety-net/index.ts in your Amp personal plugins repository. Remove it there and rerun uninstall --amp.',
      );
      expect(gitCalls(stub.calls)).toEqual([]);
    });
  });

  test('removes only our entry from a plugin directory holding a file of the user', async () => {
    await withTempHome('safety-net-amp-personal-uninstall', async (homeDir) => {
      const stub = makeAmpStub({
        seedCheckout: seedCheckout({ plugin: MANAGED_PLUGIN, extra: '# notes\n' }),
      });

      const result = await uninstallAmp(homeDir, stub.run);

      expect(result.alreadyInstalled).toBe(true);
      expect(stub.state.extraAtStage).toBe(true);
      expect(gitCalls(stub.calls)).toContain('git rm -- cc-safety-net/index.ts');
    });
  });

  test('uninstalls the directory plugin and leaves an unmanaged legacy root file alone', async () => {
    await withTempHome('safety-net-amp-personal-uninstall', async (homeDir) => {
      const stub = makeAmpStub({
        seedCheckout: seedCheckout({ plugin: MANAGED_PLUGIN, legacy: 'export default 1;\n' }),
      });

      const result = await uninstallAmp(homeDir, stub.run);

      expect(result.alreadyInstalled).toBe(true);
      expect(result.path).toBe(`${CLONE_REF}/cc-safety-net`);
      expect(stub.state.legacyAtStage).toBe(true);
      expect(gitCalls(stub.calls)).toContain('git rm -- cc-safety-net/index.ts');
    });
  });

  test('removes a managed legacy root file when no directory plugin exists', async () => {
    await withTempHome('safety-net-amp-personal-uninstall', async (homeDir) => {
      const stub = makeAmpStub({ seedCheckout: seedCheckout({ legacy: MANAGED_PLUGIN }) });

      const result = await uninstallAmp(homeDir, stub.run);

      expect(result.alreadyInstalled).toBe(true);
      expect(result.path).toBe(`${CLONE_REF}/cc-safety-net.ts`);
      expect(gitCalls(stub.calls)).toContain('git rm -- cc-safety-net.ts');
    });
  });

  test('removes both the directory plugin and a managed legacy root file', async () => {
    await withTempHome('safety-net-amp-personal-uninstall', async (homeDir) => {
      const stub = makeAmpStub({
        seedCheckout: seedCheckout({ plugin: MANAGED_PLUGIN, legacy: MANAGED_PLUGIN }),
      });

      const result = await uninstallAmp(homeDir, stub.run);

      expect(result.path).toBe(`${CLONE_REF}/cc-safety-net`);
      expect(gitCalls(stub.calls)).toContain('git rm -- cc-safety-net/index.ts cc-safety-net.ts');
    });
  });

  test('also removes the managed local plugin and keeps an unmanaged one', async () => {
    await withTempHome('safety-net-amp-personal-uninstall', async (homeDir) => {
      const managed = writeLocalPlugin(homeDir, MANAGED_PLUGIN);
      await uninstallAmp(homeDir, makeAmpStub().run);
      expect(existsSync(managed)).toBe(false);

      writeLocalPlugin(homeDir, 'export default 1;\n');
      await uninstallAmp(homeDir, makeAmpStub().run);
      expect(readFileSync(managed, 'utf-8')).toBe('export default 1;\n');
    });
  });
});
