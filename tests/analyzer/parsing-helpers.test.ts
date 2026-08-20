/**
 * Targeted unit tests for helper parsers in the safety net.
 *
 * These focus on option-scanning branches that are hard to hit via end-to-end
 * command strings, improving confidence (and coverage) of the parsing logic.
 */

import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { toNamespacedPath } from 'node:path';
import { dangerousInTextMatch } from '@/analyzer/dangerous-text';
import { containsDangerousCode, extractInterpreterCodeArg } from '@/analyzer/interpreters';
import { extractParallelChildStart } from '@/analyzer/parallel';
import {
  extractDashCArg,
  extractShellStartupLoaderMetadata,
  isShellSyntaxCheck,
} from '@/analyzer/shell-wrappers';
import { isTrustedTempPath } from '@/analyzer/tmpdir';
import { stripWrappersWithInfo } from '@/analyzer/wrapper-prelude';
import { extractXargsChildCommandWithInfo } from '@/analyzer/xargs';
import { parseCommand } from '@/parser/command';
import { extractShortOpts, getShellCommandString } from '@/parser/shell';
import { hasUnclosedQuotes } from '@/parser/shell/shared';
import { projectCommandViews, projectSegmentWords } from '@/parser/traversal';
import { MAX_STRIP_ITERATIONS } from '@/rules/constants';
import { TEST_ENVIRONMENT, testEnvironment } from '../helpers/environment';
import { assertBlocked, createLinkedWorktreeFixture, withEnv } from '../helpers.ts';

const RM_COMMAND = ['r', 'm'].join('');
const RM_RECURSIVE_FORCE = ['-', 'r', 'f'].join('');

const dangerousInText = (text: string) => dangerousInTextMatch(text)?.reason ?? null;

const splitShellCommands = (command: string) =>
  projectSegmentWords(parseCommand(command)).map((segment) => [...segment]);

describe('shell parsing helpers', () => {
  describe('shared quote and token helpers', () => {
    test('ignores quotes in comments while preserving following physical lines', () => {
      expect(hasUnclosedQuotes("echo ok # 'ignored\necho done")).toBeFalse();
      expect(hasUnclosedQuotes("echo '# literal' \"unterminated")).toBeTrue();
    });

    test('does not treat an apostrophe inside double quotes as an open single quote', () => {
      expect(hasUnclosedQuotes('echo "it\'s fine"')).toBeFalse();
    });

    test('dangerous command wrapped in an interpreter -c string with an apostrophe inside a double-quoted argument is still blocked', () => {
      assertBlocked(`bash -c 'echo "it'"'"'s fine" && rm -rf /'`, 'rm -rf');
    });
  });

  describe('extractDashCArg', () => {
    test('returns null for empty tokens', () => {
      expect(extractDashCArg([])).toBeNull();
    });

    test('returns null for single token', () => {
      expect(extractDashCArg(['bash'])).toBeNull();
    });

    test('extracts arg after standalone -c', () => {
      expect(extractDashCArg(['bash', '-c', 'echo ok'])).toBe('echo ok');
    });

    test('extracts arg after standalone -c and option terminator', () => {
      expect(extractDashCArg(['bash', '-c', '--', 'echo ok'])).toBe('echo ok');
    });

    test('extracts arg after bundled -lc', () => {
      expect(extractDashCArg(['bash', '-lc', 'echo ok'])).toBe('echo ok');
    });

    test('extracts arg after bundled -lc and option terminator', () => {
      expect(extractDashCArg(['bash', '-lc', '--', 'echo ok'])).toBe('echo ok');
    });

    test('extracts arg after bundled -xc', () => {
      expect(extractDashCArg(['sh', '-xc', 'rm -rf /'])).toBe('rm -rf /');
    });

    test('returns null when -c has no following arg', () => {
      expect(extractDashCArg(['bash', '-c'])).toBeNull();
    });

    test('returns null when bundled option has no following arg', () => {
      expect(extractDashCArg(['bash', '-lc'])).toBeNull();
    });

    test('handles -- separator before -c (implementation scans past it)', () => {
      expect(extractDashCArg(['bash', '--', '-c', 'echo'])).toBe('echo');
    });

    test('ignores long options starting with --', () => {
      expect(extractDashCArg(['bash', '--rcfile', 'script'])).toBeNull();
    });

    test('returns null when next token starts with dash', () => {
      expect(extractDashCArg(['bash', '-lc', '-x'])).toBeNull();
    });

    test('handles -c appearing later in tokens', () => {
      expect(extractDashCArg(['bash', '-l', '-c', 'echo ok'])).toBe('echo ok');
    });
  });

  describe('isShellSyntaxCheck', () => {
    test('recognizes standalone and clustered no-exec flags', () => {
      expect(isShellSyntaxCheck(['bash', '-n', '-c', 'rm -rf /'])).toBeTrue();
      expect(isShellSyntaxCheck(['bash', '-nc', 'rm -rf /'])).toBeTrue();
      expect(isShellSyntaxCheck(['bash', '-n', 'script.sh'])).toBeTrue();
    });

    test('does not treat command arguments or disabled no-exec flags as syntax checks', () => {
      expect(isShellSyntaxCheck(['bash', '-c', 'rm -rf /', '-n'])).toBeFalse();
      expect(isShellSyntaxCheck(['bash', '-n', '+n', '-c', 'rm -rf /'])).toBeFalse();
    });
  });

  describe('shell executable sources', () => {
    test('locates inline commands and main scripts after value-taking options', () => {
      expect(getShellCommandString('bash', ['--rcfile=profile', '-c', 'echo ok'])).toBe('echo ok');
      expect(getShellCommandString('bash', ['--rcfile', 'profile', '-c', 'echo ok'])).toBe(
        'echo ok',
      );
      expect(getShellCommandString('bash', ['--rcfile'])).toBeNull();
    });

    test('reports startup files and environment loading only when the shell mode applies', () => {
      expect(extractShellStartupLoaderMetadata(['bash', '--rcfile', 'profile', '-i'])).toEqual({
        argvSource: { kind: 'literal', value: 'profile' },
        argvSourceApplies: true,
        envName: 'BASH_ENV',
        envSourceApplies: false,
      });
      expect(extractShellStartupLoaderMetadata(['bash', '--rcfile'])).toMatchObject({
        argvSource: { kind: 'absent' },
        argvSourceApplies: false,
      });
      expect(extractShellStartupLoaderMetadata(['sh', '-i'])).toMatchObject({
        envName: 'ENV',
        envSourceApplies: true,
      });
    });
  });

  describe('extractShortOpts', () => {
    test('stops at double dash', () => {
      // given: tokens with -Ap after -- (a filename, not options)
      // when: extracting short options
      // then: A and p should NOT be in the result
      expect(extractShortOpts(['git', 'add', '--', '-Ap'])).toEqual(new Set());
      expect(extractShortOpts(['rm', '-r', '--', '-f'])).toEqual(new Set(['-r']));
    });

    test('extracts before double dash', () => {
      // given: tokens with options before --
      // when: extracting short options
      // then: only options before -- are extracted
      expect(extractShortOpts(['git', '-v', 'add', '-n', '--', '-x'])).toEqual(
        new Set(['-v', '-n']),
      );
    });

    test('stops after short options with attached values when configured', () => {
      expect(
        extractShortOpts(['git', 'switch', '-cfeature'], {
          shortOptsWithValue: new Set(['-c', '-C']),
        }),
      ).toEqual(new Set(['-c']));
      expect(
        extractShortOpts(['git', 'switch', '-qcfeature'], {
          shortOptsWithValue: new Set(['-c', '-C']),
        }),
      ).toEqual(new Set(['-q', '-c']));
      expect(
        extractShortOpts(['git', 'switch', '-Cfixup'], {
          shortOptsWithValue: new Set(['-c', '-C']),
        }),
      ).toEqual(new Set(['-C']));
    });
  });

  describe('splitShellCommands', () => {
    test('still enumerates words when quotes are unclosed', () => {
      expect(splitShellCommands('echo "unterminated')).toEqual([['echo', 'unterminated']]);
    });

    test('ignores trailing shell comments without creating extra segments', () => {
      expect(splitShellCommands('echo hi # comment')).toEqual([['echo', 'hi']]);
    });

    test('keeps commands after shell comments on physical newlines visible', () => {
      expect(splitShellCommands('echo hi # comment\nrm -rf /')).toEqual([
        ['echo', 'hi'],
        ['rm', '-rf', '/'],
      ]);
    });

    test('ignores quotes inside comments without hiding the following line', () => {
      expect(splitShellCommands("echo hi # 'comment\nrm -rf /")).toEqual([
        ['echo', 'hi'],
        ['rm', '-rf', '/'],
      ]);
    });

    test('keeps an arithmetic expansion as one word of its command', () => {
      expect(splitShellCommands('echo $((1+2))')).toEqual([['echo', '']]);
    });

    test('does not split arithmetic comparisons, shifts or stars into shell syntax', () => {
      expect(splitShellCommands('echo $((2>1))')).toEqual([['echo', '']]);
      expect(splitShellCommands('echo $((123>>1))')).toEqual([['echo', '']]);
      expect(splitShellCommands('echo $((1*2))')).toEqual([['echo', '']]);
    });

    test('extracts backtick substitution segments', () => {
      expect(splitShellCommands('echo `date`')).toEqual([['echo', ''], ['date']]);
    });

    test('extracts $() substitution segments split on operators', () => {
      expect(splitShellCommands('echo $(rm -rf /tmp/x && echo ok)')).toEqual([
        ['echo', ''],
        ['rm', '-rf', '/tmp/x'],
        ['echo', 'ok'],
      ]);
    });

    test('extracts multiple backtick substitutions while preserving the literal suffix', () => {
      expect(splitShellCommands('echo `a`:`b`')).toEqual([['echo', ':'], ['a'], ['b']]);
    });

    test('handles nested $(...) with operators', () => {
      const result = splitShellCommands('echo $(echo $(rm -rf /tmp/x))');
      expect(result.length).toBeGreaterThan(1);
      const flat = result.flat();
      expect(flat).toContain('rm');
      expect(flat).toContain('-rf');
    });

    test('treats grouped subshells inside command substitutions as commands, not arithmetic', () => {
      expect(splitShellCommands('echo $( (git reset --hard) )')).toEqual([
        ['echo', ''],
        ['git', 'reset', '--hard'],
      ]);
      expect(splitShellCommands('echo $( (rm -rf /) )')).toEqual([
        ['echo', ''],
        ['rm', '-rf', '/'],
      ]);
    });

    test('handles deeply nested $(...) substitutions', () => {
      const result = splitShellCommands('echo $(a $(b $(c)))');
      expect(result.length).toBeGreaterThan(1);
    });

    test('handles $(...) with semicolon operators', () => {
      expect(splitShellCommands('echo $(cd /tmp; rm -rf .)')).toEqual([
        ['echo', ''],
        ['cd', '/tmp'],
        ['rm', '-rf', '.'],
      ]);
    });

    test('handles $(...) with pipe operators', () => {
      expect(splitShellCommands('echo $(cat file | rm -rf /)')).toEqual([
        ['echo', ''],
        ['cat', 'file'],
        ['rm', '-rf', '/'],
      ]);
    });

    test('handles unterminated $() substitution (no hang, still extracts tokens)', () => {
      expect(splitShellCommands('echo $(rm -rf /tmp/x')).toEqual([
        ['echo', ''],
        ['rm', '-rf', '/tmp/x'],
      ]);
    });

    test('drops plain redirect targets and attached fd prefixes', () => {
      expect(splitShellCommands('rm -rf ./foo 2>/dev/null')).toEqual([['rm', '-rf', './foo']]);
      expect(splitShellCommands('rm -rf ./foo 2>&1')).toEqual([['rm', '-rf', './foo']]);
      expect(splitShellCommands('rm -rf ./foo 2>>/tmp/log')).toEqual([['rm', '-rf', './foo']]);
    });

    test('keeps spaced numeric args and quoted redirect literals intact', () => {
      expect(splitShellCommands('rm -rf 123>/dev/null')).toEqual([['rm', '-rf']]);
      expect(splitShellCommands('rm -rf 7 > /dev/null')).toEqual([['rm', '-rf', '7']]);
      expect(splitShellCommands('rm -rf 123 >/dev/null')).toEqual([['rm', '-rf', '123']]);
      expect(splitShellCommands('rm -rf ./foo 2 > /dev/null')).toEqual([
        ['rm', '-rf', './foo', '2'],
      ]);
      expect(splitShellCommands("echo '2>/dev/null'")).toEqual([['echo', '2>/dev/null']]);
    });

    test('keeps nested command substitutions in redirect targets analyzable', () => {
      expect(splitShellCommands('echo x >$(git reset --hard)')).toEqual([
        ['echo', 'x'],
        ['git', 'reset', '--hard'],
      ]);
    });

    test('reports attached command substitution metadata generically', () => {
      expect(splitShellCommands('git reset --hard$(printf HEAD~1)')).toEqual([
        ['git', 'reset', '--hard'],
        ['printf', 'HEAD~1'],
      ]);
      const gitViews = projectCommandViews(parseCommand('git reset --hard$(printf HEAD~1)'));
      const rmViews = projectCommandViews(parseCommand('rm -rf /tmp/$(printf x)'));

      expect(gitViews[0]?.words[2]?.provenance).toBe('command-substitution');
      expect(rmViews[0]?.words[2]?.provenance).toBe('command-substitution');
    });

    test('represents command substitution output in outer segments', () => {
      const substitution = [String.fromCharCode(36), '(printf /)'].join('');
      const views = projectCommandViews(
        parseCommand([RM_COMMAND, RM_RECURSIVE_FORCE, substitution].join(' ')),
      );

      expect(views.map((view) => view.words.map((word) => word.text))).toEqual([
        [RM_COMMAND, RM_RECURSIVE_FORCE, ''],
        ['printf', '/'],
      ]);
      expect(views[0]?.words[2]?.provenance).toBe('command-substitution');
    });

    test('represents attached command substitution output in outer tokens', () => {
      const substitution = [String.fromCharCode(36), '(printf m)'].join('');
      const views = projectCommandViews(parseCommand(`r${substitution} ${RM_RECURSIVE_FORCE} /`));

      expect(views.map((view) => view.words.map((word) => word.text))).toEqual([
        ['r', RM_RECURSIVE_FORCE, '/'],
        ['printf', 'm'],
      ]);
      expect(views[0]?.words[0]?.provenance).toBe('command-substitution');
    });

    test('drops glob redirect targets instead of treating them as args', () => {
      expect(splitShellCommands('echo > *.log')).toEqual([['echo']]);
    });

    test('drops glob redirect targets inside command substitutions', () => {
      expect(splitShellCommands('echo $(echo > *.log)')).toEqual([['echo', ''], ['echo']]);
    });

    test('keeps attached command substitutions in redirect targets analyzable', () => {
      const gitResult = splitShellCommands('rm -rf /tmp/foo >file$(git reset --hard)');
      const rmResult = splitShellCommands('rm -rf /tmp/foo >$TMPDIR/$(rm -rf /)');

      expect(gitResult).toContainEqual(['git', 'reset', '--hard']);
      expect(gitResult).toContainEqual(['rm', '-rf', '/tmp/foo']);
      expect(rmResult).toContainEqual(['rm', '-rf', '/']);
      expect(rmResult).toContainEqual(['rm', '-rf', '/tmp/foo']);
    });

    test('keeps operands after redirects in the same segment', () => {
      expect(splitShellCommands('rm -rf 2>/dev/null /')).toEqual([['rm', '-rf', '/']]);
      expect(splitShellCommands('git checkout 2>/dev/null -- foo')).toEqual([
        ['git', 'checkout', '--', 'foo'],
      ]);
    });

    test('keeps nested command substitutions visible inside arithmetic expansion', () => {
      const gitResult = splitShellCommands('echo $(( $(git reset --hard) + 1 ))');
      expect(gitResult).toContainEqual(['git', 'reset', '--hard']);

      const rmResult = splitShellCommands('echo $(( $(rm -rf /) + 1 ))');
      expect(rmResult).toContainEqual(['rm', '-rf', '/']);
    });

    test('keeps adjacent nested command substitutions visible inside arithmetic expansion', () => {
      const gitResult = splitShellCommands('echo $((foo+$(git reset --hard)))');
      expect(gitResult).toContainEqual(['git', 'reset', '--hard']);

      const rmResult = splitShellCommands('echo $((1+$(rm -rf /)))');
      expect(rmResult).toContainEqual(['rm', '-rf', '/']);
    });

    test('keeps backtick command substitutions visible inside arithmetic expansion', () => {
      expect(splitShellCommands('echo $((`git reset --hard` + 1))')).toContainEqual([
        'git',
        'reset',
        '--hard',
      ]);
      expect(splitShellCommands('echo $((foo`git reset --hard`bar))')).toContainEqual([
        'git',
        'reset',
        '--hard',
      ]);
    });

    test('keeps a spaced nested command substitution inside arithmetic analyzable', () => {
      expect(splitShellCommands('echo $((1 + $(git status)))')).toEqual([
        ['echo', ''],
        ['git', 'status'],
      ]);
    });

    test('keeps nested arithmetic parentheses in one word', () => {
      expect(splitShellCommands('echo $(((1+2)))')).toEqual([['echo', '']]);
    });

    test('handles malformed arithmetic substitutions without hanging', () => {
      expect(splitShellCommands('echo $((1+(2))')).toEqual([['echo', '']]);
      expect(splitShellCommands('echo $((1+2)')).toEqual([['echo', '']]);
    });

    test('handles arithmetic substitutions that reach EOF without a closing parenthesis', () => {
      expect(splitShellCommands('echo $((1+2')).toEqual([['echo', '']]);
      expect(splitShellCommands('echo $((1+$(git status)')).toEqual([
        ['echo', ''],
        ['git', 'status'],
      ]);
    });

    test('does not treat quoted arithmetic expansion as command substitution', () => {
      expect(splitShellCommands('echo "$(( rm -rf /x ))"')).toEqual([['echo', '$(( rm -rf /x ))']]);
      expect(splitShellCommands('echo "$(( foo + bar ))"')).toEqual([['echo', '$(( foo + bar ))']]);
    });

    test('keeps backtick substitutions inside quoted redirect targets analyzable', () => {
      const result = splitShellCommands('echo x >"`git reset --hard`"');

      expect(result).toContainEqual(['git', 'reset', '--hard']);
      expect(result).toContainEqual(['echo', 'x']);
    });

    test('keeps bare backtick redirect targets analyzable', () => {
      expect(splitShellCommands('rm -rf /tmp/foo >`git reset --hard`')).toEqual([
        ['rm', '-rf', '/tmp/foo'],
        ['git', 'reset', '--hard'],
      ]);
      expect(splitShellCommands('echo $(rm -rf /tmp/foo >`git reset --hard`)')).toEqual([
        ['echo', ''],
        ['rm', '-rf', '/tmp/foo'],
        ['git', 'reset', '--hard'],
      ]);
    });

    test('drops redirect targets inside nested command substitutions', () => {
      expect(splitShellCommands('echo $(rm -rf /tmp/foo 2>/dev/null)')).toEqual([
        ['echo', ''],
        ['rm', '-rf', '/tmp/foo'],
      ]);
    });

    test('ignores missing redirect targets without creating empty segments', () => {
      expect(splitShellCommands('echo >')).toEqual([['echo']]);
    });

    test('keeps process substitutions analyzable as separate segments', () => {
      expect(splitShellCommands('echo <(git reset --hard)')).toEqual([
        ['echo', ''],
        ['git', 'reset', '--hard'],
      ]);
      expect(splitShellCommands('cat >(git reset --hard)')).toEqual([
        ['cat', ''],
        ['git', 'reset', '--hard'],
      ]);
      expect(splitShellCommands('echo x > >(git reset --hard)')).toEqual([
        ['echo', 'x'],
        ['git', 'reset', '--hard'],
      ]);
      expect(splitShellCommands('echo foo < <(git reset --hard)')).toEqual([
        ['echo', 'foo'],
        ['git', 'reset', '--hard'],
      ]);
    });

    test('keeps arguments after quoted backticks in redirect targets visible', () => {
      expect(splitShellCommands("git checkout >'file`name' -- foo")).toEqual([
        ['git', 'checkout', '--', 'foo'],
      ]);
      expect(splitShellCommands("rm -rf >'file`name' /")).toEqual([['rm', '-rf', '/']]);
    });

    test('does not treat single-quoted backticks in redirect targets as commands', () => {
      expect(splitShellCommands("echo >'a`git reset --hard`b'")).toEqual([['echo']]);
    });

    test('keeps attached backtick substitutions analyzable outside redirect targets', () => {
      expect(splitShellCommands('echo foo`git reset --hard`bar')).toContainEqual([
        'git',
        'reset',
        '--hard',
      ]);
    });

    test('keeps quote boundary command substitutions analyzable', () => {
      expect(splitShellCommands("echo 'b\\'$(rm -rf /)'c'")).toContainEqual(['rm', '-rf', '/']);
      expect(splitShellCommands("echo 'b\\'$(printf ok)'c'")).toContainEqual(['printf', 'ok']);
    });

    test('does not treat an escaped inline substitution as executable', () => {
      expect(splitShellCommands('echo $(printf "x\\$(git status)y")')).toEqual([
        ['echo', ''],
        ['printf', 'x$(git status)y'],
      ]);
    });

    test('recognizes substitutions beside literal quote characters inside double quotes', () => {
      expect(splitShellCommands('echo $(printf "x\'$(git status)\'y")')).toContainEqual([
        'git',
        'status',
      ]);
      expect(splitShellCommands('echo $(printf "x\\"$(git status)\\"y")')).toContainEqual([
        'git',
        'status',
      ]);
    });

    test('tracks nested parentheses inside inline command substitutions', () => {
      // Nested "(" inside $(...) is not a valid shell command-sub boundary; projection keeps
      // the partial inner tokens without inventing a trailing empty operand.
      expect(splitShellCommands('echo "x$(printf y(z))"')).toEqual([
        ['echo', 'x'],
        ['printf', 'y(z'],
      ]);
    });

    test('tracks quoted and escaped content while scanning inline command substitutions', () => {
      expect(splitShellCommands('echo "x$(printf \'y\')w"')).toEqual([
        ['echo', 'xw'],
        ['printf', 'y'],
      ]);
      expect(splitShellCommands('echo \'x$(printf "y")w\'')).toEqual([['echo', 'x$(printf "y")w']]);
      expect(splitShellCommands("echo 'x$(printf y\\(z\\))w'")).toEqual([
        ['echo', 'x$(printf y\\(z\\))w'],
      ]);
      expect(splitShellCommands("echo 'x$(printf y(z)'")).toEqual([['echo', 'x$(printf y(z)']]);
    });

    test('preserves top level glob arguments', () => {
      expect(splitShellCommands('git add *.ts')).toEqual([['git', 'add', '*.ts']]);
    });

    test('preserves glob arguments inside command substitutions', () => {
      expect(splitShellCommands('echo $(git *.ts)')).toEqual([
        ['echo', ''],
        ['git', '*.ts'],
      ]);
    });

    test('preserves glob arguments while reconstructing redirect target substitutions', () => {
      expect(splitShellCommands('echo >foo$(git *.ts)')).toEqual([['echo'], ['git', '*.ts']]);
    });

    test('handles escaped backticks in redirect targets without hanging', () => {
      expect(splitShellCommands('echo x >`a\\` b`')).toEqual([
        ['echo', 'x'],
        ['a`', 'b'],
      ]);
    });

    test('extracts process substitution inside command substitution', () => {
      const result = splitShellCommands('echo $(diff <(cat file1) file2)');
      expect(result).toContainEqual(['cat', 'file1']);
      expect(result).toContainEqual(['diff', '', 'file2']);
    });

    test('keeps attached backtick suffix inside command substitution', () => {
      const result = splitShellCommands('echo $(cd `pwd`/subdir)');
      const flat = result.flat();
      expect(flat).toContain('cd');
      expect(flat.some((t) => t.includes('/subdir'))).toBe(true);
    });

    test('extracts attached command substitution inside command substitution', () => {
      const result = splitShellCommands('echo $(echo prefix$(inner cmd))');
      expect(result).toContainEqual(['inner', 'cmd']);
      const flat = result.flat();
      expect(flat).toContain('echo');
      expect(flat.some((t) => t.includes('prefix'))).toBe(true);
    });

    test('handles unclosed backtick without hanging', () => {
      const result = splitShellCommands('echo `unclosed');
      expect(result.length).toBeGreaterThanOrEqual(1);
      const flat = result.flat();
      expect(flat).toContain('echo');
    });

    test('handles operator token inside parenthesized redirect target', () => {
      const result = splitShellCommands('echo >log$(echo x | wc)');
      expect(result).toContainEqual(['echo', 'x']);
    });
  });

  describe('stripWrappersWithInfo', () => {
    test('preserves supported append assignments and env split-string semantics', () => {
      const appended = stripWrappersWithInfo(
        ['TMPDIR+=/nested', 'git', 'status'],
        TEST_ENVIRONMENT,
        '/tmp',
        new Map([['TMPDIR', '/base']]),
      );
      expect(appended.tokens).toEqual(['git', 'status']);
      expect(appended.envAssignments.get('TMPDIR')).toBe('/base/nested');

      const split = stripWrappersWithInfo(
        ['env', '-S', '--unset=DROP VALUE=${VALUE} printf one\\_two \\t', 'tail'],
        TEST_ENVIRONMENT,
        '/tmp',
        new Map([
          ['DROP', 'removed'],
          ['VALUE', 'kept'],
        ]),
      );
      expect(split.tokens).toEqual(['printf', 'one', 'two', '\t', 'tail']);
      expect(split.envAssignments).toEqual(
        new Map([
          ['DROP', ''],
          ['VALUE', 'kept'],
        ]),
      );
    });

    test('resolves inherited values from the analysis environment only', () => {
      const ambient = withEnv({ TMPDIR: '/ambient', VALUE: 'ambient' }, () =>
        stripWrappersWithInfo(
          ['TMPDIR+=/nested', 'env', '-S', 'printf ${VALUE}tail'],
          TEST_ENVIRONMENT,
        ),
      );
      expect(ambient.envAssignments.get('TMPDIR')).toBe('/nested');
      expect(ambient.tokens).toEqual(['printf', 'tail']);

      const injected = stripWrappersWithInfo(
        ['TMPDIR+=/nested', 'env', '-S', 'printf ${VALUE}tail'],
        testEnvironment({ TMPDIR: '/base', VALUE: 'kept' }),
      );
      expect(injected.envAssignments.get('TMPDIR')).toBe('/base/nested');
      expect(injected.tokens).toEqual(['printf', 'kepttail']);
    });

    test('strips sudo options that consume a value', () => {
      const result = stripWrappersWithInfo(
        ['sudo', '-u', 'root', 'rm', '-rf', '/tmp/a'],
        TEST_ENVIRONMENT,
      );
      expect(result.tokens).toEqual(['rm', '-rf', '/tmp/a']);
    });

    test('strips sudo options that do not consume a value', () => {
      const result = stripWrappersWithInfo(['sudo', '-n', 'rm', '-rf', '/tmp/a'], TEST_ENVIRONMENT);
      expect(result.tokens).toEqual(['rm', '-rf', '/tmp/a']);
    });

    test('strips env -C=...', () => {
      const result = stripWrappersWithInfo(['env', '-C=/tmp', 'rm', '-rf'], TEST_ENVIRONMENT);
      expect(result.tokens).toEqual(['rm', '-rf']);
    });

    test('invalid env -S split string makes cwd unknown', () => {
      const result = stripWrappersWithInfo(
        ['env', '-S', '"unterminated', 'git', 'status'],
        TEST_ENVIRONMENT,
        '/tmp',
      );
      expect(result.tokens).toEqual(['git', 'status']);
      expect(result.cwd).toBeNull();
    });

    test('marks an over-limit env -S split string as unverifiable', () => {
      const result = stripWrappersWithInfo(
        ['env', '-S', Array.from({ length: 16_385 }, () => 'x').join(' ')],
        TEST_ENVIRONMENT,
      );
      expect(result.unverifiableEnvSplit).toBeTrue();
    });

    test('empty env chdir target makes cwd unknown', () => {
      const result = stripWrappersWithInfo(
        ['env', '-C', '', 'git', 'status'],
        TEST_ENVIRONMENT,
        '/tmp',
      );
      expect(result.tokens).toEqual(['git', 'status']);
      expect(result.cwd).toBeNull();
    });

    test('relative env chdir target with unknown cwd remains unknown', () => {
      const result = stripWrappersWithInfo(
        ['env', '-C', 'relative', 'git', 'status'],
        TEST_ENVIRONMENT,
        null,
      );
      expect(result.tokens).toEqual(['git', 'status']);
      expect(result.cwd).toBeNull();
    });

    test.skipIf(process.platform !== 'win32')(
      '[windows] keeps wrapper cwd unknown for Windows namespace operands',
      () => {
        const namespace = toNamespacedPath(process.cwd());
        for (const tokens of [
          ['env', '-C', namespace, 'rm', '-rf', 'dist'],
          ['env', `--chdir=${namespace}`, 'rm', '-rf', 'dist'],
          ['sudo', '-D', namespace, 'rm', '-rf', 'dist'],
          ['sudo', `--chdir=${namespace}`, 'rm', '-rf', 'dist'],
        ]) {
          const result = stripWrappersWithInfo(tokens, TEST_ENVIRONMENT, process.cwd());
          expect(result.tokens).toEqual(['rm', '-rf', 'dist']);
          expect(result.cwd).toBeNull();
        }
      },
    );

    test.skipIf(process.platform !== 'win32')(
      '[windows] resolves wrapper cwd with Windows separators',
      () => {
        const fixture = createLinkedWorktreeFixture();
        try {
          const result = stripWrappersWithInfo(
            ['env', '-C', fixture.mainWorktree, '-C', '..\\linked', 'git', 'status'],
            TEST_ENVIRONMENT,
            fixture.rootDir,
          );
          expect(result.tokens).toEqual(['git', 'status']);
          expect(result.cwd).toBe(realpathSync(fixture.linkedWorktree));
        } finally {
          fixture.cleanup();
        }
      },
    );

    test('strips command -pv and -- separator', () => {
      const result = stripWrappersWithInfo(
        ['command', '-pv', '--', 'git', 'status'],
        TEST_ENVIRONMENT,
      );
      expect(result.tokens).toEqual(['git', 'status']);
    });

    test('captures env assignments after hitting max strip iterations', () => {
      const tokens = Array.from({ length: MAX_STRIP_ITERATIONS }, () => 'sudo');
      tokens.push('FOO=bar', 'rm', '-rf');

      const result = stripWrappersWithInfo(tokens, TEST_ENVIRONMENT);
      expect(result.tokens).toEqual(['rm', '-rf']);
      expect(result.envAssignments.get('FOO')).toBe('bar');
    });

    test('strips nested wrappers across iterations and preserves env assignments', () => {
      const result = stripWrappersWithInfo(
        ['sudo', 'env', 'FOO=1', 'sudo', 'command', '--', 'rm', '-rf', '/tmp/a'],
        TEST_ENVIRONMENT,
      );
      expect(result.tokens).toEqual(['rm', '-rf', '/tmp/a']);
      expect(result.envAssignments.get('FOO')).toBe('1');
    });

    test("drops leading tokens containing '=' that are not NAME=value assignments", () => {
      // Intentionally conservative: only strict NAME=value is treated as an env assignment.
      // Shell-legal forms like NAME+=value are dropped to reach the real command head.
      const result = stripWrappersWithInfo(['FOO+=bar', 'rm', '-rf'], TEST_ENVIRONMENT);
      expect(result.tokens).toEqual(['rm', '-rf']);
      expect(result.envAssignments.get('FOO')).toBeUndefined();
    });

    test('captures empty env assignment values', () => {
      const result = stripWrappersWithInfo(['FOO=', 'rm', '-rf'], TEST_ENVIRONMENT);
      expect(result.tokens).toEqual(['rm', '-rf']);
      expect(result.envAssignments.get('FOO')).toBe('');
    });

    test.skipIf(process.platform !== 'win32')(
      '[windows] trusts the Windows system temp root',
      () => {
        expect(isTrustedTempPath(tmpdir(), TEST_ENVIRONMENT)).toBeTrue();
      },
    );
  });
});

describe('dangerousInText', () => {
  function expectDangerousPattern(text: string, label: string): void {
    expect(dangerousInText(text)).toBe(
      `Unparseable command text contains a destructive pattern (${label}). Rewrite as a plain, parseable command so it can be analyzed.`,
    );
  }

  test('detects rm -rf variants', () => {
    expectDangerousPattern('rm -rf /tmp/x', 'rm -rf');
    expectDangerousPattern('rm -R -f /tmp/x', 'rm -rf');
    expectDangerousPattern('rm -fr /tmp/x', 'rm -rf');
    expectDangerousPattern('rm -f -r /tmp/x', 'rm -rf');
    expectDangerousPattern('rm --recursive --force /tmp/x', 'rm -rf');
    expectDangerousPattern('rm --force --recursive /tmp/x', 'rm -rf');
  });

  test('detects with leading whitespace (trimStart)', () => {
    expectDangerousPattern('   rm -rf /tmp/x', 'rm -rf');
  });

  test('detects key git patterns', () => {
    expectDangerousPattern('git reset --hard', 'git reset --hard');
    expectDangerousPattern('git clean -f', 'git clean -f');
    expectDangerousPattern('git clean -fd', 'git clean -f');
    expectDangerousPattern('git checkout -f', 'git checkout --force');
    expectDangerousPattern('git checkout --force', 'git checkout --force');
    expectDangerousPattern('git tag -d v1', 'git tag -d');
    expectDangerousPattern('git branch --delete --force feature', 'git branch -D');
    expectDangerousPattern('git branch --force --delete feature', 'git branch -D');
  });

  test('allows checkout branch creation patterns with f in branch name', () => {
    expect(dangerousInText('git checkout -bfeature')).toBeNull();
    expect(dangerousInText('git checkout -Bfixup')).toBeNull();
  });

  test('skips find -delete when text starts with echo/rg', () => {
    expect(dangerousInText('echo "find . -delete')).toBeNull();
    expect(dangerousInText('rg "find . -delete')).toBeNull();
  });
});

describe('containsDangerousCode', () => {
  test('allows rm -r paths with hyphenated segments ending in f', () => {
    expect(containsDangerousCode('import os; os.system("rm -r /builds/project-stuff")')).toBe(
      false,
    );
    expect(containsDangerousCode('import os; os.system("rm -r path/to/proof")')).toBe(false);
  });

  test('detects rm recursive force option tokens', () => {
    expect(containsDangerousCode('import os; os.system("rm -rf /some/path")')).toBe(true);
    expect(containsDangerousCode('import os; os.system("rm -R -f /some/path")')).toBe(true);
    expect(containsDangerousCode('import os; os.system("rm --force --recursive /some/path")')).toBe(
      true,
    );
  });

  test('ignores dangerous text confined to string literals without an exec sink', () => {
    expect(containsDangerousCode('s = s.replace("x", "run mkfs.ext4 /dev/sda1 first")')).toBe(
      false,
    );
    expect(containsDangerousCode('s = """expect(cmd).toBe(\'rm -rf /tmp/x\');"""')).toBe(false);
  });

  test('keeps blocking dangerous literals when an exec sink is present', () => {
    expect(containsDangerousCode('subprocess.run("rm -rf /some/path", shell=True)')).toBe(true);
    expect(containsDangerousCode('`rm -rf /some/path`')).toBe(true);
  });

  test('keeps blocking dangerous text outside string literals', () => {
    expect(containsDangerousCode('rm -rf /some/path')).toBe(true);
  });
});

describe('extractInterpreterCodeArg', () => {
  test('extracts long eval argument', () => {
    expect(extractInterpreterCodeArg(['node', '--eval', 'rm -rf /'])).toBe('rm -rf /');
  });

  test('extracts inline long eval argument', () => {
    expect(extractInterpreterCodeArg(['node', '--eval=rm -rf /'])).toBe('rm -rf /');
  });

  test('extracts attached short code argument', () => {
    const dangerousCommand = ['rm', '-rf', '/'].join(' ');
    const payload = `import os; os.system("${dangerousCommand}")`;

    expect(extractInterpreterCodeArg(['python', `-c${payload}`])).toBe(payload);
  });

  test('extracts attached clustered short code argument', () => {
    const dangerousCommand = ['rm', '-rf', '/'].join(' ');
    const payload = `require("child_process").execSync("${dangerousCommand}")`;

    expect(extractInterpreterCodeArg(['node', `-pe${payload}`])).toBe(payload);
  });

  test('extracts uppercase perl eval argument', () => {
    expect(extractInterpreterCodeArg(['perl', '-E', 'system("rm -rf /")'])).toBe(
      'system("rm -rf /")',
    );
  });

  test('extracts versioned python code argument', () => {
    expect(extractInterpreterCodeArg(['python3.11', '-c', ['rm', '-rf', '/'].join(' ')])).toBe(
      ['rm', '-rf', '/'].join(' '),
    );
  });

  test('does not treat python -E as an eval flag', () => {
    expect(extractInterpreterCodeArg(['python', '-E', 'script.py'])).toBeNull();
  });

  test('does not treat python-config as an interpreter', () => {
    const dangerousCommand = ['rm', '-rf', '/'].join(' ');

    expect(extractInterpreterCodeArg(['python-config', '-c', dangerousCommand])).toBeNull();
  });
});

describe('parallel parsing helpers', () => {
  describe('extractParallelChildStart', () => {
    const childCommand = (tokens: readonly string[]) =>
      tokens.slice(extractParallelChildStart(tokens));

    test('returns empty when ::: is first token after parallel', () => {
      // When ::: is the first token after parallel (and options),
      // it returns empty because args follow :::
      expect(childCommand(['parallel', ':::'])).toEqual([]);
    });

    test('extracts command with -- separator', () => {
      expect(childCommand(['parallel', '--', 'rm', '-rf'])).toEqual(['rm', '-rf']);
    });

    test('returns command and all following tokens', () => {
      // The function returns all tokens starting from the first non-option
      expect(childCommand(['parallel', 'rm', '-rf'])).toEqual(['rm', '-rf']);
    });

    test('returns command including ::: marker when command comes first', () => {
      // If command tokens appear before :::, all of them are returned
      expect(childCommand(['parallel', 'rm', '-rf', ':::', '/'])).toEqual([
        'rm',
        '-rf',
        ':::',
        '/',
      ]);
    });

    test('consumes options', () => {
      expect(childCommand(['parallel', '-j4', '--', 'rm', '-rf'])).toEqual(['rm', '-rf']);
    });

    test('consumes --option=value', () => {
      expect(childCommand(['parallel', '--foo=bar', 'rm', '-rf'])).toEqual(['rm', '-rf']);
    });

    test('consumes options that take a value', () => {
      expect(childCommand(['parallel', '-S', 'sshlogin', 'rm', '-rf'])).toEqual(['rm', '-rf']);
    });

    test('consumes -j value form', () => {
      expect(childCommand(['parallel', '-j', '4', 'rm', '-rf'])).toEqual(['rm', '-rf']);
    });

    test('skips unknown short option', () => {
      expect(childCommand(['parallel', '-X', 'rm', '-rf'])).toEqual(['rm', '-rf']);
    });

    test('empty for just parallel', () => {
      expect(childCommand(['parallel'])).toEqual([]);
    });
  });
});

describe('xargs parsing helpers', () => {
  test('replacement token from -I option', () => {
    const result = extractXargsChildCommandWithInfo(['xargs', '-I', '{}', 'rm', '-rf', '{}']);
    expect(result.replacementToken).toBe('{}');
  });

  test('replacement token from -I attached', () => {
    const result = extractXargsChildCommandWithInfo(['xargs', '-I%', 'rm', '-rf', '%']);
    expect(result.replacementToken).toBe('%');
  });

  test('replacement token from --replace defaults to braces', () => {
    const result = extractXargsChildCommandWithInfo(['xargs', '--replace', 'rm', '-rf', '{}']);
    expect(result.replacementToken).toBe('{}');
  });

  test('replacement token from --replace= empty defaults to braces', () => {
    const result = extractXargsChildCommandWithInfo(['xargs', '--replace=', 'rm', '-rf', '{}']);
    expect(result.replacementToken).toBe('{}');
  });

  test('replacement token from --replace=CUSTOM', () => {
    const result = extractXargsChildCommandWithInfo(['xargs', '--replace=FOO', 'rm', '-rf', 'FOO']);
    expect(result.replacementToken).toBe('FOO');
  });

  test('no replacement token when not specified', () => {
    const result = extractXargsChildCommandWithInfo(['xargs', 'rm', '-rf']);
    expect(result.replacementToken).toBeNull();
  });

  test('BSD R option consumes following value', () => {
    const tokens = ['xargs', '-R', '2', 'rm', '-rf'];
    expect(tokens.slice(extractXargsChildCommandWithInfo(tokens).childStart)).toEqual([
      'rm',
      '-rf',
    ]);
  });

  test('BSD S option consumes following value', () => {
    const tokens = ['xargs', '-S', '4096', 'rm', '-rf'];
    expect(tokens.slice(extractXargsChildCommandWithInfo(tokens).childStart)).toEqual([
      'rm',
      '-rf',
    ]);
  });

  test('process slot var option consumes following value', () => {
    const tokens = ['xargs', '--process-slot-var', 'SLOT', 'rm', '-rf', '/'];
    expect(tokens.slice(extractXargsChildCommandWithInfo(tokens).childStart)).toEqual([
      'rm',
      '-rf',
      '/',
    ]);
  });

  test('process slot var option consumes equals value', () => {
    const tokens = ['xargs', '--process-slot-var=SLOT', 'rm', '-rf', '/'];
    expect(tokens.slice(extractXargsChildCommandWithInfo(tokens).childStart)).toEqual([
      'rm',
      '-rf',
      '/',
    ]);
  });
});
