import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import {
  analyzeAwkSystemCallMatch,
  extractAwkSystemCommands,
  parseAwkArgv,
  REASON_AWK_SYSTEM_DYNAMIC,
} from '@/analyzer/awk';
import { analyzeChildCommandMatch } from '@/analyzer/child-analyzer';
import { textCommandWords } from '@/analyzer/command-words';
import { type AnalyzeFindContext, analyzeFindMatch } from '@/analyzer/find';
import { TEST_ENVIRONMENT } from '../helpers/environment';
import {
  analyzeTestCommand as analyzeCommand,
  type TestPolicyInput as Config,
} from '../helpers/policy';
import {
  blockedSegment,
  createLinkedWorktreeFixture,
  toShellPath,
  withEnv,
  withLinkedWorktreeFixture,
} from '../helpers.ts';

const analyzeAwkSystemCalls = (
  tokens: readonly string[],
  analyzeNested: (command: string) => string | null,
) =>
  analyzeAwkSystemCallMatch(tokens, (command) => {
    const reason = analyzeNested(command);
    return reason ? { id: '', reason, intent: 'manual_only' } : null;
  })?.reason ?? null;

const analyzeChildCommand = (...args: Parameters<typeof analyzeChildCommandMatch>) =>
  analyzeChildCommandMatch(...args)?.reason ?? null;

const analyzeFind = (tokens: readonly string[], context: AnalyzeFindContext) =>
  analyzeFindMatch(textCommandWords(tokens), context)?.reason ?? null;

const EMPTY_CONFIG: Config = { version: 1, rules: [] };
const BLOCK_GIT_COMMIT_CONFIG: Config = {
  version: 1,
  rules: [
    {
      name: 'block-git-commit',
      command: 'git',
      subcommand: 'commit',
      block_args: ['commit'],
      reason: 'Commit creation must be explicit.',
    },
  ],
};
const TRANSPARENT_RTK_GIT_COMMIT_CONFIG: Config = {
  ...BLOCK_GIT_COMMIT_CONFIG,
  transparent_wrappers: ['rtk'],
};
const TRANSPARENT_RTK_CONFIG: Config = {
  version: 1,
  rules: [],
  transparent_wrappers: ['rtk'],
};
const TRANSPARENT_RTK_DOCKER_PRUNE_CONFIG: Config = {
  version: 1,
  transparent_wrappers: ['rtk'],
  rules: [
    {
      name: 'block-docker-prune',
      command: 'docker',
      subcommand: 'system',
      block_args: ['prune'],
      reason: 'Use targeted Docker cleanup.',
    },
  ],
};

async function analyzeInLinkedWorktree(command: (mainWorktree: string) => string) {
  return withLinkedWorktreeFixture((fixture) =>
    withEnv({ SAFETY_NET_WORKTREE: '1' }, () =>
      analyzeCommand(command(toShellPath(fixture.mainWorktree)), {
        cwd: fixture.linkedWorktree,
        config: EMPTY_CONFIG,
        worktreeMode: true,
      }),
    ),
  );
}

describe('analyzeCommand (coverage)', () => {
  test('unclosed-quote cd segment handled', () => {
    // Ensures cwd-tracking fallback runs for unparseable cd segments.
    expect(
      analyzeCommand('cd "unterminated', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      }),
    ).toBeNull();
  });

  test('empty head token returns null', () => {
    expect(
      analyzeCommand('""', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      }),
    ).toBeNull();
  });

  test('rm -rf in home cwd is blocked with dedicated message', () => {
    const result = analyzeCommand('rm -rf build', {
      cwd: homedir(),
      config: EMPTY_CONFIG,
    });
    expect(result?.reason).toContain('rm -rf in home directory');
  });

  test('built-in destructive match includes rule id and intent', () => {
    const result = analyzeCommand('git push --force', {
      cwd: '/tmp',
      config: EMPTY_CONFIG,
    });
    expect(result?.ruleId).toBe('git.push-force');
    expect(result?.intent).toBe('use_alternative');
  });

  test('rm without -rf in home cwd is not blocked by home cwd guard', () => {
    expect(
      analyzeCommand('rm -f file.txt', {
        cwd: homedir(),
        config: EMPTY_CONFIG,
      }),
    ).toBeNull();
  });

  test('custom rules can block rm after builtin allow', () => {
    const config: Config = {
      version: 1,
      rules: [
        {
          name: 'block-rm-rf',
          command: 'rm',
          block_args: ['-rf'],
          reason: 'No rm -rf.',
        },
      ],
    };
    const result = analyzeCommand('rm -rf /tmp/test-dir', {
      cwd: '/tmp',
      config,
    });
    expect(result?.reason).toContain('[block-rm-rf] No rm -rf.');
    expect(result?.ruleId).toBe('custom.block-rm-rf');
    expect(result?.intent).toBe('manual_only');
  });

  test('custom rule intent is included in blocked result', () => {
    const result = analyzeCommand('docker system prune', {
      cwd: '/tmp',
      config: {
        version: 1,
        rules: [
          {
            name: 'block-docker-prune',
            command: 'docker',
            subcommand: 'system',
            block_args: ['prune'],
            reason: 'Docker prune can delete shared cache. Use targeted cleanup instead.',
            intent: 'use_alternative',
          },
        ],
      },
    });
    expect(result?.ruleId).toBe('custom.block-docker-prune');
    expect(result?.intent).toBe('use_alternative');
  });

  test('custom rules can block find after builtin allow', () => {
    const config: Config = {
      version: 1,
      rules: [
        {
          name: 'block-find-print',
          command: 'find',
          block_args: ['-print'],
          reason: 'Avoid find -print in tests.',
        },
      ],
    };
    const result = analyzeCommand('find . -print', { cwd: '/tmp', config });
    expect(result?.reason).toContain('[block-find-print] Avoid find -print in tests.');
  });

  test('fallback scan catches embedded rm', () => {
    const result = analyzeCommand('tool rm -rf /', {
      cwd: '/tmp',
      config: EMPTY_CONFIG,
    });
    expect(result?.reason).toContain('extremely dangerous');
  });

  test('fallback scan ignores embedded rm when analyzeRm allows it', () => {
    expect(
      analyzeCommand('tool rm -rf /tmp/a', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      }),
    ).toBeNull();
  });

  test('fallback scan catches embedded git', () => {
    const result = analyzeCommand('tool git reset --hard', {
      cwd: '/tmp',
      config: EMPTY_CONFIG,
    });
    expect(result?.reason).toContain('git reset --hard');
  });

  test('awk system parser allows safe static commands', () => {
    expect(analyzeAwkSystemCalls(['awk', 'BEGIN { system("echo ok") }'], () => null)).toBeNull();
  });

  test('awk system parser handles escaped static strings', () => {
    const commands: string[] = [];
    const result = analyzeAwkSystemCalls(
      ['awk', 'BEGIN { system("echo \\"ok\\"") }'],
      (command) => {
        commands.push(command);
        return null;
      },
    );
    expect(result).toBeNull();
    expect(commands).toEqual(['echo "ok"']);
  });

  test('awk system parser decodes hex and octal escapes', () => {
    const commands: string[] = [];
    const result = analyzeAwkSystemCalls(
      ['awk', 'BEGIN { system("rm\\x20-rf\\040/") }'],
      (command) => {
        commands.push(command);
        return 'blocked';
      },
    );

    expect(result).toBe('blocked');
    expect(commands).toEqual(['rm -rf /']);
  });

  test('awk system parser treats trailing escapes as dynamic', () => {
    expect(analyzeAwkSystemCalls(['awk', `BEGIN { system("echo \\`], () => null)).toBe(
      REASON_AWK_SYSTEM_DYNAMIC,
    );
  });

  test('awk system parser blocks unclosed string commands', () => {
    expect(analyzeAwkSystemCalls(['awk', 'BEGIN { system("rm -rf /) }'], () => null)).toBe(
      REASON_AWK_SYSTEM_DYNAMIC,
    );
  });

  test('awk system parser blocks concatenated string commands', () => {
    expect(analyzeAwkSystemCalls(['awk', 'BEGIN { system("rm " $1) }'], () => null)).toBe(
      REASON_AWK_SYSTEM_DYNAMIC,
    );
  });

  test('awk system parser ignores identifiers containing system', () => {
    expect(
      analyzeAwkSystemCalls(['awk', 'BEGIN { subsystem("rm -rf /") }'], () => null),
    ).toBeNull();
  });

  test('awk argv parsing recognizes attached source and program-file options', () => {
    expect(
      parseAwkArgv([
        'awk',
        '--source=BEGIN { print 1 }',
        '-e{ print 2 }',
        '-fprogram.awk',
        'input.txt',
      ]),
    ).toEqual({
      sources: [
        { tokenIndex: 1, kind: 'inline-code', value: 'BEGIN { print 1 }' },
        { tokenIndex: 2, kind: 'inline-code', value: '{ print 2 }' },
        { tokenIndex: 3, kind: 'program-file', value: 'program.awk' },
      ],
      optionsOpen: false,
    });
    for (const option of ['-e', '-f', '-v']) {
      expect(parseAwkArgv(['awk', option]), option).toEqual({ sources: [], optionsOpen: false });
    }
  });

  test('awk source scanning ignores system text in comments and regex literals', () => {
    expect(
      extractAwkSystemCommands('# system("rm -rf /")\nBEGIN { /system/; system("echo ok") }'),
    ).toEqual({ dynamic: false, commands: ['echo ok'] });
  });

  test('fallback scan ignores embedded git when safe', () => {
    expect(
      analyzeCommand('tool git status', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      }),
    ).toBeNull();
  });

  test('transparent wrapper is inert without config', () => {
    expect(
      analyzeCommand('rtk git commit -m msg', {
        cwd: '/tmp',
        config: BLOCK_GIT_COMMIT_CONFIG,
      }),
    ).toBeNull();
  });

  test('transparent wrapper lets custom git rules inspect child command', () => {
    const result = analyzeCommand('rtk git commit -m msg', {
      cwd: '/tmp',
      config: TRANSPARENT_RTK_GIT_COMMIT_CONFIG,
    });
    expect(result?.reason).toContain('[block-git-commit] Commit creation must be explicit.');
    expect(blockedSegment(result)).toBe('rtk git commit -m msg');
  });

  test('transparent wrapper lets built-in git analyzer inspect child command', () => {
    const result = analyzeCommand('rtk git reset --hard', {
      cwd: '/tmp',
      config: TRANSPARENT_RTK_CONFIG,
    });
    expect(result?.reason).toContain('git reset --hard');
    expect(blockedSegment(result)).toBe('rtk git reset --hard');
  });

  test('transparent wrapper finds custom-rule child command after wrapper arguments', () => {
    const result = analyzeCommand('rtk -x arg docker system prune', {
      cwd: '/tmp',
      config: TRANSPARENT_RTK_DOCKER_PRUNE_CONFIG,
    });
    expect(result?.reason).toContain('[block-docker-prune] Use targeted Docker cleanup.');
    expect(blockedSegment(result)).toBe('rtk -x arg docker system prune');
  });

  test('transparent wrapper finds custom-rule child command after wrapper env assignment', () => {
    const result = analyzeCommand('rtk VAR=val docker system prune', {
      cwd: '/tmp',
      config: TRANSPARENT_RTK_DOCKER_PRUNE_CONFIG,
    });
    expect(result?.reason).toContain('[block-docker-prune] Use targeted Docker cleanup.');
    expect(blockedSegment(result)).toBe('rtk VAR=val docker system prune');
  });

  test('transparent wrapper lets custom rules protect non-built-in child command', () => {
    const result = analyzeCommand('rtk docker system prune', {
      cwd: '/tmp',
      config: TRANSPARENT_RTK_DOCKER_PRUNE_CONFIG,
    });
    expect(result?.reason).toContain('[block-docker-prune] Use targeted Docker cleanup.');
  });

  test('transparent wrapper does not unwrap unprotected child command', () => {
    expect(
      analyzeCommand('rtk init -g', {
        cwd: '/tmp',
        config: TRANSPARENT_RTK_CONFIG,
      }),
    ).toBeNull();
  });

  test('transparent wrapper supports explicit child delimiter', () => {
    const result = analyzeCommand('rtk -- git reset --hard', {
      cwd: '/tmp',
      config: TRANSPARENT_RTK_CONFIG,
    });
    expect(result?.reason).toContain('git reset --hard');
    expect(blockedSegment(result)).toBe('rtk -- git reset --hard');
  });

  test('fallback scan catches embedded find', () => {
    const result = analyzeCommand('tool find . -delete', {
      cwd: '/tmp',
      config: EMPTY_CONFIG,
    });
    expect(result?.reason).toContain('find -delete');
  });

  test('fallback scan ignores embedded find when safe', () => {
    expect(
      analyzeCommand('tool find . -print', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      }),
    ).toBeNull();
  });

  test('TMPDIR override to a temp dir keeps $TMPDIR allowed', () => {
    const result = analyzeCommand('TMPDIR=/tmp rm -rf $TMPDIR/test-dir', {
      cwd: '/tmp',
      config: EMPTY_CONFIG,
    });
    expect(result).toBeNull();
  });

  test('TMPDIR traversal override blocks $TMPDIR only in strict mode', () => {
    const command = 'TMPDIR=/tmp/../root rm -rf $TMPDIR/test-dir';
    const options = {
      cwd: '/tmp',
      config: EMPTY_CONFIG,
    };
    expect(analyzeCommand(command, options)).toBeNull();
    expect(analyzeCommand(command, { ...options, strict: true })?.reason).toContain('rm -rf');
  });

  test('xargs child git command is analyzed', () => {
    const result = analyzeCommand('xargs git reset --hard', {
      cwd: '/tmp',
      config: EMPTY_CONFIG,
    });
    expect(result?.reason).toContain('git reset --hard');
  });

  test('xargs child git command can be safe', () => {
    expect(
      analyzeCommand('xargs git status', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      }),
    ).toBeNull();
  });

  describe('shell git context env state branches', () => {
    test('command -- export target is tracked across segments', async () => {
      const result = await analyzeInLinkedWorktree(
        (main) => `command -- export GIT_WORK_TREE=${main}; git reset --hard`,
      );
      expect(result?.reason).toContain('git reset --hard');
    });

    test('command inspection with no executable target leaves later git context unchanged', async () => {
      await withLinkedWorktreeFixture((fixture) => {
        withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
          expect(
            analyzeCommand(
              `command -v export; GIT_WORK_TREE=${toShellPath(
                fixture.mainWorktree,
              )}; git reset --hard`,
              {
                cwd: fixture.linkedWorktree,
                config: EMPTY_CONFIG,
                worktreeMode: true,
              },
            ),
          ).toBeNull();
          expect(
            analyzeCommand('command; git reset --hard', {
              cwd: fixture.linkedWorktree,
              config: EMPTY_CONFIG,
              worktreeMode: true,
            }),
          ).toBeNull();
        });
      });
    });

    test('export option parsing tracks only valid export operands', async () => {
      await withLinkedWorktreeFixture((fixture) => {
        withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
          expect(
            analyzeCommand(
              `export -z GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)}; git reset --hard`,
              {
                cwd: fixture.linkedWorktree,
                config: EMPTY_CONFIG,
                worktreeMode: true,
              },
            ),
          ).toBeNull();

          const result = analyzeCommand(
            `export -- GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)}; git reset --hard`,
            {
              cwd: fixture.linkedWorktree,
              config: EMPTY_CONFIG,
              worktreeMode: true,
            },
          );
          expect(result?.reason).toContain('git reset --hard');
        });
      });
    });

    test('exporting an unset tracked name uses an empty effective value', async () => {
      await withLinkedWorktreeFixture((fixture) => {
        withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
          const result = analyzeCommand('export GIT_WORK_TREE; git reset --hard', {
            cwd: fixture.linkedWorktree,
            config: EMPTY_CONFIG,
            worktreeMode: true,
          });
          expect(result?.reason).toContain('git reset --hard');
        });
      });
    });

    test('typeset and readonly forms update tracked env state only when exported', () => {
      const fixture = createLinkedWorktreeFixture();
      try {
        withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
          const mainWorktree = toShellPath(fixture.mainWorktree);
          const blockedCommands = [
            `typeset -x GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            `declare -x GIT_WORK_TREE; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            `export GIT_WORK_TREE; typeset GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            `GIT_WORK_TREE=${mainWorktree} readonly GIT_WORK_TREE; git reset --hard`,
          ];

          for (const command of blockedCommands) {
            const result = analyzeCommand(command, {
              cwd: fixture.linkedWorktree,
              config: EMPTY_CONFIG,
              worktreeMode: true,
            });
            expect(result?.reason).toContain('git reset --hard');
          }

          for (const command of [
            `typeset -- -x GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            `declare -x; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
          ]) {
            expect(
              analyzeCommand(command, {
                cwd: fixture.linkedWorktree,
                config: EMPTY_CONFIG,
                worktreeMode: true,
              }),
            ).toBeNull();
          }

          expect(
            analyzeCommand(`typeset +x GIT_WORK_TREE=${mainWorktree}; git reset --hard`, {
              cwd: fixture.linkedWorktree,
              config: EMPTY_CONFIG,
              worktreeMode: true,
            }),
          ).toBeNull();
        });
      } finally {
        fixture.cleanup();
      }
    });

    test('set option parsing toggles exported assignment behavior', () => {
      const fixture = createLinkedWorktreeFixture();
      try {
        withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
          const mainWorktree = toShellPath(fixture.mainWorktree);
          const allowedCommands = [
            `set -k; set +k; git restore file.txt GIT_WORK_TREE=${mainWorktree}`,
            `set positional; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            `set --; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
          ];

          for (const command of allowedCommands) {
            expect(
              analyzeCommand(command, {
                cwd: fixture.linkedWorktree,
                config: EMPTY_CONFIG,
                worktreeMode: true,
              }),
            ).toBeNull();
          }
        });
      } finally {
        fixture.cleanup();
      }
    });
  });

  describe('parallel parsing/analysis branches', () => {
    test('parallel bash -c with placeholder and no args analyzes template', () => {
      const result = analyzeCommand("parallel bash -c 'echo {}'", {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      });
      expect(result).toBeNull();
    });

    test('parallel bash -c with placeholder outside script is blocked', () => {
      const result = analyzeCommand("parallel bash -c 'echo hi' {} ::: a", {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      });
      expect(result?.reason).toContain('parallel with shell -c');
    });

    test('parallel bash -c without script but with args is blocked', () => {
      const result = analyzeCommand("parallel bash -c ::: 'echo hi'", {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      });
      expect(result?.reason).toContain('parallel with shell -c');
    });

    test('parallel bash -c without script or args is allowed', () => {
      expect(
        analyzeCommand('parallel bash -c', {
          cwd: '/tmp',
          config: EMPTY_CONFIG,
        })?.ruleId,
      ).toBe('parallel.shell-dynamic');
    });

    test('parallel bash with placeholder but missing -c arg is blocked', () => {
      const result = analyzeCommand('parallel bash {} -c', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      });
      expect(result?.reason).toContain('parallel with shell -c');
    });

    test('parallel rm -rf with explicit temp arg is allowed', () => {
      const result = analyzeCommand('parallel rm -rf ::: /tmp/a', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      });
      expect(result).toBeNull();
    });

    test('parallel git tokens are analyzed', () => {
      const result = analyzeCommand('parallel git reset --hard :::', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      });
      expect(result?.reason).toContain('git reset --hard');
    });

    test('parallel with -- separator parses template', () => {
      const result = analyzeCommand('parallel -- rm -rf ::: /tmp/a', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      });
      expect(result).toBeNull();
    });

    test('parallel -j option consumes its value', () => {
      const result = analyzeCommand('parallel -j 4 rm -rf ::: /tmp/a', {
        cwd: '/tmp',
        config: EMPTY_CONFIG,
      });
      expect(result).toBeNull();
    });
  });

  describe('child command analyzer branches', () => {
    const childContext = {
      environment: TEST_ENVIRONMENT,
      protectedGitMetadata: null,
      cwd: '/tmp',
      originalCwd: '/tmp',
      paranoidRm: false,
      allowTmpdirVar: true,
      envAssignments: new Map<string, string>(),
    };
    const analyzeNestedMatch = (command: string) => {
      const result = analyzeCommand(command, { cwd: '/tmp', config: EMPTY_CONFIG });
      return result
        ? {
            id: result.ruleId ?? '',
            reason: result.reason,
            intent: result.intent ?? 'manual_only',
          }
        : null;
    };

    test('empty child head returns null', () => {
      expect(analyzeChildCommand([''], childContext)).toBeNull();
    });

    test('shell child without dynamic input analyzes dash c script', () => {
      const result = analyzeChildCommand(['sh', '-c', 'git reset --hard'], {
        ...childContext,
        analyzeNested: analyzeNestedMatch,
      });
      expect(result).toContain('git reset --hard');
    });

    test('shell child without dash c script returns null', () => {
      expect(analyzeChildCommand(['sh'], childContext)).toBeNull();
    });

    test('dynamic rm child falls back to caller reason when target is otherwise allowed', () => {
      expect(
        analyzeChildCommand(['rm', '-rf', '/tmp/a'], childContext, {
          dynamicInput: true,
          rmDynamicMatch: { id: '', reason: 'dynamic rm denied', intent: 'manual_only' },
        }),
      ).toBe('dynamic rm denied');
    });

    test('find exec supports analyzeNested fallback when token analyzer is absent', () => {
      const result = analyzeFind(['find', '.', '-exec', 'git', 'reset', '--hard', ';'], {
        environment: TEST_ENVIRONMENT,
        protectedGitMetadata: null,
        cwd: '/tmp',
        envAssignments: new Map<string, string>(),
        analyzeNested: analyzeNestedMatch,
      });
      expect(result).toContain('git reset --hard');
    });

    test('find child command reuses child analyzer for exec commands', () => {
      expect(
        analyzeChildCommand(['find', '.', '-exec', 'git', 'reset', '--hard', ';'], {
          ...childContext,
          analyzeNested: analyzeNestedMatch,
        }),
      ).toContain('git reset --hard');
    });

    test('find exec analyzeNested fallback continues when command is safe', () => {
      expect(
        analyzeFind(['find', '.', '-exec', 'echo', '{}', ';'], {
          environment: TEST_ENVIRONMENT,
          protectedGitMetadata: null,
          cwd: '/tmp',
          envAssignments: new Map<string, string>(),
          analyzeNested: analyzeNestedMatch,
        }),
      ).toBeNull();
    });

    test('find exec direct fallback still handles wrapped rm commands', () => {
      expect(
        analyzeFind(['find', '.', '-exec', 'busybox', 'rm', '-rf', '{}', ';'], {
          environment: TEST_ENVIRONMENT,
          protectedGitMetadata: null,
        }),
      ).toContain('find -exec rm -rf');
    });

    test('find exec direct fallback allows safe command', () => {
      expect(
        analyzeFind(['find', '.', '-exec', 'echo', '{}', ';'], {
          environment: TEST_ENVIRONMENT,
          protectedGitMetadata: null,
        }),
      ).toBeNull();
    });
  });
});
