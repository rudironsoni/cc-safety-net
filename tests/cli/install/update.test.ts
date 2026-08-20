import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { runUpdateCommand } from '@/cli/install';
import { AMP_MANAGED_HEADER } from '@/integrations/amp/artifact';
import { getCursorHooksPath } from '@/integrations/cursor/install';
import { captureConsoleOutput, withEnv } from '../../helpers';
import { makeTempHome, runCli } from '../../integrations/hook-helpers';
import {
  makeLoggedFakeCommandHome,
  writeClaudePluginRecords,
  writeFakeCommands,
} from '../../integrations/install/install-test-helpers';
import { createLolcatOutput, stripAnsi } from '../lolcat-test-helpers';

function writeCursorHook(homeDir: string) {
  const path = getCursorHooksPath(homeDir);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      hooks: {
        preToolUse: [
          {
            command: 'npx -y cc-safety-net hook --cursor',
            timeout: 30,
            failClosed: true,
          },
        ],
      },
    }),
  );
  return path;
}

function makeFakeBinHome(name: string, commands: readonly string[]) {
  const fake = makeLoggedFakeCommandHome(name, commands);
  return {
    ...fake,
    path: [fake.binDir, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
  };
}

function normalizedCommandLog(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((entry) => entry.replace(/^.*\/bin\//, ''));
}

async function expectUpdateFindsNothing(homeDir: string, cwd?: string) {
  try {
    const result = await runUpdate({ homeDir, path: dirname(process.execPath), cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'No installed integrations found. Run `cc-safety-net install` to set one up.',
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

let directUpdateQueue = Promise.resolve();

function runUpdate(options: {
  homeDir: string;
  path: string;
  logPath?: string;
  cwd?: string;
  isTTY?: boolean;
}) {
  const execute = async () => {
    const originalCwd = process.cwd();
    // A non-TTY input keeps the banner off the real stdin (no raw mode, no keypress listener).
    const { chunks, output } = createLolcatOutput(options.isTTY ?? false);
    try {
      if (options.cwd) process.chdir(options.cwd);
      const { result, stderr } = await captureConsoleOutput(() =>
        withEnv(
          {
            HOME: options.homeDir,
            PATH: options.path,
            ...(options.logPath ? { CC_SAFETY_NET_TEST_COMMAND_LOG: options.logPath } : {}),
          },
          () =>
            runUpdateCommand([], {
              input: { isTTY: false } as unknown as NodeJS.ReadStream,
              output: output as unknown as NodeJS.WriteStream,
            }),
        ),
      );
      return {
        exitCode: result,
        stdout: stripAnsi(chunks.join('')).trimEnd(),
        stderr: stderr.join('\n'),
      };
    } finally {
      process.chdir(originalCwd);
    }
  };
  const result = directUpdateQueue.then(execute);
  directUpdateQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function expectCodexLegacyMigration(fake: ReturnType<typeof makeFakeBinHome>) {
  try {
    const result = await runUpdate(fake);

    expect(result.exitCode).toBe(0);
    expect(normalizedCommandLog(fake.logPath)).toEqual([
      'codex plugin list',
      'codex --version',
      'codex plugin marketplace add kenryu42/cc-marketplace',
      'codex plugin add cc-safety-net@cc-marketplace',
      'codex plugin remove safety-net@cc-marketplace',
    ]);
    expect(result.stdout).toContain('Updated Codex integration');
    expect(result.stderr).toBe('');
  } finally {
    rmSync(fake.homeDir, { recursive: true, force: true });
  }
}

describe('update command', () => {
  test('updates a configured Claude Code integration', async () => {
    const fake = makeFakeBinHome('safety-net-update-claude', ['claude']);
    writeClaudePluginRecords(fake.homeDir, ['cc-safety-net@cc-marketplace'], {
      enableByDefault: true,
    });

    try {
      const result = await runUpdate(fake);

      expect(result.exitCode).toBe(0);
      expect(normalizedCommandLog(fake.logPath)).toEqual([
        'claude --version',
        'claude plugin marketplace update cc-marketplace',
        'claude plugin update cc-safety-net@cc-marketplace',
      ]);
      expect(result.stdout).toContain('Updated Claude Code integration');
    } finally {
      rmSync(fake.homeDir, { recursive: true, force: true });
    }
  });

  test('updates and re-enables a disabled Claude Code integration', async () => {
    const fake = makeFakeBinHome('safety-net-update-disabled-claude', ['claude']);
    writeClaudePluginRecords(fake.homeDir, ['cc-safety-net@cc-marketplace'], {
      enabled: { 'cc-safety-net@cc-marketplace': false },
      enableByDefault: true,
    });

    try {
      const result = await runUpdate(fake);

      expect(result.exitCode).toBe(0);
      expect(normalizedCommandLog(fake.logPath)).toEqual([
        'claude --version',
        'claude plugin marketplace update cc-marketplace',
        'claude plugin update cc-safety-net@cc-marketplace',
        'claude plugin enable cc-safety-net@cc-marketplace',
      ]);
      expect(result.stdout).toContain('Updated Claude Code integration');
    } finally {
      rmSync(fake.homeDir, { recursive: true, force: true });
    }
  });

  test('ignores a repo-level Copilot hooks kill-switch with no plugin installed', async () => {
    const homeDir = makeTempHome('safety-net-update-copilot-veto');
    const cwd = join(homeDir, 'repo');
    mkdirSync(join(cwd, '.github', 'copilot'), { recursive: true });
    writeFileSync(
      join(cwd, '.github', 'copilot', 'settings.json'),
      JSON.stringify({ disableAllHooks: true }),
    );

    await expectUpdateFindsNothing(homeDir, cwd);
  });

  test('migrates a legacy-only Claude Code integration', async () => {
    const fake = makeFakeBinHome('safety-net-update-legacy-claude', ['claude']);
    writeClaudePluginRecords(fake.homeDir, ['safety-net@cc-marketplace'], {
      enableByDefault: true,
    });

    try {
      const result = await runUpdate(fake);

      expect(result.exitCode).toBe(0);
      expect(normalizedCommandLog(fake.logPath)).toEqual([
        'claude --version',
        'claude plugin marketplace add kenryu42/cc-marketplace',
        'claude plugin marketplace update cc-marketplace',
        'claude plugin install cc-safety-net@cc-marketplace',
        'claude plugin uninstall safety-net@cc-marketplace',
      ]);
      expect(result.stdout).toContain('Updated Claude Code integration');
    } finally {
      rmSync(fake.homeDir, { recursive: true, force: true });
    }
  });

  test('migrates a legacy-only Codex integration', async () => {
    const fake = makeFakeBinHome('safety-net-update-legacy-codex', ['codex']);
    writeFileSync(
      join(fake.homeDir, 'bin', 'codex'),
      `#!/usr/bin/env sh
printf '%s\n' "$0 $*" >> "$CC_SAFETY_NET_TEST_COMMAND_LOG"
if [ "$*" = "plugin list" ]; then
  printf 'safety-net@cc-marketplace https://github.com/kenryu42/cc-safety-net.git installed, enabled\n'
fi
`,
    );

    await expectCodexLegacyMigration(fake);
  });

  test('detects a legacy-only Copilot CLI plugin from the filesystem', async () => {
    const fake = makeFakeBinHome('safety-net-update-legacy-copilot', ['copilot']);
    mkdirSync(
      join(fake.homeDir, '.copilot', 'installed-plugins', '_direct', 'copilot-safety-net'),
      { recursive: true },
    );
    writeFileSync(
      join(fake.homeDir, 'bin', 'copilot'),
      `#!/usr/bin/env sh
printf '%s\n' "$0 $*" >> "$CC_SAFETY_NET_TEST_COMMAND_LOG"
if [ "$*" = "plugin list" ]; then
  printf 'Installed plugins:\n  copilot-safety-net (v1.0.0)\n'
fi
`,
    );

    try {
      const result = await runUpdate(fake);

      expect(result.exitCode).toBe(0);
      expect(normalizedCommandLog(fake.logPath)).toEqual([
        'copilot --binary-version',
        'copilot --binary-version',
        'copilot plugin list',
        'copilot plugin marketplace list',
        'copilot plugin marketplace add kenryu42/cc-marketplace',
        'copilot plugin install cc-safety-net@cc-marketplace',
        'copilot plugin uninstall copilot-safety-net',
      ]);
      expect(result.stdout).toContain('Updated GitHub Copilot CLI integration');
    } finally {
      rmSync(fake.homeDir, { recursive: true, force: true });
    }
  });

  test('migrates a pre-rename Copilot CLI plugin from the marketplace checkout', async () => {
    const fake = makeFakeBinHome('safety-net-update-prerename-copilot', ['copilot']);
    mkdirSync(join(fake.homeDir, '.copilot', 'installed-plugins', 'cc-marketplace', 'safety-net'), {
      recursive: true,
    });
    writeFileSync(
      join(fake.homeDir, 'bin', 'copilot'),
      `#!/usr/bin/env sh
printf '%s\n' "$0 $*" >> "$CC_SAFETY_NET_TEST_COMMAND_LOG"
if [ "$*" = "plugin list" ]; then
  printf 'Installed plugins:\n  • safety-net@cc-marketplace (v1.0.6)\n'
fi
if [ "$*" = "plugin marketplace list" ]; then
  printf 'Registered marketplaces:\n  • cc-marketplace (GitHub: kenryu42/cc-marketplace)\n'
fi
`,
    );

    try {
      const result = await runUpdate(fake);

      expect(result.exitCode).toBe(0);
      expect(normalizedCommandLog(fake.logPath)).toEqual([
        'copilot --binary-version',
        'copilot --binary-version',
        'copilot plugin list',
        'copilot plugin marketplace list',
        'copilot plugin marketplace update cc-marketplace',
        'copilot plugin install cc-safety-net@cc-marketplace',
        'copilot plugin uninstall safety-net@cc-marketplace',
      ]);
      expect(result.stdout).toContain('Updated GitHub Copilot CLI integration');
    } finally {
      rmSync(fake.homeDir, { recursive: true, force: true });
    }
  });

  test('tolerates a stale legacy Claude Code plugin record', async () => {
    const fake = makeFakeBinHome('safety-net-update-stale-legacy-claude', ['claude']);
    writeClaudePluginRecords(
      fake.homeDir,
      ['cc-safety-net@cc-marketplace', 'safety-net@cc-marketplace'],
      { enableByDefault: true },
    );
    writeFileSync(
      join(fake.homeDir, 'bin', 'claude'),
      `#!/usr/bin/env sh
printf '%s\n' "$0 $*" >> "$CC_SAFETY_NET_TEST_COMMAND_LOG"
if [ "$*" = "plugin uninstall safety-net@cc-marketplace" ]; then
  echo "Plugin \\"safety-net@cc-marketplace\\" not found in installed plugins" >&2
  exit 1
fi
`,
    );

    try {
      const result = await runUpdate(fake);

      expect(result.exitCode).toBe(0);
      expect(normalizedCommandLog(fake.logPath)).toEqual([
        'claude --version',
        'claude plugin marketplace update cc-marketplace',
        'claude plugin update cc-safety-net@cc-marketplace',
        'claude plugin uninstall safety-net@cc-marketplace',
      ]);
      expect(result.stdout).toContain('Updated Claude Code integration');
      expect(result.stderr).toContain('claude plugin uninstall safety-net@cc-marketplace');
    } finally {
      rmSync(fake.homeDir, { recursive: true, force: true });
    }
  });

  test('detects a Codex integration whose plugin list is slower than the version probe timeout', async () => {
    const fake = makeFakeBinHome('safety-net-update-slow-codex', ['codex']);
    writeFileSync(
      join(fake.homeDir, 'bin', 'codex'),
      `#!/usr/bin/env sh
printf '%s\n' "$0 $*" >> "$CC_SAFETY_NET_TEST_COMMAND_LOG"
if [ "$*" = "plugin list" ]; then
  if [ ! -f "$HOME/.codex-slept" ]; then
    touch "$HOME/.codex-slept"
    sleep 6
  fi
  printf 'safety-net@cc-marketplace https://github.com/kenryu42/cc-safety-net.git installed, enabled\n'
fi
`,
    );

    await expectCodexLegacyMigration(fake);
  }, 20000);

  test('skips a configured native integration when its CLI is missing', async () => {
    const homeDir = makeTempHome('safety-net-update-missing-cli');
    writeClaudePluginRecords(homeDir, ['cc-safety-net@cc-marketplace'], {
      enableByDefault: true,
    });

    try {
      const result = await runUpdate({ homeDir, path: dirname(process.execPath) });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Claude Code not found; skipped');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('updates a configured file integration without its CLI', async () => {
    const homeDir = makeTempHome('safety-net-update-cursor');
    const configPath = writeCursorHook(homeDir);

    try {
      const result = await runUpdate({ homeDir, path: dirname(process.execPath) });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`Cursor hook up to date in ${configPath}`);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('updates the Amp plugin in the personal plugins repository', async () => {
    const homeDir = makeTempHome('safety-net-update-amp');
    // A leftover managed system-scope plugin masks the personal one, so update clears it.
    const maskingPath = join(homeDir, '.config', 'amp', 'plugins', 'cc-safety-net.ts');
    mkdirSync(join(maskingPath, '..'), { recursive: true });
    writeFileSync(maskingPath, `${AMP_MANAGED_HEADER}\n// stale artifact\n`);
    const binDir = writeFakeCommands(homeDir, {
      // Personal-scope plugin line, repositories preflight, and a clone that leaves the
      // throwaway checkout empty. No network and no real Amp repository is involved.
      amp: [
        'case "$1 $2" in',
        '  "plugins list") printf \'\\342\\234\\223 cc-safety-net (User Plugins) active\\n\' ;;',
        '  "plugins repositories") printf \'[{"scope":"user","exists":true,"viewerCanWrite":true,"cloneRef":"tester/-/plugins"}]\\n\' ;;',
        'esac',
      ].join('\n'),
      // Only `git status --porcelain` needs a real answer: the modified directory-plugin entry
      // means the artifact is staged, so `commitAndPush` proceeds to commit and push.
      git: [
        'case "$1 $2" in',
        '  "status --porcelain") printf \'%s\\n\' "M  cc-safety-net/index.ts" ;;',
        'esac',
      ].join('\n'),
    });

    try {
      const result = await runUpdate({
        homeDir,
        path: [binDir, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated Amp Code plugin at tester/-/plugins/cc-safety-net');
      expect(result.stdout).toContain('including Orb threads');
      expect(existsSync(maskingPath)).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('reports when no installed integration is found', async () => {
    await expectUpdateFindsNothing(makeTempHome('safety-net-update-none'));
  });

  test('continues with the remaining targets after a target failure', async () => {
    const fake = makeFakeBinHome('safety-net-update-failure', ['claude', 'codex']);
    writeClaudePluginRecords(fake.homeDir, ['cc-safety-net@cc-marketplace'], {
      enableByDefault: true,
    });
    writeFileSync(
      join(fake.homeDir, 'bin', 'claude'),
      `#!/usr/bin/env sh
printf '%s\n' "$0 $*" >> "$CC_SAFETY_NET_TEST_COMMAND_LOG"
if [ "$*" = "plugin marketplace update cc-marketplace" ]; then
  exit 42
fi
`,
    );
    writeFileSync(
      join(fake.homeDir, 'bin', 'codex'),
      `#!/usr/bin/env sh
printf '%s\n' "$0 $*" >> "$CC_SAFETY_NET_TEST_COMMAND_LOG"
if [ "$*" = "plugin list" ]; then
  printf 'cc-safety-net@cc-marketplace https://github.com/kenryu42/cc-safety-net.git installed, enabled\n'
fi
`,
    );

    try {
      const result = await runUpdate(fake);

      expect(result.exitCode).toBe(1);
      expect(normalizedCommandLog(fake.logPath)).toContain(
        'codex plugin marketplace upgrade cc-marketplace',
      );
      expect(result.stderr).toContain('claude plugin marketplace update cc-marketplace');
      expect(result.stdout).toContain('Updated Codex integration');
    } finally {
      rmSync(fake.homeDir, { recursive: true, force: true });
    }
  });

  test('updates independent targets concurrently', async () => {
    const fake = makeFakeBinHome('safety-net-update-parallel', ['claude', 'codex']);
    writeClaudePluginRecords(fake.homeDir, ['cc-safety-net@cc-marketplace'], {
      enableByDefault: true,
    });
    // Claude Code runs before Codex in canonical order, and here it only finishes once Codex
    // signals that it started, so this passes only when the two targets run concurrently.
    writeFileSync(
      join(fake.homeDir, 'bin', 'claude'),
      `#!/usr/bin/env sh
printf '%s\n' "$0 $*" >> "$CC_SAFETY_NET_TEST_COMMAND_LOG"
if [ "$*" = "plugin marketplace update cc-marketplace" ]; then
  i=0
  while [ $i -lt 50 ]; do
    if [ -f "$HOME/.codex-running" ]; then
      exit 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  exit 42
fi
`,
    );
    writeFileSync(
      join(fake.homeDir, 'bin', 'codex'),
      `#!/usr/bin/env sh
printf '%s\n' "$0 $*" >> "$CC_SAFETY_NET_TEST_COMMAND_LOG"
if [ "$*" = "plugin list" ]; then
  printf 'cc-safety-net@cc-marketplace https://github.com/kenryu42/cc-safety-net.git installed, enabled\n'
fi
if [ "$*" = "plugin marketplace upgrade cc-marketplace" ]; then
  touch "$HOME/.codex-running"
fi
`,
    );

    try {
      const result = await runUpdate(fake);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated Claude Code integration');
      expect(result.stdout).toContain('Updated Codex integration');
    } finally {
      rmSync(fake.homeDir, { recursive: true, force: true });
    }
  }, 20000);

  test('clears a stale npx cache entry while updating', async () => {
    const homeDir = makeTempHome('safety-net-update-npx-cache');
    writeCursorHook(homeDir);
    const cacheEntry = join(homeDir, '.npm', '_npx', 'a1b2c3');
    mkdirSync(join(cacheEntry, 'node_modules', 'cc-safety-net'), { recursive: true });

    try {
      const result = await runUpdate({ homeDir, path: dirname(process.execPath) });

      expect(result.exitCode).toBe(0);
      expect(existsSync(cacheEntry)).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('fails only npx-cache targets when the cache cannot be cleared', async () => {
    const fake = makeFakeBinHome('safety-net-update-npx-clear-failure', ['claude']);
    writeCursorHook(fake.homeDir);
    writeClaudePluginRecords(fake.homeDir, ['cc-safety-net@cc-marketplace'], {
      enableByDefault: true,
    });
    // A file where the cache directory belongs: existsSync passes, readdirSync throws ENOTDIR.
    mkdirSync(join(fake.homeDir, '.npm'), { recursive: true });
    writeFileSync(join(fake.homeDir, '.npm', '_npx'), 'not a directory');

    try {
      const result = await runUpdate(fake);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Updated Claude Code integration');
      expect(result.stdout).not.toContain('Cursor hook up to date');
      expect(result.stderr).toContain('Check that every parent path component is a directory');
    } finally {
      rmSync(fake.homeDir, { recursive: true, force: true });
    }
  });

  test('prints the install banner before the reports on a TTY', async () => {
    const fake = makeFakeBinHome('safety-net-update-banner', ['claude']);
    writeClaudePluginRecords(fake.homeDir, ['cc-safety-net@cc-marketplace'], {
      enableByDefault: true,
    });

    try {
      // Spinner frames race the real update, so only the banner and the report are asserted.
      const result = await runUpdate({ ...fake, isTTY: true });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('┏━┛┏━┛  ┏━┛┏━┃┏━┛┏━┛━┏┛┃ ┃  ┏━ ┏━┛━┏┛');
      expect(result.stdout.indexOf('┏━┛┏━┛')).toBeLessThan(
        result.stdout.indexOf('Updated Claude Code integration'),
      );
    } finally {
      rmSync(fake.homeDir, { recursive: true, force: true });
    }
  });

  test('rejects arguments and options', async () => {
    const unexpected = await runCli(['update', 'extra']);
    const unknownOption = await runCli(['update', '--codex']);

    expect(unexpected.exitCode).toBe(1);
    expect(unexpected.stderr).toContain('Unexpected argument for update: extra');
    expect(unknownOption.exitCode).toBe(1);
    expect(unknownOption.stderr).toContain('Unknown option for update: --codex');
  });
});
