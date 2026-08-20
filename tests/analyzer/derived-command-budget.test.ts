import { describe, expect, test } from 'bun:test';
import { normalizeChildCommand } from '@/analyzer/child-command';
import {
  createDerivedCommandWorkBudget,
  DERIVED_COMMAND_WORK_LIMITS,
  DerivedCommandWorkLimitError,
  EnvSplitStringExpansionError,
  REASON_DERIVED_COMMAND_WORK_LIMIT,
  reserveDerivedCommandTokens,
} from '@/analyzer/derived-command-budget';
import { TEST_ENVIRONMENT } from '../helpers/environment';
import { analyzeTestCommand } from '../helpers/policy';

const repeatedArgs = (value: string, count: number) =>
  Array.from({ length: count }, () => value).join(' ');

const embeddedGit = (derivedTokens: number) =>
  `tool git status ${repeatedArgs('value', derivedTokens - 2)}`;

const REPEATED_GIT_TOKENS = 10_000;
const EXACT_SECOND_GIT_INDEX =
  2 * REPEATED_GIT_TOKENS - 1 - DERIVED_COMMAND_WORK_LIMITS.maxDerivedTokens;

const repeatedGit = (secondGitIndex: number, head = 'tool') => {
  const tokens = Array.from({ length: REPEATED_GIT_TOKENS }, () => 'value');
  tokens[0] = head;
  tokens[1] = 'git';
  tokens[2] = 'status';
  tokens[secondGitIndex] = 'git';
  tokens[secondGitIndex + 1] = 'status';
  return tokens.join(' ');
};

const halfBudgetRepeatedGit = (overLimit = false) => {
  const tokenCount = 5_000;
  const exactSecondGitIndex = 2 * tokenCount - 1 - DERIVED_COMMAND_WORK_LIMITS.maxDerivedTokens / 2;
  const tokens = Array.from({ length: tokenCount }, () => 'value');
  tokens[0] = 'tool';
  tokens[1] = 'git';
  tokens[2] = 'status';
  tokens[overLimit ? exactSecondGitIndex - 1 : exactSecondGitIndex] = 'git';
  tokens[overLimit ? exactSecondGitIndex : exactSecondGitIndex + 1] = 'status';
  return tokens.join(' ');
};

const repeatedFindExec = (count: number) =>
  Array.from({ length: count }, () => String.raw`-exec echo \;`).join(' ');

const EXACT_REPEATED_GIT = repeatedGit(EXACT_SECOND_GIT_INDEX);
const OVER_LIMIT_REPEATED_GIT = repeatedGit(EXACT_SECOND_GIT_INDEX - 1);
const HALF_BUDGET_REPEATED_GIT = halfBudgetRepeatedGit();
const OVER_LIMIT_HALF_BUDGET_REPEATED_GIT = halfBudgetRepeatedGit(true);
const EMBEDDED_GIT_10K = embeddedGit(10_000);
const REPEATED_FIND_EXEC_104 = repeatedFindExec(104);
const REPEATED_FIND_EXEC_70 = repeatedFindExec(70);

const limitedResult = (command: string) => ({
  kind: 'deny' as const,
  reason: REASON_DERIVED_COMMAND_WORK_LIMIT,
  intent: 'stop_and_explain' as const,
  evidence: [{ kind: 'command' as const, command, segment: command }],
});

describe('derived command work budget', () => {
  test('tracks exact direct reservations and rejects invalid or exhausted budgets', () => {
    const budget = createDerivedCommandWorkBudget();
    reserveDerivedCommandTokens(budget, DERIVED_COMMAND_WORK_LIMITS.maxDerivedTokens);
    expect(budget.derivedTokens).toBe(DERIVED_COMMAND_WORK_LIMITS.maxDerivedTokens);
    expect(() => reserveDerivedCommandTokens(budget, 1)).toThrow(DerivedCommandWorkLimitError);

    for (const invalid of [-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => reserveDerivedCommandTokens({ derivedTokens: invalid }, 0)).toThrow(
        DerivedCommandWorkLimitError,
      );
      expect(() => reserveDerivedCommandTokens({ derivedTokens: 0 }, invalid)).toThrow(
        DerivedCommandWorkLimitError,
      );
    }
  });

  test('normalizes direct child commands and rejects unverifiable env split expansion', () => {
    expect(
      normalizeChildCommand(['busybox', 'git', 'status'], {
        environment: TEST_ENVIRONMENT,
        cwd: '/tmp',
      }),
    ).toMatchObject({
      tokens: ['git', 'status'],
      cwd: '/tmp',
      head: 'git',
    });
    expect(() =>
      normalizeChildCommand(['env', '-S', Array.from({ length: 16_385 }, () => 'x').join(' ')], {
        environment: TEST_ENVIRONMENT,
        cwd: '/tmp',
      }),
    ).toThrow(EnvSplitStringExpansionError);
  });

  test('denies an over-limit env -S split string with the expansion-limit reason', () => {
    const splitString = (tokens: number) =>
      `env -S '${Array.from({ length: tokens }, () => 'x').join(' ')}'`;
    const denied = splitString(16_385);

    expect(analyzeTestCommand(denied)).toEqual({
      kind: 'deny',
      reason:
        'env -S split-string expansion exceeds the 16,384-token analysis limit and cannot be verified safely. Expand the command explicitly.',
      intent: 'stop_and_explain',
      evidence: [{ kind: 'command', command: denied, segment: denied }],
    });
    expect(analyzeTestCommand(splitString(16_384))).toBeNull();
    expect(analyzeTestCommand('env -S "$CMD" git status')).toBeNull();
  });

  test('accepts the exact embedded Git suffix limit and denies the first token over it', () => {
    const accepted = EXACT_REPEATED_GIT;
    const denied = OVER_LIMIT_REPEATED_GIT;

    expect(analyzeTestCommand(accepted)).toBeNull();
    expect(analyzeTestCommand(denied)).toEqual(limitedResult(denied));
  });

  test('is unfilterable when destructive-command protection is disabled', () => {
    const command = OVER_LIMIT_REPEATED_GIT;

    expect(
      analyzeTestCommand(command, {
        config: { destructiveCommandProtectionEnabled: false },
      }),
    ).toEqual(limitedResult(command));
  });

  test('continues charging after an earlier ordinary match is disabled', () => {
    const command = `tool git reset --hard ${repeatedArgs('before', 3_996)} git status ${repeatedArgs(
      'after',
      7_998,
    )}`;

    expect(
      analyzeTestCommand(command, {
        config: { destructiveCommandRuleOverrides: { 'git.reset-hard': 'off' } },
      }),
    ).toEqual(limitedResult(command));
  });

  test('shares the budget across sequential programs', () => {
    const accepted = `${HALF_BUDGET_REPEATED_GIT} ; ${HALF_BUDGET_REPEATED_GIT}`;
    const denied = `${HALF_BUDGET_REPEATED_GIT} ; ${OVER_LIMIT_HALF_BUDGET_REPEATED_GIT}`;

    expect(analyzeTestCommand(accepted)).toBeNull();
    expect(analyzeTestCommand(denied)).toEqual(limitedResult(denied));
  });

  test('shares the budget through shell recursion', () => {
    const accepted = `${HALF_BUDGET_REPEATED_GIT} ; sh -c '${HALF_BUDGET_REPEATED_GIT}'`;
    const denied = `${HALF_BUDGET_REPEATED_GIT} ; sh -c '${OVER_LIMIT_HALF_BUDGET_REPEATED_GIT}'`;

    expect(analyzeTestCommand(accepted)).toBeNull();
    expect(analyzeTestCommand(denied)).toEqual(limitedResult(denied));
  });

  test('shares the budget across parsed command substitutions', () => {
    const accepted = `echo "$(${HALF_BUDGET_REPEATED_GIT})" "$(${HALF_BUDGET_REPEATED_GIT})"`;
    const denied = `echo "$(${HALF_BUDGET_REPEATED_GIT})" "$(${OVER_LIMIT_HALF_BUDGET_REPEATED_GIT})"`;

    expect(analyzeTestCommand(accepted)).toBeNull();
    expect(analyzeTestCommand(denied)).toEqual(limitedResult(denied));
  });

  test('bounds repeated exec suffix work in known find commands', () => {
    const accepted = `find . ${REPEATED_FIND_EXEC_104}`;
    const denied = `find . ${repeatedFindExec(105)}`;

    expect(analyzeTestCommand(accepted)).toBeNull();
    expect(analyzeTestCommand(denied)).toEqual(limitedResult(denied));
  });

  test('bounds fallback and repeated exec suffix work together for embedded find', () => {
    const accepted = `tool find . ${repeatedFindExec(103)}`;
    const denied = `tool find . ${REPEATED_FIND_EXEC_104}`;

    expect(analyzeTestCommand(accepted)).toBeNull();
    expect(analyzeTestCommand(denied)).toEqual(limitedResult(denied));
  });

  test('shares the budget through find exec segment recursion', () => {
    const inner = EXACT_REPEATED_GIT;
    const command = `find . -exec sh -c '${inner}' \\;`;

    expect(analyzeTestCommand(command)).toEqual(limitedResult(command));
  });

  test('propagates the budget into xargs find children', () => {
    const command = `${EMBEDDED_GIT_10K} ; xargs find . ${REPEATED_FIND_EXEC_70}`;

    // Appended xargs input can extend find execution sources before the budget is exhausted.
    expect(analyzeTestCommand(command)?.ruleId).toBe('xargs.shell-dynamic');
  });

  test('propagates the budget into parallel find children', () => {
    const command = `${EMBEDDED_GIT_10K} ; parallel find . ${REPEATED_FIND_EXEC_70}`;

    // Parallel stdin/source uncertainty is fail-closed before derived-command budget exhaustion.
    expect(analyzeTestCommand(command)?.ruleId).toBe('parallel.shell-dynamic');
  });

  test('preserves under-limit fallback detection order and display bypasses', () => {
    expect(analyzeTestCommand('tool git reset --hard')?.reason).toContain('git reset --hard');
    expect(analyzeTestCommand('tool rm -rf / git reset --hard')?.reason).toContain(
      'extremely dangerous',
    );
    expect(analyzeTestCommand('tool find . -delete')?.reason).toContain('find -delete');
    expect(analyzeTestCommand("tool sh -c 'git reset --hard'")?.reason).toContain(
      'git reset --hard',
    );
    expect(analyzeTestCommand(OVER_LIMIT_REPEATED_GIT.replace(/^tool /, 'echo '))).toBeNull();
  });
});
