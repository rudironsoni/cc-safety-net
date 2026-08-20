import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { textCommandWords } from '@/analyzer/command-words';
import { analyzeGitMatch, getGitWorktreeRelaxation } from '@/analyzer/git';
import { testEnvironment } from '../helpers/environment.ts';
import {
  runGit,
  withSymlinkedLinkedWorktreeDirectory,
  withSymlinkToMainWorktreeSubdirectory,
} from '../helpers/git-worktree';
import {
  assertAllowed,
  assertBlocked,
  createLinkedWorktreeFixture,
  createSubmoduleLikeGitFileFixture,
  runGuard,
  toShellPath,
  withEnv,
  withReadonlyLinkedWorktreeFixture,
} from '../helpers.ts';

const analyzeGit = (tokens: readonly string[], options: Parameters<typeof analyzeGitMatch>[1]) =>
  analyzeGitMatch(textCommandWords(tokens), options)?.reason ?? null;

const gitResetHard = ['git', 'reset', '--hard'].join(' ');
const gitResetHardReason = ['git reset', '--hard'].join(' ');

describe('analyzeGit direct', () => {
  test('empty tokens returns null', () => {
    expect(analyzeGit([], { env: new Map() })).toBeNull();
  });

  test('blocks destructive command-line aliases before global config parsing', () => {
    assertBlocked(`git -c alias.nuke=reset nuke --hard`, gitResetHardReason);
    assertBlocked('git -calias.force=push force origin +main', 'push --force');
  });

  test('fails closed on command-line shell aliases', () => {
    assertBlocked('git -c alias.nuke=!echo nuke', 'Git aliases');
  });

  test('allows safe command-line aliases', () => {
    assertAllowed('git -c alias.st=status st');
  });

  test('blocks destructive aliases from Git config env', () => {
    assertBlocked(
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.nuke GIT_CONFIG_VALUE_0=reset git nuke --hard',
      gitResetHardReason,
    );
  });

  test('allows safe aliases from Git config env', () => {
    assertAllowed('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.st GIT_CONFIG_VALUE_0=status git st');
  });

  test('blocks destructive aliases from GIT_CONFIG_PARAMETERS', () => {
    assertBlocked(`GIT_CONFIG_PARAMETERS="'alias.nuke=reset'" git nuke --hard`, gitResetHardReason);
  });

  test('blocks reset after global config-env option', () => {
    assertBlocked(
      'git --config-env submodule.recurse=RECURSE_SUBMODULES reset --hard',
      'git reset --hard',
    );
  });

  test('classifies reset --hard before -- as local discard', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      expect(
        getGitWorktreeRelaxation(['git', 'reset', '--hard', '--'], {
          env: new Map(),
          cwd: fixture.linkedWorktree,
          worktreeMode: true,
        }),
      ).toEqual({
        originalReason: expect.stringContaining('git reset --hard'),
        gitCwd: expect.any(String),
      });
    });
  });
});

describe('git checkout', () => {
  test('git checkout --force blocked', () => {
    assertBlocked('git checkout --force main', 'git checkout --force');
  });

  test('git checkout abbreviated force blocked', () => {
    assertBlocked('git checkout --forc main', 'git checkout --force');
  });

  test('git checkout -f blocked', () => {
    assertBlocked('git checkout -f main', 'git checkout --force');
  });

  test('git checkout -qf blocked', () => {
    assertBlocked('git checkout -qf main', 'git checkout --force');
  });

  test('git checkout -tf blocked', () => {
    assertBlocked('git checkout -tf main', 'git checkout --force');
  });

  test('git checkout force wins over branch creation', () => {
    assertBlocked('git checkout -f -b new-branch', 'git checkout --force');
  });

  test('git checkout -- blocked', () => {
    assertBlocked('git checkout -- file.txt', 'git checkout --');
  });

  test('git checkout -- multiple files blocked', () => {
    assertBlocked('git checkout -- file1.txt file2.txt', 'git checkout --');
  });

  test('git checkout -- . blocked', () => {
    assertBlocked('git checkout -- .', 'git checkout --');
  });

  test('git checkout ref -- blocked', () => {
    assertBlocked('git checkout HEAD -- file.txt', 'git checkout <ref> -- <path>');
  });

  test('git checkout -b allowed', () => {
    assertAllowed('git checkout -b new-branch');
  });

  test('git checkout --orphan allowed', () => {
    assertAllowed('git checkout --orphan orphan-branch');
  });

  test('git checkout -bnew-branch allowed', () => {
    assertAllowed('git checkout -bnew-branch');
  });

  test('git checkout -bfeature allowed', () => {
    assertAllowed('git checkout -bfeature');
  });

  test('git checkout -Bnew-branch allowed', () => {
    assertAllowed('git checkout -Bnew-branch');
  });

  test('git checkout -qbfeature allowed', () => {
    assertAllowed('git checkout -qbfeature');
  });

  test('git checkout ref pathspec blocked', () => {
    assertBlocked('git checkout HEAD file.txt', 'multiple positional args');
  });

  test('git checkout ref multiple pathspecs blocked', () => {
    assertBlocked('git checkout main a.txt b.txt', 'multiple positional args');
  });

  test('git checkout branch only allowed', () => {
    assertAllowed('git checkout main');
  });

  test('git checkout -U3 main allowed', () => {
    assertAllowed('git checkout -U3 main');
  });

  test('git checkout - allowed', () => {
    assertAllowed('git checkout -');
  });

  test('git checkout -- -f blocked as path restore, not force', () => {
    assertBlocked('git checkout -- -f', 'git checkout --');
  });

  test('git checkout --detach allowed', () => {
    assertAllowed('git checkout --detach main');
  });

  test('git checkout --recurse-submodules allowed', () => {
    assertAllowed('git checkout --recurse-submodules main');
  });

  test('git checkout --pathspec-from-file blocked', () => {
    assertBlocked(
      'git checkout HEAD --pathspec-from-file=paths.txt',
      'git checkout --pathspec-from-file',
    );
  });

  test('git checkout abbreviated pathspec-from-file blocked', () => {
    assertBlocked(
      'git checkout HEAD --pathspec-from-f=paths.txt',
      'git checkout --pathspec-from-file',
    );
  });

  test('git checkout ref pathspec from file arg blocked', () => {
    assertBlocked(
      'git checkout HEAD --pathspec-from-file paths.txt',
      'git checkout --pathspec-from-file',
    );
  });

  test('git checkout --conflict=merge allowed', () => {
    assertAllowed('git checkout --conflict=merge main');
  });

  test('git checkout --conflict merge allowed', () => {
    assertAllowed('git checkout --conflict merge main');
  });

  test('git checkout -q ref pathspec blocked', () => {
    assertBlocked('git checkout -q main file.txt', 'multiple positional args');
  });

  test('git checkout --no-quiet ref pathspec blocked', () => {
    assertBlocked('git checkout --no-quiet main file.txt', 'multiple positional args');
  });

  test('git checkout --guess ref pathspec blocked', () => {
    assertBlocked('git checkout --guess main file.txt', 'multiple positional args');
  });

  test('git checkout --recurse-submodules=checkout allowed', () => {
    assertAllowed('git checkout --recurse-submodules=checkout main');
  });

  test('git checkout --recurse-submodules=on-demand allowed', () => {
    assertAllowed('git checkout --recurse-submodules=on-demand main');
  });

  test('git checkout --recurse-submodules ref pathspec blocked', () => {
    assertBlocked('git checkout --recurse-submodules main file.txt', 'multiple positional args');
  });

  test('git checkout --no-recurse-submodules ref pathspec blocked', () => {
    assertBlocked('git checkout --no-recurse-submodules main file.txt', 'multiple positional args');
  });

  test('git checkout --recurse-submodules with checkout mode allowed', () => {
    assertAllowed('git checkout --recurse-submodules checkout main');
  });

  test('git checkout --recurse-submodules with on-demand mode allowed', () => {
    assertAllowed('git checkout --recurse-submodules on-demand main');
  });

  test('git checkout --track with direct mode allowed', () => {
    assertAllowed('git checkout --track direct main');
  });

  test('git checkout --track with inherit mode allowed', () => {
    assertAllowed('git checkout --track inherit main');
  });

  test('git checkout --recurse-submodules followed by option allowed', () => {
    assertAllowed('git checkout --recurse-submodules -q main');
  });

  test('git checkout --track followed by option allowed', () => {
    assertAllowed('git checkout --track -q main');
  });

  test('git checkout -t followed by option allowed', () => {
    assertAllowed('git checkout -t -q main');
  });

  test('git checkout --track=direct allowed', () => {
    assertAllowed('git checkout --track=direct main');
  });

  test('git checkout --track=inherit allowed', () => {
    assertAllowed('git checkout --track=inherit main');
  });

  test('git checkout --track without mode ref pathspec blocked', () => {
    assertBlocked('git checkout --track main file.txt', 'multiple positional args');
  });

  test('git checkout --unified 3 allowed', () => {
    assertAllowed('git checkout --unified 3 main');
  });

  test('git checkout --inter-hunk-context 3 allowed', () => {
    assertAllowed('git checkout --inter-hunk-context 3 main');
  });

  test('git checkout unknown long option ref pathspec blocked', () => {
    assertBlocked('git checkout --unknown main file.txt', 'multiple positional args');
  });

  test('git checkout unknown long option does not consume option value allowed', () => {
    assertAllowed('git checkout --unknown -q main');
  });

  test('git checkout unknown long option equals allowed', () => {
    assertAllowed('git checkout --unknown=value main');
  });
});

describe('git switch', () => {
  test('git switch --discard-changes blocked', () => {
    assertBlocked('git switch --discard-changes main', 'git switch --discard-changes');
  });

  test('git switch abbreviated discard changes blocked', () => {
    assertBlocked('git switch --discard-ch main', 'git switch --discard-changes');
  });

  test('git switch --force blocked', () => {
    assertBlocked('git switch --force main', 'git switch --force');
  });

  test('git switch -f blocked', () => {
    assertBlocked('git switch -f main', 'git switch --force');
  });

  test('git switch -qf blocked', () => {
    assertBlocked('git switch -qf main', 'git switch --force');
  });

  test('git -C repo switch -f blocked', () => {
    assertBlocked('git -C repo switch -f main', 'git switch --force');
  });

  test('git switch main allowed', () => {
    assertAllowed('git switch main');
  });

  test('git switch -c feature allowed', () => {
    assertAllowed('git switch -c feature');
  });

  test('git switch -cfeature allowed', () => {
    assertAllowed('git switch -cfeature');
  });

  test('git switch -Cfixup allowed', () => {
    assertAllowed('git switch -Cfixup');
  });

  test('git switch --detach main allowed', () => {
    assertAllowed('git switch --detach main');
  });

  test('git switch -- -f allowed', () => {
    assertAllowed('git switch -- -f');
  });
});

describe('git restore', () => {
  test('git restore without a pathspec is allowed', () => {
    assertAllowed('git restore');
    assertAllowed('/usr/bin/git restore --no-staged');
    assertAllowed('git restore -h');
    assertAllowed('git restore --worktree');
  });

  test('git restore file blocked', () => {
    assertBlocked('git restore file.txt', 'git restore');
  });

  test('git restore multiple files blocked', () => {
    assertBlocked('git restore a.txt b.txt', 'git restore');
  });

  test('git restore --worktree blocked', () => {
    assertBlocked('git restore --worktree file.txt', 'git restore --worktree');
  });

  test('git restore --staged allowed', () => {
    assertAllowed('git restore --staged file.txt');
  });

  test('git restore --staged . allowed', () => {
    assertAllowed('git restore --staged .');
  });

  test('git restore --help allowed', () => {
    assertAllowed('git restore --help');
  });

  test('git restore treats every token after -- as a pathspec', () => {
    assertAllowed('git restore --');
    assertBlocked('git restore -- -h', 'git restore');
    assertBlocked('git restore -- --staged', 'git restore');
    assertBlocked('git restore file.txt --', 'git restore');
  });

  test('git restore consumes values for known long options', () => {
    assertAllowed('git restore --source --worktree');
    assertBlocked('git restore --conflict --staged file.txt', 'git restore');
    assertBlocked('git restore --unified --staged file.txt', 'git restore');
    assertBlocked('git restore --inter-hunk-context --staged file.txt', 'git restore');
    assertBlocked('git restore --source=HEAD file.txt', 'git restore');
    assertBlocked('git restore --future-option file.txt', 'git restore');
    assertAllowed('git restore --no-source --staged file.txt');
    assertAllowed('git restore --recurse-submodules --staged file.txt');
  });

  test('git restore parses staged and worktree short option clusters', () => {
    assertAllowed('git restore -qS file.txt');
    assertBlocked('git restore -SW file.txt', 'git restore --worktree');
    assertBlocked('git restore -sHEAD file.txt', 'git restore');
    assertBlocked('git restore -U3 file.txt', 'git restore');
    assertBlocked('git restore -s --staged file.txt', 'git restore');
    assertBlocked('git restore -U --worktree file.txt', 'git restore');
  });

  test('git restore detects pathspec-from-file without parsing its operand as flags', () => {
    assertBlocked('git restore --pathspec-from-file paths.txt', 'git restore');
    assertBlocked('git restore --pathspec-from-file=paths.txt', 'git restore');
    assertBlocked('git restore --pathspec-from-file --staged', 'git restore');
    assertAllowed('git restore --staged --pathspec-from-file --worktree');
  });

  test('git restore treats lone - as a pathspec', () => {
    assertBlocked('git restore -', 'git restore');
  });

  test('git restore applies location flags in order', () => {
    assertAllowed('git restore --no-staged file.txt');
    assertAllowed('git restore --no-worktree file.txt');
    assertAllowed('git restore -S --no-staged file.txt');
    assertBlocked('git restore --no-staged -W file.txt', 'git restore --worktree');
    assertAllowed('git restore -W --no-worktree file.txt');
    assertBlocked('git restore -S -W file.txt', 'git restore --worktree');
  });

  test('git restore patch mode is a target without a pathspec', () => {
    assertBlocked('git restore -p', 'git restore');
    assertBlocked('git restore --patch', 'git restore');
    assertAllowed('git restore -p -S');
    assertAllowed('git restore -p --no-patch');
    assertBlocked('git restore --no-patch -p', 'git restore');
  });

  test('git restore only treats unconsumed help and version options as terminal', () => {
    assertAllowed('git restore file.txt -h');
    assertAllowed('git restore file.txt --help');
    assertAllowed('git restore file.txt --version');
    assertBlocked('git restore --source --help file.txt', 'git restore');
    assertBlocked('git restore -- file.txt --help', 'git restore');
  });
});

describe('git reset', () => {
  test('git reset --hard blocked', () => {
    assertBlocked('git reset --hard', 'git reset --hard');
  });

  test('git.exe reset --hard blocked', () => {
    assertBlocked('git.exe reset --hard', 'git reset --hard');
  });

  test('Windows git.exe path reset --hard blocked', () => {
    assertBlocked('"C:\\Program Files\\Git\\bin\\git.exe" reset --hard', 'git reset --hard');
  });

  test('uppercase GIT.EXE reset --hard blocked', () => {
    assertBlocked('GIT.EXE reset --hard', 'git reset --hard');
  });

  test('git reset --hard HEAD~1 blocked', () => {
    assertBlocked('git reset --hard HEAD~1', 'git reset --hard');
  });

  test('git reset -q --hard blocked', () => {
    assertBlocked('git reset -q --hard', 'git reset --hard');
  });

  test('echo ok | git reset --hard blocked', () => {
    assertBlocked('echo ok | git reset --hard', 'git reset --hard');
  });

  test('git -C repo reset --hard blocked', () => {
    assertBlocked('git -C repo reset --hard', 'git reset --hard');
  });

  test('git -Crepo reset --hard blocked', () => {
    assertBlocked('git -Crepo reset --hard', 'git reset --hard');
  });

  test('git --git-dir=repo/.git reset --hard blocked', () => {
    assertBlocked('git --git-dir=repo/.git reset --hard', 'git reset --hard');
  });

  test('git --git-dir repo/.git reset --hard blocked', () => {
    assertBlocked('git --git-dir repo/.git reset --hard', 'git reset --hard');
  });

  test('git --work-tree=repo reset --hard blocked', () => {
    assertBlocked('git --work-tree=repo reset --hard', 'git reset --hard');
  });

  test('git --no-pager reset --hard blocked', () => {
    assertBlocked('git --no-pager reset --hard', 'git reset --hard');
  });

  test('git -c foo=bar reset --hard blocked', () => {
    assertBlocked('git -c foo=bar reset --hard', 'git reset --hard');
  });

  test('git -- reset --hard blocked', () => {
    assertBlocked('git -- reset --hard', 'reset --hard');
  });

  test('git -cfoo=bar reset --hard blocked', () => {
    assertBlocked('git -cfoo=bar reset --hard', 'git reset --hard');
  });

  test('sudo env VAR=1 git reset --hard blocked', () => {
    assertBlocked('sudo env VAR=1 git reset --hard', 'git reset --hard');
  });

  test('env -- git reset --hard blocked', () => {
    assertBlocked('env -- git reset --hard', 'git reset --hard');
  });

  test('command -- git reset --hard blocked', () => {
    assertBlocked('command -- git reset --hard', 'git reset --hard');
  });

  test('env -u PATH git reset --hard blocked', () => {
    assertBlocked('env -u PATH git reset --hard', 'git reset --hard');
  });

  test('git reset --merge blocked', () => {
    assertBlocked('git reset --merge', 'git reset --merge');
  });

  test('git reset without flags allowed', () => {
    assertAllowed('git reset');
  });

  test('git reset HEAD allowed', () => {
    assertAllowed('git reset HEAD');
  });

  test("sh -c 'git reset --hard' blocked", () => {
    assertBlocked("sh -c 'git reset --hard'", 'git reset --hard');
  });
});

describe('git rm', () => {
  test.each([
    'git rm -f file.txt',
    'git rm --force file.txt',
    'git rm -rf .',
    'git rm -fr .',
    'git rm -qf file.txt',
    'git rm --no-force --force file.txt',
    'git rm --cached --no-cached --force file.txt',
    'git rm --dry-run --no-dry-run --force file.txt',
  ])('blocks forced working-tree removal: %s', (command) => {
    assertBlocked(command, 'git rm --force');
  });

  test.each([
    'git rm file.txt',
    'git rm -r directory',
    'git rm -f --cached file.txt',
    'git rm --force --cached file.txt',
    'git rm --no-cached --cached --force file.txt',
    'git rm -n -f file.txt',
    'git rm -nrf .',
    'git rm --dry-run --force file.txt',
    'git rm --no-dry-run --dry-run --force file.txt',
    'git rm --force --no-force file.txt',
    'git rm -- -f',
    'git rm -- --force',
  ])('allows removal that is not an effective forced working-tree write: %s', (command) => {
    assertAllowed(command);
  });
});

describe('git clean', () => {
  test('git clean -f blocked', () => {
    assertBlocked('git clean -f', 'git clean');
  });

  test('git clean --force blocked', () => {
    assertBlocked('git clean --force', 'git clean -f');
  });

  test('git clean -nf blocked', () => {
    assertBlocked('git clean -nf', 'git clean -f');
  });

  test('git clean -n && git clean -f blocked', () => {
    assertBlocked('git clean -n && git clean -f', 'git clean -f');
  });

  test('git clean -fd blocked', () => {
    assertBlocked('git clean -fd', 'git clean');
  });

  test('git clean -xf blocked', () => {
    assertBlocked('git clean -xf', 'git clean');
  });

  test('git clean -n allowed', () => {
    assertAllowed('git clean -n');
  });

  test('git clean --dry-run allowed', () => {
    assertAllowed('git clean --dry-run');
  });

  test('git clean -nd allowed', () => {
    assertAllowed('git clean -nd');
  });
});

describe('git linked worktree mode', () => {
  test('default mode still blocks local discard commands in linked worktrees', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      assertBlocked('git reset --hard', 'git reset --hard', fixture.linkedWorktree);
    });
  });

  test('SAFETY_NET_WORKTREE allows local discard commands in linked worktrees', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        const commands = [
          'git restore file.txt',
          'git restore --worktree file.txt',
          'git checkout -- file.txt',
          'git checkout HEAD -- file.txt',
          'git checkout --force main',
          'git checkout --pathspec-from-file paths.txt',
          'git checkout main file.txt',
          'git switch --discard-changes main',
          'git switch -f main',
          'git reset --hard',
          'git reset --merge',
          'git clean -f',
          'git clean -fd',
        ];

        for (const command of commands) {
          expect(runGuard(command, fixture.linkedWorktree)).toBeNull();
        }
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax main worktree commands', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('git reset --hard', 'git reset --hard', fixture.mainWorktree);
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax main worktree subdirectories', () => {
    const fixture = createLinkedWorktreeFixture();
    const subdir = join(fixture.mainWorktree, 'nested');
    mkdirSync(subdir);
    try {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('git clean -f', 'git clean -f', subdir);
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('SAFETY_NET_WORKTREE does not relax submodule-like git file directories', () => {
    const fixture = createSubmoduleLikeGitFileFixture();
    try {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('git reset --hard', 'git reset --hard', fixture.cwd);
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('SAFETY_NET_WORKTREE allows symlinked cwd inside linked worktree', () => {
    withSymlinkedLinkedWorktreeDirectory((_fixture, symlinkedCwd) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertAllowed('git reset --hard', symlinkedCwd);
      });
    });
  });

  test('SAFETY_NET_WORKTREE uses physical cwd for wrapper chdir targets', () => {
    withSymlinkToMainWorktreeSubdirectory('main-subdir-link', (_fixture, symlinkedCwd) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('env -C .. git reset --hard', 'git reset --hard', symlinkedCwd);
        assertBlocked('sudo -D .. git reset --hard', 'git reset --hard', symlinkedCwd);
      });
    });
  });

  test('SAFETY_NET_WORKTREE allows nested linked worktrees', () => {
    const fixture = createLinkedWorktreeFixture();
    const nestedWorktree = join(fixture.linkedWorktree, 'inner-worktree');
    runGit(fixture.mainWorktree, [
      'worktree',
      'add',
      '-b',
      'feature/nested-worktree-test',
      nestedWorktree,
    ]);
    try {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertAllowed('git reset --hard', nestedWorktree);
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('SAFETY_NET_WORKTREE honors git -C linked worktree directories', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertAllowed(
          `git -C ${toShellPath(fixture.linkedWorktree)} reset --hard`,
          fixture.mainWorktree,
        );
        assertAllowed(
          `git -C${toShellPath(fixture.linkedWorktree)} clean -f`,
          fixture.mainWorktree,
        );
        assertAllowed(
          `git -C ${toShellPath(fixture.mainWorktree)} -C ../linked reset --merge`,
          fixture.rootDir,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax unresolved git -C directories', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `git -C ${toShellPath(join(fixture.rootDir, 'missing'))} reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax after cwd becomes unknown', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('cd /tmp && git reset --hard', 'git reset --hard', fixture.linkedWorktree);
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax explicit git context overrides', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          'git --git-dir=.git reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked('git --work-tree=. reset --hard', 'git reset --hard', fixture.linkedWorktree);
        assertBlocked('GIT_DIR=.git git reset --hard', 'git reset --hard', fixture.linkedWorktree);
        assertBlocked(
          'GIT_WORK_TREE=. git reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'GIT_COMMON_DIR=.git git reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE treats GIT_INDEX_FILE as a git context override', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `GIT_INDEX_FILE=${toShellPath(join(fixture.mainWorktree, '.git', 'index'))} git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE tracks shell-exported git context overrides', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      const mainWorktree = toShellPath(fixture.mainWorktree);
      const mainGitDir = toShellPath(join(fixture.mainWorktree, '.git'));
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        const commands = [
          `declare GIT_WORK_TREE=${mainWorktree}; export GIT_WORK_TREE; git reset --hard`,
          `typeset GIT_WORK_TREE=${mainWorktree}; export GIT_WORK_TREE; git reset --hard`,
          `declare -- GIT_WORK_TREE=${mainWorktree}; export GIT_WORK_TREE; git reset --hard`,
          `declare GIT_WORK_TREE=${mainWorktree}; declare -x GIT_WORK_TREE; git reset --hard`,
          `declare -x GIT_WORK_TREE; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
          `export GIT_WORK_TREE; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
          `builtin export GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
          `command export GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
          `set -a; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
          `set -o allexport; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
          `export GIT_WORK_TREE+=${mainWorktree}; git reset --hard`,
          `declare -x GIT_WORK_TREE+=${mainWorktree}; git reset --hard`,
          `GIT_DIR=${mainGitDir} GIT_WORK_TREE=${mainWorktree} export GIT_DIR GIT_WORK_TREE; git reset --hard`,
        ];

        for (const command of commands) {
          assertBlocked(command, 'git reset --hard', fixture.linkedWorktree);
        }
      });
    });
  });

  test('SAFETY_NET_WORKTREE tracks time-prefixed shell git context updates', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      const mainWorktree = toShellPath(fixture.mainWorktree);
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        const commands = [
          `time export GIT_WORK_TREE=${mainWorktree}; ${gitResetHard}`,
          `time set -a; GIT_WORK_TREE=${mainWorktree}; ${gitResetHard}`,
        ];

        for (const command of commands) {
          assertBlocked(command, gitResetHardReason, fixture.linkedWorktree);
        }
      });
    });
  });

  test('SAFETY_NET_WORKTREE honors disabled allexport before later assignments', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      const mainWorktree = toShellPath(fixture.mainWorktree);
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        expect(
          runGuard(
            `set -a; set +a; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            fixture.linkedWorktree,
          ),
        ).toBeNull();
        expect(
          runGuard(
            `set -o allexport; set +o allexport; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            fixture.linkedWorktree,
          ),
        ).toBeNull();
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax cwd-changing wrappers into main worktree', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `env -C ${toShellPath(fixture.mainWorktree)} git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE keeps env chdir context through terminators and attached args', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `env -C ${toShellPath(fixture.mainWorktree)} -- git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          `env -C${toShellPath(fixture.mainWorktree)} git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE resolves wrapper chdir targets physically', () => {
    withSymlinkToMainWorktreeSubdirectory('link', (fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          'env -C link/.. git reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'sudo -D link/.. git reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE parses env split strings before relaxing', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `env -S '-C ${toShellPath(fixture.mainWorktree)}' git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          `env -S 'GIT_DIR=${toShellPath(join(fixture.mainWorktree, '.git'))} GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)}' git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE tracks sudo chdir before relaxing', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `sudo -D ${toShellPath(fixture.mainWorktree)} git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          `sudo --chdir=${toShellPath(fixture.mainWorktree)} git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE tracks attached sudo chdir and sudo login cwd', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `sudo -D${toShellPath(fixture.mainWorktree)} git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked('sudo -i git reset --hard', 'git reset --hard', fixture.linkedWorktree);
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax xargs child git env overrides', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `echo HEAD | xargs env GIT_DIR=${toShellPath(join(fixture.mainWorktree, '.git'))} GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)} git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax parallel child git env overrides', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `parallel env GIT_DIR=${toShellPath(join(fixture.mainWorktree, '.git'))} GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)} git reset --hard ::: x`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE propagates wrapper context through parallel commands mode', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `env -C ${toShellPath(fixture.mainWorktree)} parallel ::: 'git reset --hard'`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          `GIT_DIR=${toShellPath(join(fixture.mainWorktree, '.git'))} GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)} parallel ::: 'git reset --hard'`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE propagates wrapper context through BusyBox', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `env -C ${toShellPath(fixture.mainWorktree)} busybox sh -c 'git reset --hard'`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          `GIT_DIR=${toShellPath(join(fixture.mainWorktree, '.git'))} GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)} busybox sh -c 'git reset --hard'`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax exported git context overrides', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `export GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)}; git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          `GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)}; export GIT_WORK_TREE; git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          `export -- GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)}; git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          `typeset -x GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)}; git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax shell wrapper git env overrides', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `GIT_DIR=${toShellPath(join(fixture.mainWorktree, '.git'))} GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)} sh -c 'git reset --hard'`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax fallback embedded git commands', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('ssh host git clean -f', 'git clean -f', fixture.linkedWorktree);
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax remote parallel git commands', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          'parallel -S host git clean -f ::: .',
          'git clean -f',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE keeps ref-moving resets blocked', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('git reset --hard HEAD~1', 'git reset --hard', fixture.linkedWorktree);
        assertBlocked('git reset --merge HEAD~1', 'git reset --merge', fixture.linkedWorktree);
      });
    });
  });

  test('SAFETY_NET_WORKTREE keeps xargs and parallel appended reset refs blocked', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          'echo HEAD~1 | xargs git reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'parallel git reset --hard ::: HEAD~1',
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE fails closed on dynamic xargs git arguments', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('echo --force | xargs git clean -f', 'git clean -f', fixture.linkedWorktree);
        assertBlocked(
          'echo --recurse-submodules | xargs git checkout --force main',
          'git checkout --force',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE fails closed on dynamic xargs git env assignments', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          'echo ignored | xargs -I{} env EXTRA={} git reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE fails closed on dynamic parallel git arguments', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          "printf 'HEAD~1\\n' | parallel git reset --hard",
          'parallel with shell -c',
          fixture.linkedWorktree,
        );
        // Placeholder only on non-source git data still reaches the concrete git rule.
        assertBlocked('parallel git clean -f {} ::: -ffdx', 'git clean -f', fixture.linkedWorktree);
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not relax git context append assignments', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `GIT_WORK_TREE+=${toShellPath(fixture.mainWorktree)} git reset --hard`,
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE keeps recursive submodule discards blocked', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          'git reset --hard --recurse-submodules',
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'git checkout --force --recurse-submodules main',
          'git checkout --force',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'git reset --hard --recurse-submodule',
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE keeps recursive submodule config discards blocked', () => {
    const fixture = createLinkedWorktreeFixture();
    const safeHome = join(fixture.rootDir, 'safe-home');
    const safeXdg = join(fixture.rootDir, 'safe-xdg');
    const recurseHome = join(fixture.rootDir, 'recurse-home');
    const recurseConfig = join(fixture.rootDir, 'recurse.conf');
    mkdirSync(safeHome);
    mkdirSync(safeXdg);
    mkdirSync(recurseHome);
    writeFileSync(join(recurseHome, '.gitconfig'), '[submodule]\n\trecurse = true\n');
    writeFileSync(recurseConfig, '[submodule]\n\trecurse = true\n');
    const environment = testEnvironment({
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: safeHome,
      XDG_CONFIG_HOME: safeXdg,
    });
    try {
      withEnv(
        {
          SAFETY_NET_WORKTREE: '1',
          GIT_CONFIG_NOSYSTEM: '1',
          HOME: safeHome,
          XDG_CONFIG_HOME: safeXdg,
        },
        () => {
          for (const command of [
            `git -c include.path=${toShellPath(recurseConfig)} reset --hard`,
            `HOME=${toShellPath(recurseHome)} git reset --hard`,
            `HOME=${toShellPath(recurseHome)}; git reset --hard`,
            `HOME+=${toShellPath(recurseHome)} git reset --hard`,
            `export HOME+=${toShellPath(recurseHome)}; git reset --hard`,
            `GIT_CONFIG_PARAMETERS="'submodule.recurse=true'" git reset --hard`,
          ]) {
            assertBlocked(command, 'git reset --hard', fixture.linkedWorktree, environment);
          }
        },
      );

      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          'git -c submodule.recurse=true reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'git -csubmodule.recurse=true checkout --force main',
          'git checkout --force',
          fixture.linkedWorktree,
        );
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('SAFETY_NET_WORKTREE allows disabled recursive submodule config', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        expect(runGuard('git -c submodule.recurse=false clean -f', fixture.linkedWorktree)).toBe(
          null,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE fails closed on malformed recursive config env', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          'GIT_CONFIG_COUNT=not-a-number git reset --hard',
          'Git aliases supplied through command-line or environment config',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'GIT_CONFIG_SYSTEM=/tmp/missing-gitconfig git reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE fails closed on local include config', () => {
    const fixture = createLinkedWorktreeFixture();
    writeFileSync(join(fixture.mainWorktree, '.git', 'config'), '[include]\n\tpath = extra.conf\n');
    try {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('git reset --hard', 'git reset --hard', fixture.linkedWorktree);
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('SAFETY_NET_WORKTREE honors recursive submodule config-env values', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          'git --config-env submodule.recurse=RECURSE_SUBMODULES reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
          testEnvironment({ RECURSE_SUBMODULES: 'true' }),
        );

        assertBlocked(
          'git --config-env=submodule.recurse=RECURSE_SUBMODULES reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
          testEnvironment({ RECURSE_SUBMODULES: '1' }),
        );

        assertBlocked(
          'git --config-env submodule.recurse=MISSING_RECURSE_SUBMODULES reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );

        for (const value of ['false', 'no', 'off', '0']) {
          assertAllowed(
            'git --config-env submodule.recurse=RECURSE_SUBMODULES reset --hard',
            fixture.linkedWorktree,
            testEnvironment({ RECURSE_SUBMODULES: value }),
          );
        }
      });
    });
  });

  test('SAFETY_NET_WORKTREE fails closed on include config-env values', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1', INCLUDE_PATH: '.gitconfig-extra' }, () => {
        assertBlocked(
          'git --config-env include.path=INCLUDE_PATH reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'git --config-env=includeIf.gitdir:./.path=INCLUDE_PATH reset --hard',
          'git reset --hard',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE fails closed on include config count values', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        const commands = [
          `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=include.path GIT_CONFIG_VALUE_0=.gitconfig-extra ${gitResetHard}`,
          `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=includeIf.gitdir:./.path GIT_CONFIG_VALUE_0=.gitconfig-extra ${gitResetHard}`,
        ];

        for (const command of commands) {
          assertBlocked(command, gitResetHardReason, fixture.linkedWorktree);
        }
      });
    });
  });

  test('SAFETY_NET_WORKTREE keeps forced branch resets blocked', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          'git checkout -f -B feature HEAD~1',
          'git checkout --force',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'git checkout --forc -B feature HEAD~1',
          'git checkout --force',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'git switch -f -C feature HEAD~1',
          'git switch --force',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'git switch --discard-changes --force-creat feature HEAD~1',
          'git switch --discard-changes',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE keeps double-force clean blocked', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('git clean -ffdx', 'git clean -f', fixture.linkedWorktree);
        assertBlocked('git clean -f --force', 'git clean -f', fixture.linkedWorktree);
      });
    });
  });

  test('SAFETY_NET_WORKTREE fails closed on dynamic worktree relaxation bypasses', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      const mainWorktree = toShellPath(fixture.mainWorktree);
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        const commands = [
          {
            command: 'echo -ffdx | xargs -I{} git clean -f {}',
            reason: 'git clean -f',
          },
          {
            command: 'EXTRA=-ffdx; git clean -f $EXTRA',
            reason: 'git clean -f',
          },
          {
            command: 'git clean -f *',
            reason: 'git clean -f',
          },
          {
            command: 'git reset --hard $(printf HEAD~1)',
            reason: 'git reset --hard',
          },
          {
            command: 'git clean -f `printf -- -ffdx`',
            reason: 'git clean -f',
          },
          {
            command: "printf -- '-ffdx\\n' | parallel sh -c 'git clean -f {}'",
            reason: 'git clean -f',
          },
          {
            command:
              'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=submodule.recurse GIT_CONFIG_VALUE_0=true git reset --hard',
            reason: 'git reset --hard',
          },
          {
            command:
              'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=submodule.recurse GIT_CONFIG_VALUE_0=true; git reset --hard',
            reason: 'git reset --hard',
          },
          {
            command: `GIT_WORK_TREE=${mainWorktree} readonly GIT_WORK_TREE; git reset --hard`,
            reason: 'git reset --hard',
          },
          {
            command: `export -p GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            reason: 'git reset --hard',
          },
          {
            command: `builtin -- export GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            reason: 'git reset --hard',
          },
          {
            command: `read GIT_WORK_TREE <<< ${mainWorktree}; export GIT_WORK_TREE; git reset --hard`,
            reason: 'git reset --hard',
          },
          {
            command: `readonly -x GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            reason: 'git reset --hard',
          },
          {
            command: `command -p export GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            reason: 'git reset --hard',
          },
          {
            command: 'git checkout -fB feature HEAD~1',
            reason: 'git checkout --force',
          },
          {
            command: 'git switch --discard-changes -C feature HEAD~1',
            reason: 'git switch --discard-changes',
          },
          {
            command: 'git switch --discard-changes --force-create feature HEAD~1',
            reason: 'git switch --discard-changes',
          },
          {
            command: 'git switch -fC feature HEAD~1',
            reason: 'git switch --force',
          },
          {
            command: `set -k; git restore file.txt GIT_WORK_TREE=${mainWorktree}`,
            reason: 'git restore',
          },
          {
            command: `set -o keyword; git restore file.txt GIT_WORK_TREE=${mainWorktree}`,
            reason: 'git restore',
          },
          {
            command: `set -a; set -- +a; GIT_WORK_TREE=${mainWorktree}; git restore file.txt`,
            reason: 'git restore',
          },
          {
            command: `set +a -a; GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            reason: 'git reset --hard',
          },
          {
            command: `typeset +x -x GIT_WORK_TREE=${mainWorktree}; git reset --hard`,
            reason: 'git reset --hard',
          },
        ];

        const failures = commands.flatMap(({ command, reason }) => {
          const result = runGuard(command, fixture.linkedWorktree);
          return result?.includes(reason) ? [] : [{ command, result }];
        });

        expect(failures).toEqual([]);
      });
    });
  });

  test('SAFETY_NET_WORKTREE disables relaxation for numbered parallel placeholders', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          "parallel sh -c 'git clean -f {2}' ::: x ::: -ffdx",
          'git clean -f',
          fixture.linkedWorktree,
        );
        assertBlocked(
          'parallel git clean -f {2} ::: x ::: -ffdx',
          'git clean -f',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE does not execute git from PATH while checking config', () => {
    const fixture = createLinkedWorktreeFixture();
    const fakeBin = join(fixture.rootDir, 'fake-bin');
    const fakeGit = join(fakeBin, 'git');
    const marker = join(fixture.rootDir, 'fake-git-executed');
    mkdirSync(fakeBin);
    writeFileSync(fakeGit, `#!/bin/sh\nprintf executed > "${marker}"\nexit 1\n`);
    chmodSync(fakeGit, 0o755);
    try {
      withEnv({ SAFETY_NET_WORKTREE: '1', PATH: fakeBin }, () => {
        expect(runGuard('git reset --hard', fixture.linkedWorktree)).toBeNull();
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('SAFETY_NET_WORKTREE keeps configured recursive submodule discards blocked', () => {
    const fixture = createLinkedWorktreeFixture();
    try {
      runGit(fixture.linkedWorktree, ['config', 'submodule.recurse', 'true']);

      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('git reset --hard', 'git reset --hard', fixture.linkedWorktree);
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('SAFETY_NET_WORKTREE verifies worktree config before relaxing', () => {
    const fixture = createLinkedWorktreeFixture();
    try {
      runGit(fixture.mainWorktree, ['config', 'extensions.worktreeConfig', 'true']);
      runGit(fixture.linkedWorktree, [
        'config',
        '--worktree',
        'core.worktree',
        fixture.mainWorktree,
      ]);

      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('git reset --hard', 'git reset --hard', fixture.linkedWorktree);
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('SAFETY_NET_WORKTREE propagates interpreter wrapper context', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked(
          `GIT_WORK_TREE=${toShellPath(fixture.mainWorktree)} ruby -e '\`git restore file.txt\`'`,
          'git restore',
          fixture.linkedWorktree,
        );
      });
    });
  });

  test('SAFETY_NET_WORKTREE keeps shared and remote destructive rules blocked', async () => {
    await withReadonlyLinkedWorktreeFixture((fixture) => {
      withEnv({ SAFETY_NET_WORKTREE: '1' }, () => {
        assertBlocked('git push -f', 'push --force', fixture.linkedWorktree);
        assertBlocked(
          'git branch -D feature/worktree-test',
          'git branch -D',
          fixture.linkedWorktree,
        );
        assertBlocked('git stash clear', 'git stash clear', fixture.linkedWorktree);
        assertBlocked(
          'git worktree remove --force ../other-worktree',
          'git worktree remove --force',
          fixture.linkedWorktree,
        );
      });
    });
  });
});

describe('git push', () => {
  test('git push --force blocked', () => {
    assertBlocked('git push --force', 'push --force');
  });

  test('git push --force origin main blocked', () => {
    assertBlocked('git push --force origin main', 'push --force');
  });

  test('git push -f blocked', () => {
    assertBlocked('git push -f', 'push --force');
  });

  test('git push -f origin main blocked', () => {
    assertBlocked('git push -f origin main', 'push --force');
  });

  test('git push abbreviated force blocked conservatively', () => {
    assertBlocked('git push --forc origin main', 'push --force');
  });

  test('git push mirror blocked', () => {
    assertBlocked('git push --mirror origin', 'push --mirror');
  });

  test('git push abbreviated mirror blocked conservatively', () => {
    assertBlocked('git push --mir origin', 'push --mirror');
  });

  test('git push leading plus refspecs are blocked as force pushes', () => {
    assertBlocked('git push origin +main', 'push --force');
    assertBlocked('git push origin refs/heads/main:+refs/heads/main', 'push --force');
    assertBlocked('git push origin -- +refs/heads/main', 'push --force');
  });

  test('git push deletion refspecs are blocked', () => {
    assertBlocked('git push --delete origin old-branch', 'git push delete');
    assertBlocked('git push origin --delete old-branch', 'git push delete');
    assertBlocked('git push origin :old-branch', 'git push delete');
    assertBlocked('git push origin :refs/heads/old-branch', 'git push delete');
  });

  test('git push --force-with-lease allowed', () => {
    assertAllowed('git push --force-with-lease');
  });

  test('git push --force-with-lease origin main allowed', () => {
    assertAllowed('git push --force-with-lease origin main');
  });

  test('git push --force-with-lease=refs/heads/main allowed', () => {
    assertAllowed('git push --force-with-lease=refs/heads/main');
  });

  test('git push --force --force-with-lease blocked', () => {
    assertBlocked('git push --force --force-with-lease', 'push --force');
  });

  test('git push -f --force-with-lease blocked', () => {
    assertBlocked('git push -f --force-with-lease', 'push --force');
  });

  test('git push origin main allowed', () => {
    assertAllowed('git push origin main');
  });

  test('git push matching refspec allowed', () => {
    assertAllowed('git push origin main:main');
  });
});

describe('git worktree', () => {
  test('git worktree remove --force blocked', () => {
    assertBlocked('git worktree remove --force /tmp/wt', 'git worktree remove --force');
  });

  test('git worktree remove -f blocked', () => {
    assertBlocked('git worktree remove -f /tmp/wt', 'git worktree remove --force');
  });

  test('git worktree remove bundled force blocked', () => {
    assertBlocked('git worktree remove -fa /tmp/wt', 'git worktree remove --force');
  });

  test('git worktree remove abbreviated force blocked', () => {
    assertBlocked('git worktree remove --forc /tmp/wt', 'git worktree remove --force');
  });

  test('git worktree remove without force allowed', () => {
    assertAllowed('git worktree remove /tmp/wt');
  });

  test('git worktree remove -- -f allowed', () => {
    assertAllowed('git worktree remove -- -f');
  });
});

describe('git branch', () => {
  test('git branch -D blocked', () => {
    assertBlocked('git branch -D feature', 'git branch -D');
  });

  test('git branch -Dv blocked', () => {
    assertBlocked('git branch -Dv feature', 'git branch -D');
  });

  test('git branch long force delete blocked', () => {
    assertBlocked('git branch --delete --force feature', 'git branch -D');
    assertBlocked('git branch --force --delete feature', 'git branch -D');
    assertBlocked('git branch -d -f feature', 'git branch -D');
  });

  test('git branch abbreviated long force delete blocked', () => {
    assertBlocked('git branch --del --forc feature', 'git branch -D');
  });

  test('git branch -d allowed', () => {
    assertAllowed('git branch -d feature');
  });
});

describe('git missing destructive subcommands', () => {
  test('git reset abbreviated hard and merge blocked', () => {
    assertBlocked('git reset --ha HEAD~1', 'git reset --hard');
    assertBlocked('git reset --har HEAD~1', 'git reset --hard');
    assertBlocked('git reset --mer HEAD~1', 'git reset --merge');
  });

  test('git clean abbreviated force blocked unless dry-run is present', () => {
    assertBlocked('git clean --forc', 'git clean -f');
    assertAllowed('git clean --dry-r --forc');
    assertAllowed('git clean --forc --dry-r');
  });

  test('git rebase abort blocked', () => {
    assertBlocked('git rebase --abort', 'git rebase --abort');
  });

  test('git rebase abbreviated abort blocked', () => {
    assertBlocked('git rebase --abor', 'git rebase --abort');
  });

  test('git merge abort blocked', () => {
    assertBlocked('git merge --abort', 'git merge --abort');
  });

  test('git merge abbreviated abort blocked', () => {
    assertBlocked('git merge --abor', 'git merge --abort');
  });

  test('git tag delete blocked', () => {
    assertBlocked('git tag -d v1', 'git tag -d');
    assertBlocked('git tag --delete v1', 'git tag -d');
  });

  test('git tag abbreviated delete blocked', () => {
    assertBlocked('git tag --del v1', 'git tag -d');
  });

  test('git reflog delete blocked', () => {
    assertBlocked('git reflog delete HEAD@{0}', 'git reflog delete');
  });
});

describe('git stash', () => {
  test('git stash drop blocked', () => {
    assertBlocked('git stash drop', 'git stash drop');
  });

  test('git stash drop stash@{0} blocked', () => {
    assertBlocked('git stash drop stash@{0}', 'git stash drop');
  });

  test('git stash clear blocked', () => {
    assertBlocked('git stash clear', 'git stash clear');
  });

  test('git stash allowed', () => {
    assertAllowed('git stash');
  });

  test('git stash list allowed', () => {
    assertAllowed('git stash list');
  });

  test('git stash pop allowed', () => {
    assertAllowed('git stash pop');
  });
});

describe('git edge cases', () => {
  test('git -- without subcommand allowed', () => {
    assertAllowed('git --');
  });

  test('git -- followed by option allowed', () => {
    assertAllowed('git -- --help');
  });
});

describe('git ssh environment overrides', () => {
  test('GIT_SSH_COMMAND blocks network operations', () => {
    assertBlocked(
      'GIT_SSH_COMMAND=\'sh -c "rm -rf /"\' git fetch',
      'Git SSH environment overrides',
    );
  });

  test('GIT_SSH blocks network operations', () => {
    assertBlocked('GIT_SSH=./malicious git push origin main', 'Git SSH environment overrides');
  });

  test('GIT_SSH_VARIANT blocks network operations', () => {
    assertBlocked('GIT_SSH_VARIANT=plink git clone example:repo', 'Git SSH environment overrides');
  });

  test('exported GIT_SSH_COMMAND blocks later network operations', () => {
    assertBlocked(
      'export GIT_SSH_COMMAND=./malicious; git ls-remote origin',
      'Git SSH environment overrides',
    );
  });

  test('GIT_SSH_COMMAND blocks remote archive operations', () => {
    assertBlocked(
      'GIT_SSH_COMMAND=./helper git archive --remote=ssh://example/repo HEAD',
      'Git SSH environment overrides',
    );
  });

  test('GIT_SSH_COMMAND blocks remote update operations', () => {
    assertBlocked('GIT_SSH_COMMAND=./helper git remote update', 'Git SSH environment overrides');
  });

  test('GIT_SSH_COMMAND blocks verbose remote update operations', () => {
    assertBlocked('GIT_SSH_COMMAND=./helper git remote -v update', 'Git SSH environment overrides');
  });

  test('GIT_SSH_COMMAND still allows non-network git status', () => {
    assertAllowed('GIT_SSH_COMMAND=./helper git status');
  });

  test('GIT_SSH_COMMAND still allows local archive operations', () => {
    assertAllowed('GIT_SSH_COMMAND=./helper git archive HEAD');
  });

  test('GIT_SSH_COMMAND still allows local remote listing operations', () => {
    assertAllowed('GIT_SSH_COMMAND=./helper git remote -v');
  });

  test('core.sshCommand blocks network operations', () => {
    assertBlocked(
      'git -c core.sshCommand=./malicious fetch origin',
      'Git SSH environment overrides',
    );
    assertBlocked(
      'git -ccore.sshCommand=./malicious push origin main',
      'Git SSH environment overrides',
    );
  });

  test('core.sshCommand still allows non-network git status', () => {
    assertAllowed('git -c core.sshCommand=./helper status');
  });

  test('core.sshCommand from Git config env blocks network operations', () => {
    assertBlocked(
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0=ssh git fetch origin',
      'Git SSH environment overrides',
    );
  });

  test('core.sshCommand from Git config env still allows non-network git status', () => {
    assertAllowed(
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0=ssh git status',
    );
  });

  test('core.sshCommand from GIT_CONFIG_PARAMETERS blocks network operations', () => {
    assertBlocked(
      `GIT_CONFIG_PARAMETERS="'core.sshCommand=ssh'" git fetch origin`,
      'Git SSH environment overrides',
    );
  });

  test('inherited GIT_SSH_COMMAND blocks network operations', () => {
    assertBlocked(
      'git fetch origin',
      'Git SSH environment overrides',
      undefined,
      testEnvironment({ GIT_SSH_COMMAND: './malicious' }),
    );
  });

  test('inherited GIT_SSH blocks network operations', () => {
    assertBlocked(
      'git fetch origin',
      'Git SSH environment overrides',
      undefined,
      testEnvironment({ GIT_SSH: './malicious' }),
    );
  });

  test('inherited Git SSH env still allows non-network git status', () => {
    assertAllowed(
      'git status',
      undefined,
      testEnvironment({ GIT_SSH_COMMAND: './helper', GIT_SSH: './helper' }),
    );
  });

  test('unset inherited Git SSH env allows later network operations', () => {
    assertAllowed(
      'unset GIT_SSH_COMMAND GIT_SSH; git fetch origin',
      undefined,
      testEnvironment({ GIT_SSH_COMMAND: './malicious', GIT_SSH: './malicious' }),
    );
  });
});

describe('safe commands', () => {
  test('git allowed', () => {
    assertAllowed('git');
  });

  test('git --help allowed', () => {
    assertAllowed('git --help');
  });

  test('git status allowed', () => {
    assertAllowed('git status');
  });

  test('git -C repo status allowed', () => {
    assertAllowed('git -C repo status');
  });

  test('git status global option -C allowed', () => {
    assertAllowed('git -Crepo status');
  });

  test('sudo env VAR=1 git status allowed', () => {
    assertAllowed('sudo env VAR=1 git status');
  });

  test('git diff allowed', () => {
    assertAllowed('git diff');
  });

  test('git log --oneline -10 allowed', () => {
    assertAllowed('git log --oneline -10');
  });

  test('git add . allowed', () => {
    assertAllowed('git add .');
  });

  test("git commit -m 'test' allowed", () => {
    assertAllowed("git commit -m 'test'");
  });

  test('git pull allowed', () => {
    assertAllowed('git pull');
  });

  test("bash -c 'echo ok' allowed", () => {
    assertAllowed("bash -c 'echo ok'");
  });

  test('python -c "print(\'ok\')" allowed', () => {
    assertAllowed('python -c "print(\'ok\')"');
  });

  test('ls -la allowed', () => {
    assertAllowed('ls -la');
  });

  test('cat file.txt allowed', () => {
    assertAllowed('cat file.txt');
  });
});
