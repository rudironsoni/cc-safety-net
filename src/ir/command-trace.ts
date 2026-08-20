/** Trace step for explain command - discriminated union of all step types. */
export type TraceStep =
  | { type: 'parse'; input: string; segments: string[][] }
  | { type: 'env-strip'; input: string[]; envVars: string[]; output: string[] }
  | { type: 'leading-tokens-stripped'; input: string[]; removed: string[]; output: string[] }
  | { type: 'shell-wrapper'; wrapper: string; innerCommand: string }
  | { type: 'interpreter'; interpreter: string; codeArg: string; paranoidBlocked: boolean }
  | { type: 'busybox'; subcommand: string }
  | { type: 'transparent-wrapper'; wrapper: string; output: string[] }
  | {
      type: 'recurse';
      reason:
        | 'shell-wrapper'
        | 'interpreter'
        | 'busybox'
        | 'shell-eval'
        | 'shell-trap'
        | 'shell-stdin'
        | 'shell-heredoc'
        | 'heredoc-file';
      innerCommand: string;
      depth: number;
    }
  | {
      type: 'rule-check';
      rule: string;
      matched: boolean;
      reason?: string;
    }
  | { type: 'worktree-relaxation'; originalReason: string; gitCwd: string }
  | {
      type: 'tmpdir-check';
      tmpdirValue: string | null;
      isOverriddenToNonTemp: boolean;
      allowTmpdirVar: boolean;
    }
  | { type: 'fallback-scan'; tokensScanned: string[]; embeddedCommandFound?: string }
  | { type: 'custom-rules-check'; rulesChecked: boolean; matched: boolean; reason?: string }
  | { type: 'cwd-change'; segment: string; effectiveCwdNowUnknown: true }
  | { type: 'dangerous-text'; token: string; matched: boolean; reason?: string }
  | { type: 'strict-unparseable'; rawCommand: string; reason: string }
  | { type: 'segment-skipped'; index: number; reason: 'prior-segment-blocked' }
  | { type: 'error'; message: string; partial?: boolean };

export type CommandTraceEvent = Readonly<
  | { kind: 'step'; scope: 'global'; step: TraceStep }
  | { kind: 'step'; scope: 'segment'; segmentIndex: number; step: TraceStep }
>;

export type CommandTraceTerminal = Readonly<
  { result: 'allowed' } | { result: 'blocked'; reason: string; segment: string; ruleId?: string }
>;

export type CommandTrace = Readonly<{
  events: readonly CommandTraceEvent[];
  droppedEvents: number;
  terminal: CommandTraceTerminal;
}>;

/** Passive command-evaluator diagnostics; decisions never consult this interface. */
export type CommandTraceContext = {
  currentSegmentIndex?: number;
  flattenNested?: boolean;
  allocateSegment(): number;
  getNextSegmentIndex(): number;
  recordGlobal(step: TraceStep): void;
  recordSegment(step: TraceStep, segmentIndex?: number): void;
};
