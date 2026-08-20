import { AWK_INTERPRETERS, analyzeAwkSystemCallMatch } from '@/analyzer/awk';
import { textCommandWords } from '@/analyzer/command-words';
import type { DerivedCommandWorkBudget } from '@/analyzer/derived-command-budget';
import { analyzeFindMatch } from '@/analyzer/find';
import { analyzeGitMatch } from '@/analyzer/git';
import {
  containsDangerousCode,
  extractInterpreterCodeArg,
  isInterpreterCommand,
  isInterpreterDisplayOnly,
  REASON_INTERPRETER_BLOCKED,
  REASON_INTERPRETER_DANGEROUS,
} from '@/analyzer/interpreters';
import { REASON_STRICT_UNPARSEABLE } from '@/analyzer/reasons';
import { analyzeRmMatch } from '@/analyzer/rm';
import { hasRecursiveForceFlags } from '@/analyzer/rm-flags';
import {
  extractEvalSource,
  extractShellScriptOperandSource,
  shellSourceHasUnresolvedDynamicExecutionCarrier,
} from '@/analyzer/shell-execution';
import { extractDashCArg, isShellSyntaxCheck } from '@/analyzer/shell-wrappers';
import { hasUnsafeTmpdirWordSplitting, isTmpdirValueTrusted } from '@/analyzer/tmpdir';
import type {
  AnalyzeNestedOverrides,
  DestructiveCommandRuleMatch,
  EnvironmentContext,
  ProtectedGitMetadata,
} from '@/ir/analysis';
import type { EffectivePolicy } from '@/ir/policy';
import { normalizeCommandToken } from '@/parser/shell';
import { hasUnclosedQuotes } from '@/parser/shell/shared';
import { SHELL_WRAPPERS } from '@/rules/constants';
import { checkPolicyRuleMatch } from '@/rules/custom';
import {
  destructiveCommandMatch,
  destructiveCommandRuleIsEnabled,
  filterDestructiveCommandMatch,
} from '@/rules/destructive-command-rules';

export interface ChildCommandAnalysisContext {
  /** Process state nested analysis reads instead of touching env, home or the filesystem. */
  environment: EnvironmentContext;
  cwd: string | undefined;
  derivedCommandWorkBudget?: DerivedCommandWorkBudget;
  originalCwd: string | undefined;
  strict?: boolean;
  paranoidRm: boolean | undefined;
  paranoidInterpreters?: boolean;
  allowTmpdirVar: boolean;
  envAssignments: ReadonlyMap<string, string>;
  worktreeMode?: boolean;
  scanWork?: { units: number };
  protectedGitMetadata: ProtectedGitMetadata | null;
  policy?: Pick<
    EffectivePolicy,
    'destructiveCommandProtectionEnabled' | 'destructiveCommandRuleOverrides'
  > &
    Partial<Pick<EffectivePolicy, 'rules'>>;
  analyzeNested?: (
    command: string,
    overrides?: AnalyzeNestedOverrides,
  ) => DestructiveCommandRuleMatch | null;
}

export interface ChildCommandAnalysisOptions {
  dynamicInput?: boolean;
  dynamicRmInput?: boolean;
  dynamicSourceInput?: boolean;
  shellDynamicMatch?: DestructiveCommandRuleMatch;
  dynamicSourceMatch?: DestructiveCommandRuleMatch;
  rmDynamicMatch?: DestructiveCommandRuleMatch;
}

export function analyzeChildCommandMatch(
  tokens: readonly string[],
  context: ChildCommandAnalysisContext,
  options: ChildCommandAnalysisOptions = {},
): DestructiveCommandRuleMatch | null {
  if (tokens.length === 0) {
    return null;
  }

  const head = tokens[0];
  if (!head) {
    return null;
  }

  const normalizedHead = normalizeCommandToken(head);

  if (normalizedHead === 'eval') {
    const source = extractEvalSource(textCommandWords(tokens));
    if (source.kind === 'dynamic') return getShellDynamicReason(options, context);
    if (source.kind === 'literal' && context.analyzeNested) {
      const result = context.analyzeNested(source.source, {
        effectiveCwd: context.cwd,
        envAssignments: context.envAssignments,
      });
      if (result) return result;
    }
    return getDynamicSourceReason(options, context);
  }

  if (SHELL_WRAPPERS.has(normalizedHead)) {
    if (isShellSyntaxCheck(tokens)) return null;
    const dashCArg = extractDashCArg(tokens);
    if (dashCArg) {
      if (options.dynamicSourceInput ?? options.dynamicInput) {
        const result = getShellDynamicReason(options, context);
        if (result) return result;
      }
      if (shellSourceHasUnresolvedDynamicExecutionCarrier(dashCArg)) {
        const result = getShellDynamicReason(options, context);
        if (result) return result;
      }
      if (!context.analyzeNested) return null;
      const result = context.analyzeNested(dashCArg, {
        effectiveCwd: context.cwd,
        envAssignments: context.envAssignments,
      });
      if (result) return result;
      return null;
    }

    const scriptSource = extractShellScriptOperandSource(textCommandWords(tokens));
    if (scriptSource.kind === 'dynamic') return getShellDynamicReason(options, context);
    if (scriptSource.kind === 'literal') {
      if (options.dynamicSourceInput) return getShellDynamicReason(options, context);
      return null;
    }
    if (options.dynamicSourceInput ?? options.dynamicInput) {
      return getShellDynamicReason(options, context);
    }
    return null;
  }

  if (AWK_INTERPRETERS.has(normalizedHead)) {
    return (
      filterDestructiveCommandMatch(
        analyzeAwkSystemCallMatch(tokens, (command) =>
          context.analyzeNested
            ? context.analyzeNested(command, {
                effectiveCwd: context.cwd,
                envAssignments: context.envAssignments,
              })
            : null,
        ),
        context.policy,
      ) ??
      checkPolicyRuleMatch(tokens, context.policy?.rules ?? []) ??
      getDynamicSourceReason(options, context)
    );
  }

  if (isInterpreterCommand(normalizedHead)) {
    const codeArg = extractInterpreterCodeArg(tokens);
    if (!codeArg) {
      return getDynamicSourceReason(options, context);
    }

    if (
      destructiveCommandRuleIsEnabled(
        context.policy,
        'interpreter.one-liner-paranoid',
        !!context.paranoidInterpreters,
      )
    ) {
      const paranoidMatch = filterDestructiveCommandMatch(
        destructiveCommandMatch('interpreter.one-liner-paranoid', REASON_INTERPRETER_BLOCKED),
        context.policy,
      );
      if (paranoidMatch) return paranoidMatch;
    }

    if (isInterpreterDisplayOnly(normalizedHead, codeArg)) {
      return getDynamicSourceReason(options, context);
    }

    const nestedResult = context.analyzeNested?.(codeArg, {
      effectiveCwd: context.cwd,
      envAssignments: context.envAssignments,
    });
    if (
      nestedResult &&
      nestedResult.id !== 'raw-text.dangerous-command' &&
      (nestedResult.reason !== REASON_STRICT_UNPARSEABLE || hasUnclosedQuotes(codeArg))
    ) {
      return nestedResult;
    }

    if (containsDangerousCode(codeArg, context.scanWork)) {
      return (
        filterDestructiveCommandMatch(
          destructiveCommandMatch('interpreter.dangerous-command', REASON_INTERPRETER_DANGEROUS),
          context.policy,
        ) ?? getDynamicSourceReason(options, context)
      );
    }
    return getDynamicSourceReason(options, context);
  }

  if (normalizedHead === 'rm' || normalizedHead === 'rmdir') {
    const dynamicRmPolicyApplies =
      normalizedHead === 'rm' && (hasRecursiveForceFlags(tokens) || options.dynamicRmInput);
    const rmMatch = filterDestructiveCommandMatch(
      analyzeRmMatch(textCommandWords(tokens), {
        environment: context.environment,
        cwd: context.cwd,
        originalCwd: context.originalCwd,
        strict: context.strict,
        paranoid: context.paranoidRm,
        allowTmpdirVar: context.allowTmpdirVar,
        tmpdirWordSplittingUnsafe: hasUnsafeTmpdirWordSplitting(
          context.envAssignments,
          context.environment,
        ),
        trustedTmpdirValue: isTmpdirValueTrusted(context.envAssignments, context.environment),
        protectedGitMetadata: context.protectedGitMetadata,
        policy: context.policy,
      }),
      context.policy,
    );
    return (
      rmMatch ??
      (dynamicRmPolicyApplies && options.dynamicRmInput
        ? getDynamicSourceReason(options, context)
        : null) ??
      (dynamicRmPolicyApplies ? getDynamicRmReason(options, context) : null)
    );
  }

  if (normalizedHead === 'find') {
    return (
      analyzeFindMatch(textCommandWords(tokens), {
        ...context,
        derivedCommandWorkBudget: context.derivedCommandWorkBudget,
        analyzeTokens: (nestedTokens, cwd) =>
          analyzeChildCommandMatch(
            nestedTokens,
            {
              ...context,
              cwd: cwd ?? undefined,
              derivedCommandWorkBudget: context.derivedCommandWorkBudget,
            },
            options,
          ),
      }) ??
      checkPolicyRuleMatch(tokens, context.policy?.rules ?? []) ??
      getDynamicSourceReason(options, context)
    );
  }

  if (normalizedHead === 'git') {
    return (
      filterDestructiveCommandMatch(
        analyzeGitMatch(textCommandWords(tokens), {
          env: context.environment.env,
          cwd: context.cwd,
          envAssignments: context.envAssignments,
          policy: context.policy,
          worktreeMode: options.dynamicInput ? false : context.worktreeMode,
        }),
        context.policy,
      ) ??
      checkPolicyRuleMatch(tokens, context.policy?.rules ?? []) ??
      getDynamicSourceReason(options, context)
    );
  }

  return (
    checkPolicyRuleMatch(tokens, context.policy?.rules ?? []) ??
    getDynamicSourceReason(options, context)
  );
}

function getShellDynamicReason(
  options: ChildCommandAnalysisOptions,
  context: ChildCommandAnalysisContext,
): DestructiveCommandRuleMatch | null {
  return options.shellDynamicMatch
    ? filterDestructiveCommandMatch(options.shellDynamicMatch, context.policy)
    : null;
}

function getDynamicSourceReason(
  options: ChildCommandAnalysisOptions,
  context: ChildCommandAnalysisContext,
): DestructiveCommandRuleMatch | null {
  return options.dynamicSourceInput && options.dynamicSourceMatch
    ? filterDestructiveCommandMatch(options.dynamicSourceMatch, context.policy)
    : null;
}

function getDynamicRmReason(
  options: ChildCommandAnalysisOptions,
  context: ChildCommandAnalysisContext,
): DestructiveCommandRuleMatch | null {
  return options.dynamicInput && options.rmDynamicMatch
    ? filterDestructiveCommandMatch(options.rmDynamicMatch, context.policy)
    : null;
}
