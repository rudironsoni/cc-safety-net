import { dirname } from 'node:path';
import { textCommandWords } from '@/analyzer/command-words';
import { findExecRmDeletesFoundPaths, findHasDelete, getFindStartingPoints } from '@/analyzer/find';
import {
  createPathCanonicalizationContext,
  type PathCanonicalizationContext,
} from '@/analyzer/path-canonicalization';
import { stripWrappers } from '@/analyzer/wrapper-prelude';
import {
  expandTrackedShellVariables,
  extractMvOperandPaths,
  findProtectedPathMutationInCommand,
  isAssignmentOnlySegment,
  normalizeProtectedPathCandidate,
  type ProtectedPathShellState,
} from '@/guards/protected-path-scanner';
import { createSemanticFacts, getCommandSyntaxFact } from '@/guards/semantic-facts';
import type { EnvironmentContext } from '@/ir/analysis';
import { createProcessEnvironment } from '@/ir/environment';
import { createToolInvocation, type ToolCallContext, type ToolRoute } from '@/ir/invocation';
import type { SemanticFacts, ShellSyntaxFacts } from '@/ir/semantic-facts';
import { getBasename } from '@/parser/shell';
import { isReadOnlyTool } from '@/parser/tool-input';
import { getUserPolicyPath } from '@/policy/store';

export const REASON_POLICY_CONFIG_PROTECTION =
  'This path contains the protected policy config and you must not modify or delete it.';

const READ_ONLY_COMMANDS = new Set([
  '[',
  'cat',
  'file',
  'grep',
  'head',
  'jq',
  'less',
  'ls',
  'more',
  'rg',
  'sed',
  'stat',
  'tail',
  'test',
  'wc',
]);
type PolicyConfigTarget = {
  readonly target: string;
};

type PolicyPathIdentity = {
  readonly file: string;
  readonly directoryAndAncestors: ReadonlySet<string>;
};

/** @internal */
export function findPolicyConfigMutationTargetInToolInput(
  toolName: string,
  input: unknown,
  route: ToolRoute,
  context: ToolCallContext,
): PolicyConfigTarget | null {
  return findPolicyConfigMutationTargetInSemanticFacts(
    createSemanticFacts(createToolInvocation(toolName, input, route, context, null)),
  );
}

export function findPolicyConfigMutationTargetInSemanticFacts(
  facts: SemanticFacts,
): PolicyConfigTarget | null {
  const context = createPathCanonicalizationContext(createProcessEnvironment());
  const identity = createPolicyPathIdentity(facts.invocation.context.executionCwd, context);
  if (facts.invocation.route.kind === 'patch') {
    return findPolicyConfigMutationTargetInPaths(
      facts.paths,
      false,
      facts.invocation.context.executionCwd,
      identity,
      context,
    );
  }

  const command = getCommandSyntaxFact(facts, 'input-candidate');
  if (facts.invocation.route.kind === 'command') {
    return command
      ? findPolicyConfigMutationTargetInCommand(
          command.shell,
          facts.invocation.context.executionCwd,
          identity,
          context,
        )
      : null;
  }
  if (facts.invocation.route.kind === 'unknown' && command) {
    const target = findPolicyConfigMutationTargetInCommand(
      command.shell,
      facts.invocation.context.executionCwd,
      identity,
      context,
    );
    if (target) return target;
  }

  return findPolicyConfigMutationTargetInPaths(
    facts.paths,
    facts.invocation.route.kind === 'grep' ||
      facts.invocation.route.kind === 'glob' ||
      isReadOnlyTool(facts.invocation.toolName),
    facts.invocation.context.executionCwd,
    identity,
    context,
  );
}

function findPolicyConfigMutationTargetInPaths(
  paths: readonly string[],
  readOnly: boolean,
  cwd: string,
  identity: PolicyPathIdentity,
  context: PathCanonicalizationContext,
): PolicyConfigTarget | null {
  if (readOnly) return null;
  const target = paths.find((path) => isPolicyFile(path, cwd, identity, context));
  return target ? { target } : null;
}

function findPolicyConfigMutationTargetInCommand(
  syntax: ShellSyntaxFacts,
  cwd: string,
  identity: PolicyPathIdentity,
  context: PathCanonicalizationContext,
): PolicyConfigTarget | null {
  const target = findProtectedPathMutationInCommand(syntax, cwd, context, {
    findSegmentTarget: (segment, state) =>
      findPolicyConfigMutationTargetInSegment(segment, state, identity, context)?.target ?? null,
    isRedirectionTarget: (target, state) => isPolicyFile(target, state.cwd, identity, context),
    findMalformedTarget: (source) =>
      findPolicyConfigTargetInMalformedText(source, cwd, identity, context)?.target ?? null,
    normalizeCwd: normalizeProtectedPathCandidate,
  });
  return target ? { target } : null;
}

function findPolicyConfigMutationTargetInSegment(
  segment: readonly string[],
  state: ProtectedPathShellState,
  identity: PolicyPathIdentity,
  context: PathCanonicalizationContext,
): PolicyConfigTarget | null {
  if (isAssignmentOnlySegment(segment)) return null;
  const environment = context.environment;
  const stripped = stripWrappers([...segment], environment);
  const command = getBasename(stripped[0] ?? '').toLowerCase();
  const args = stripped.slice(1);

  if (command === 'rm' && hasRecursiveRmOption(args)) {
    const target = extractRmOperands(args).find((operand) =>
      isPolicyDirectoryOrAncestor(
        expandTrackedShellVariables(operand, state.variables),
        state.cwd,
        identity,
        context,
      ),
    );
    if (target) return { target };
  }

  if (command === 'find') {
    const deletesDirectly = findHasDelete(stripped, 1);
    if (deletesDirectly || findExecRmDeletesFoundPaths(stripped, environment)) {
      const target = (
        getFindStartingPoints(textCommandWords(stripped)) ?? textCommandWords(['.'])
      ).find((startingPoint) => {
        const expanded = expandTrackedShellVariables(startingPoint.text, state.variables);
        return (
          isPolicyFile(expanded, state.cwd, identity, context) ||
          isPolicyDirectoryOrAncestor(expanded, state.cwd, identity, context)
        );
      })?.text;
      if (target) return { target };
    }
  }

  if (command === 'mv') {
    const target = extractMvOperandPaths(args).sources.find((source) =>
      isPolicyFileOrDirectorySource(
        expandTrackedShellVariables(source, state.variables),
        state.cwd,
        identity,
        context,
      ),
    );
    if (target) return { target };
  }

  if (isReadOnlySegment(segment, environment)) return null;
  for (const token of segment) {
    for (const candidate of extractDirectPathCandidates(token)) {
      if (
        isPolicyFile(
          expandTrackedShellVariables(candidate, state.variables),
          state.cwd,
          identity,
          context,
        )
      ) {
        return { target: candidate };
      }
    }
  }
  return null;
}

function hasRecursiveRmOption(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === '--recursive' ||
      (arg.startsWith('-') && !arg.startsWith('--') && /[rR]/.test(arg.slice(1))),
  );
}

function extractRmOperands(args: readonly string[]): readonly string[] {
  const separator = args.indexOf('--');
  if (separator !== -1) {
    return [
      ...args.slice(0, separator).filter((arg) => !arg.startsWith('-')),
      ...args.slice(separator + 1),
    ];
  }
  return args.filter((arg) => !arg.startsWith('-'));
}

function isReadOnlySegment(tokens: readonly string[], environment: EnvironmentContext): boolean {
  const stripped = stripWrappers([...tokens], environment);
  if (stripped.length === 0) return false;
  const command = getBasename(stripped[0] ?? '').toLowerCase();
  if (!READ_ONLY_COMMANDS.has(command)) return false;
  if (command !== 'sed') return true;
  return !stripped
    .slice(1)
    .some(
      (token) =>
        token.startsWith('-i') || token === '--in-place' || token.startsWith('--in-place='),
    );
}

function findPolicyConfigTargetInMalformedText(
  text: string,
  cwd: string,
  identity: PolicyPathIdentity,
  context: PathCanonicalizationContext,
): PolicyConfigTarget | null {
  for (const token of text.split(/\s+/)) {
    for (const candidate of extractDirectPathCandidates(token)) {
      if (isPolicyFile(candidate, cwd, identity, context)) return { target: candidate };
    }
  }
  return null;
}

function extractDirectPathCandidates(value: string): readonly string[] {
  const cleaned = value.trim().replace(/^['"]|['"]$/g, '');
  const separator = cleaned.indexOf('=');
  return separator === -1 || separator === cleaned.length - 1
    ? [cleaned]
    : [cleaned, cleaned.slice(separator + 1)];
}

function createPolicyPathIdentity(
  cwd: string,
  context: PathCanonicalizationContext,
): PolicyPathIdentity {
  const file = normalizeProtectedPathCandidate(getUserPolicyPath(), cwd, context);
  const directory = dirname(file);
  const directoryAndAncestors = new Set<string>();
  for (let current = directory; ; current = dirname(current)) {
    directoryAndAncestors.add(comparePath(current));
    if (dirname(current) === current) break;
  }
  return { file: comparePath(file), directoryAndAncestors };
}

function isPolicyFile(
  target: string,
  cwd: string,
  identity: PolicyPathIdentity,
  context: PathCanonicalizationContext,
): boolean {
  return comparePath(normalizeProtectedPathCandidate(target, cwd, context)) === identity.file;
}

function isPolicyDirectoryOrAncestor(
  target: string,
  cwd: string,
  identity: PolicyPathIdentity,
  context: PathCanonicalizationContext,
): boolean {
  return identity.directoryAndAncestors.has(
    comparePath(normalizeProtectedPathCandidate(target, cwd, context)),
  );
}

function isPolicyFileOrDirectorySource(
  target: string,
  cwd: string,
  identity: PolicyPathIdentity,
  context: PathCanonicalizationContext,
): boolean {
  const normalized = comparePath(normalizeProtectedPathCandidate(target, cwd, context));
  return normalized === identity.file || identity.directoryAndAncestors.has(normalized);
}

function comparePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
