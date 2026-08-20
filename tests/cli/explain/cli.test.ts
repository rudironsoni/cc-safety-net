/**
 * Tests for the explain command CLI flag parsing.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  explainCommand,
  formatTraceHuman,
  formatTraceJson,
  parseExplainFlags,
} from '@/cli/explain/index';
import { runRuleCommand } from '@/cli/rule';
import {
  captureConsoleOutput,
  createLinkedWorktreeFixture,
  runCCSafetyNetCli as runSourceCli,
  withEnv,
  withTempDir,
} from '../../helpers.ts';

async function runExplainCli(args: string[], env?: Record<string, string>, cwd?: string) {
  const originalCwd = process.cwd();
  const captured = await captureConsoleOutput(() =>
    withEnv(env ?? {}, async () => {
      try {
        if (cwd) process.chdir(cwd);
        const flags = parseExplainFlags(args.slice(1));
        if (!flags) return 1;

        const result = explainCommand(flags.command, { cwd: flags.cwd });
        console.log(
          flags.json ? formatTraceJson(result) : formatTraceHuman(result, { asciiOnly: true }),
        );
        return 0;
      } finally {
        process.chdir(originalCwd);
      }
    }),
  );

  return {
    output: captured.stdout.length === 0 ? '' : `${captured.stdout.join('\n')}\n`,
    stderr: captured.stderr.length === 0 ? '' : `${captured.stderr.join('\n')}\n`,
    exitCode: captured.result,
  };
}

function writeGitRulebook(dir: string): void {
  mkdirSync(join(dir, '.cc-safety-net/rules', 'git-rules'), { recursive: true });
  writeFileSync(
    join(dir, '.cc-safety-net/rules', 'git-rules', 'rulebook.json'),
    JSON.stringify({
      rulebook_version: 1,
      name: 'git-rules',
      version: '1.0.0',
      allowed_commands: ['git'],
      rules: [
        {
          name: 'block-add-all',
          command: 'git',
          subcommand: 'add',
          block_args: ['-A', '--all', '.'],
          reason: 'Stage specific files.',
        },
      ],
      tests: [
        { command: 'git add -A', expect: 'blocked', rule: 'block-add-all' },
        { command: 'git status', expect: 'allowed' },
      ],
    }),
    'utf-8',
  );
}

async function explainJson(args: string[]) {
  return withTempDir('safety-net-explain-cli-', async (tempDir) => {
    const result = await runExplainCli(['explain', '--json', ...args], undefined, tempDir);
    return {
      parsed: JSON.parse(result.output),
      exitCode: result.exitCode,
    };
  });
}

async function withGitRulebook(
  fn: (tempDir: string, env: Record<string, string>) => Promise<void>,
) {
  await withTempDir('safety-net-explain-cli-', async (tempDir) => {
    const env = { HOME: join(tempDir, 'home') };
    writeGitRulebook(tempDir);
    const originalCwd = process.cwd();
    await captureConsoleOutput(() =>
      withEnv(env, async () => {
        try {
          process.chdir(tempDir);
          return await runRuleCommand(['add', 'git-rules']);
        } finally {
          process.chdir(originalCwd);
        }
      }),
    );
    await fn(tempDir, env);
  });
}

describe('explain CLI flag parsing', () => {
  test('explain preserves --debug in command when it appears after first positional arg', async () => {
    const { parsed, exitCode } = await explainJson(['echo', '--debug']);
    const parseStep = parsed.trace.steps.find((s: { type: string }) => s.type === 'parse');
    expect(parseStep.input).toBe('echo --debug');
    expect(exitCode).toBe(0);
  });

  test('explain preserves --json in command when after positional arg', async () => {
    const { parsed, exitCode } = await explainJson(['git', 'push', '--json']);
    const parseStep = parsed.trace.steps.find((s: { type: string }) => s.type === 'parse');
    expect(parseStep.input).toBe('git push --json');
    expect(exitCode).toBe(0);
  });

  test('explain with -- separator treats everything after as command', async () => {
    const { parsed, exitCode } = await explainJson(['--', '--debug']);
    const parseStep = parsed.trace.steps.find((s: { type: string }) => s.type === 'parse');
    expect(parseStep.input).toBe('--debug');
    expect(exitCode).toBe(0);
  });

  test('explain unknown flag is rejected on stderr', async () => {
    const result = await runExplainCli(['explain', '--jsoon', 'rm -rf /']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown option for explain: --jsoon');
    expect(result.output).toBe('');
  });

  test('explain --cwd rejects a path that does not exist', async () => {
    const result = await runExplainCli([
      'explain',
      '--cwd',
      '/definitely/not/here',
      '--json',
      'rm -rf /tmp/x',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--cwd path does not exist: /definitely/not/here');
    expect(result.output).toBe('');
  });

  test('bare explain exits nonzero with usage on stderr', async () => {
    const result = await runExplainCli(['explain']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No command provided');
    expect(result.stderr).toContain('Usage: cc-safety-net explain');
    expect(result.output).toBe('');
  });

  test('explain single-arg command with pipe preserves shell operators', async () => {
    // `rm -rf /` now short-circuits at policy-config protection before the parse trace; use an
    // escaping rm that reaches command analysis so the pipe still produces a parse step.
    const { parsed, exitCode } = await explainJson(['git status | rm -rf ../outside']);
    const parseStep = parsed.trace.steps.find((s: { type: string }) => s.type === 'parse');
    expect(parseStep.input).toBe('git status | rm -rf ../outside');
    expect(parseStep.segments).toEqual([
      ['git', 'status'],
      ['rm', '-rf', '../outside'],
    ]);
    expect(parsed.result).toBe('blocked');
    expect(exitCode).toBe(0);
  });

  test('explain --json blocks a sensitive-path read via secret protection', async () => {
    await withTempDir('safety-net-explain-cli-', async (tempDir) => {
      // `.env` matches by basename regardless of cwd; isolate HOME so the user's real policy
      // (which could disable secret protection) is never read. `cat .env` is analyzer input
      // only and is never executed.
      const result = await runExplainCli(
        ['explain', '--json', 'cat .env'],
        { HOME: join(tempDir, 'home') },
        tempDir,
      );
      const parsed = JSON.parse(result.output);
      expect(parsed.result).toBe('blocked');
      expect(parsed.ruleId).toBe('secret.basename.env');
      expect(result.exitCode).toBe(0);
    });
  });

  test('explain --cwd <path> passes cwd to analysis', async () => {
    await withTempDir('safety-net-explain-', async (tempDir) => {
      const { parsed, exitCode } = await explainJson(['--cwd', tempDir, 'rm -rf ./foo']);
      expect(parsed.result).toBe('allowed');
      expect(exitCode).toBe(0);
    });
  });

  test('explain --json reports worktree relaxation', async () => {
    const fixture = createLinkedWorktreeFixture();
    try {
      const proc = Bun.spawn(
        [
          'bun',
          'src/cli/cc-safety-net.ts',
          'explain',
          '--json',
          '--cwd',
          fixture.linkedWorktree,
          'git reset --hard',
        ],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            HOME: join(fixture.mainWorktree, 'home'),
            SAFETY_NET_WORKTREE: '1',
          },
        },
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      const parsed = JSON.parse(output);
      const worktreeStep = parsed.trace.segments
        .flatMap((s: { steps: Array<{ type: string }> }) => s.steps)
        .find((s: { type: string }) => s.type === 'worktree-relaxation');
      expect(parsed.result).toBe('allowed');
      expect(worktreeStep).toBeDefined();
      expect(exitCode).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  test('explain --json reports rulebook-backed custom rule metadata', async () => {
    await withGitRulebook(async (tempDir, env) => {
      const result = await runExplainCli(['explain', '--json', 'git', 'add', '-A'], env, tempDir);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output).customRule).toEqual({
        id: 'git-rules/block-add-all',
        rulebook: { name: 'git-rules', version: '1.0.0' },
        source: 'git-rules',
      });
    });
  });

  test('explain human output reports rulebook-backed custom rule metadata', async () => {
    await withGitRulebook(async (tempDir, env) => {
      const result = await runSourceCli(['explain', 'git', 'add', '-A'], env, tempDir);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Rule: git-rules/block-add-all');
      expect(result.output).toContain('Rulebook: git-rules 1.0.0');
      expect(result.output).toContain('Source: git-rules');
    });
  });

  test('explain --json reports custom rule reason override metadata', async () => {
    await withGitRulebook(async (tempDir, env) => {
      const configPath = join(tempDir, '.cc-safety-net/rules', 'rule.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          ...JSON.parse(readFileSync(configPath, 'utf-8')),
          overrides: {
            'git-rules/block-add-all': { reason: 'Stage precise files.' },
          },
        }),
        'utf-8',
      );

      const result = await runExplainCli(['explain', '--json', 'git', 'add', '-A'], env, tempDir);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output).customRule.override).toEqual({
        type: 'reason',
        reason: 'Stage precise files.',
      });
    });
  });

  test('explain --cwd without path shows error', async () => {
    const result = await runExplainCli(['explain', '--cwd']);

    expect(result.stderr).toContain('--cwd requires a value');
    expect(result.exitCode).toBe(1);
  });

  test('explain --cwd with following flag shows error', async () => {
    const proc = Bun.spawn(
      ['bun', 'src/cli/cc-safety-net.ts', 'explain', '--cwd', '--json', 'echo hello'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stderr).toContain('--cwd requires a value');
    expect(exitCode).toBe(1);
  });
});

describe('explain CLI analysis limits', () => {
  // A self-recursive function definition exhausts the structural analysis budget. It is only
  // ever passed as a CLI argument for analysis and is never executed by a shell.
  const recursionBomb = 'loop() { loop; }; loop';

  test('explain --json reports an analysis limit as JSON instead of a stack trace', async () => {
    await withTempDir('safety-net-explain-limit-', async (tempDir) => {
      const result = await runSourceCli(
        ['explain', '--json', '--cwd', tempDir, recursionBomb],
        { HOME: join(tempDir, 'home') },
        tempDir,
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output).error).toBe('Structural command analysis limit exceeded.');
      expect(result.stderr).not.toContain('StructuralShellSyntaxLimitError');
      expect(result.stderr).not.toContain('\n    at ');
    });
  });

  test('explain human output reports an analysis limit without a stack trace', async () => {
    await withTempDir('safety-net-explain-limit-', async (tempDir) => {
      const result = await runSourceCli(
        ['explain', '--cwd', tempDir, recursionBomb],
        { HOME: join(tempDir, 'home') },
        tempDir,
      );

      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('');
      expect(result.stderr).toBe('Structural command analysis limit exceeded.\n');
    });
  });
});
