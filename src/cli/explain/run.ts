/**
 * Runs the explain command and reports its exit code to the CLI entry point.
 *
 * The trace is written here rather than in the entry point so the write can be awaited:
 * `process.exit` drops whatever is still queued on a piped stdout, which truncated long
 * traces at the pipe buffer size.
 */

import {
  explainCommand,
  formatTraceHuman,
  formatTraceJson,
  parseExplainFlags,
} from '@/cli/explain/index';
import {
  PathCanonicalizationLimitError,
  StructuralShellSyntaxLimitError,
  ToolInputLimitError,
} from '@/engine/facade';

function writeStdoutLine(text: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${text}\n`, () => resolve());
  });
}

export async function runExplain(args: string[]): Promise<number> {
  const flags = parseExplainFlags(args);
  if (!flags) {
    return 1;
  }

  // Analysis budgets fail closed by throwing. Report those as bounded output so the CLI
  // never answers a limit with an uncaught stack trace; anything else is a real bug and
  // still reaches the top-level handler.
  try {
    const result = explainCommand(flags.command, { cwd: flags.cwd });
    const asciiOnly = !!process.env.NO_COLOR || !process.stdout.isTTY;

    await writeStdoutLine(
      flags.json ? formatTraceJson(result) : formatTraceHuman(result, { asciiOnly }),
    );
    return 0;
  } catch (error) {
    if (
      !(error instanceof StructuralShellSyntaxLimitError) &&
      !(error instanceof PathCanonicalizationLimitError) &&
      !(error instanceof ToolInputLimitError)
    ) {
      throw error;
    }
    if (flags.json) {
      await writeStdoutLine(JSON.stringify({ error: error.message }));
      return 1;
    }
    console.error(error.message);
    return 1;
  }
}
