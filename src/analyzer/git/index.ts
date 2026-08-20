import { analysisWordText } from '@/analyzer/command-words';
import { hasGitSshEnvAssignment } from '@/analyzer/git/env';
import {
  extractGitSubcommandAndRest,
  hasGitCommandLineSshCommandConfig,
  resolveGitCommandLineAliases,
  splitAtDoubleDash,
} from '@/analyzer/git/parse';
import { analyzeGitRule, matchesGitLongOption } from '@/analyzer/git/rules';
import {
  type GitAnalyzeOptions,
  type GitWorktreeRelaxation,
  getGitWorktreeRelaxationForMatch,
} from '@/analyzer/git/worktree-relaxation';
import type { DestructiveCommandRuleMatch } from '@/ir/analysis';
import type { CommandWord } from '@/ir/command';
import { destructiveCommandMatch } from '@/rules/destructive-command-rules';

const REASON_GIT_SSH_ENV =
  'Git SSH environment overrides can execute arbitrary commands during network operations. Run git without GIT_SSH/GIT_SSH_COMMAND overrides, or ask the user to run it manually.';
const GIT_NETWORK_SUBCOMMANDS = new Set([
  'clone',
  'fetch',
  'pull',
  'push',
  'ls-remote',
  'submodule',
]);

export function analyzeGitMatch(
  words: readonly CommandWord[],
  options: GitAnalyzeOptions,
): DestructiveCommandRuleMatch | null {
  return evaluateGit(words.map(analysisWordText), options);
}

function evaluateGit(
  tokens: readonly string[],
  options: GitAnalyzeOptions,
  onRelaxation?: (relaxation: GitWorktreeRelaxation) => void,
): DestructiveCommandRuleMatch | null {
  const aliasResolution = resolveGitCommandLineAliases(tokens, options.env, options.envAssignments);
  const aliasConfigDisabled =
    options.policy?.destructiveCommandRuleOverrides['git.alias-config'] === 'off';
  if (aliasResolution.blockedReason && !aliasConfigDisabled) {
    return destructiveCommandMatch('git.alias-config', aliasResolution.blockedReason);
  }

  const resolvedTokens = aliasResolution.tokens;
  if (
    (hasGitSshEnvAssignment(options.envAssignments) ||
      hasGitCommandLineSshCommandConfig(tokens, options.env, options.envAssignments)) &&
    isGitNetworkOperation(resolvedTokens)
  ) {
    return destructiveCommandMatch('git.ssh-env', REASON_GIT_SSH_ENV);
  }

  const match = analyzeGitRule(resolvedTokens);

  if (!match) {
    return null;
  }

  if (aliasResolution.expanded || aliasResolution.blockedReason) {
    return match;
  }

  const relaxation = getGitWorktreeRelaxationForMatch(tokens, match, options);
  if (!relaxation) return match;
  onRelaxation?.(relaxation);
  return null;
}

/** One-pass Git decision detail used by intrinsic command traces. */
export function analyzeGitDetailed(
  words: readonly CommandWord[],
  options: GitAnalyzeOptions,
): Readonly<{
  match: DestructiveCommandRuleMatch | null;
  relaxation: GitWorktreeRelaxation | null;
}> {
  let relaxation: GitWorktreeRelaxation | null = null;
  const match = evaluateGit(words.map(analysisWordText), options, (value) => {
    relaxation = value;
  });
  return { match, relaxation };
}

function isGitNetworkOperation(tokens: readonly string[]): boolean {
  const { subcommand, rest } = extractGitSubcommandAndRest(tokens);
  const subcommandName = subcommand?.toLowerCase();
  if (!subcommandName) {
    return false;
  }
  if (GIT_NETWORK_SUBCOMMANDS.has(subcommandName)) {
    return true;
  }
  if (subcommandName === 'archive') {
    return splitAtDoubleDash(rest).before.some((token) => matchesGitLongOption(token, '--remote'));
  }
  return subcommandName === 'remote' && isGitRemoteUpdateOperation(rest);
}

function isGitRemoteUpdateOperation(tokens: readonly string[]): boolean {
  return tokens.find((token) => !isGitRemotePrefixOption(token))?.toLowerCase() === 'update';
}

function isGitRemotePrefixOption(token: string): boolean {
  return (
    token === '-v' ||
    matchesGitLongOption(token, '--verbose') ||
    matchesGitLongOption(token, '--no-verbose')
  );
}

/** @internal */
export function getGitWorktreeRelaxation(
  tokens: readonly string[],
  options: GitAnalyzeOptions,
): GitWorktreeRelaxation | null {
  const aliasResolution = resolveGitCommandLineAliases(tokens, options.env, options.envAssignments);
  if (aliasResolution.blockedReason || aliasResolution.expanded) {
    return null;
  }

  const match = analyzeGitRule(aliasResolution.tokens);
  if (!match) {
    return null;
  }
  return getGitWorktreeRelaxationForMatch(tokens, match, options);
}
