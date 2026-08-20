/**
 * Tests for the explain command runner, in particular that its stdout write completes
 * before the exit code reaches the CLI entry point (which exits immediately).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { runExplain } from '@/cli/explain/run';
import { captureConsoleOutput, withEnv, withTempDir } from '../../helpers.ts';

/**
 * Stands in for a piped stdout: the write is accepted but only reported complete on a
 * later tick, so a runner that returns without waiting leaves `flushed` behind `started`.
 */
async function captureStdout(run: () => Promise<number>) {
  const chunks: string[] = [];
  let started = 0;
  let flushed = 0;
  const write = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string,
    encoding?: unknown,
    callback?: () => void,
  ) => {
    const done = typeof encoding === 'function' ? (encoding as () => void) : callback;
    chunks.push(chunk);
    started += 1;
    setTimeout(() => {
      flushed += 1;
      done?.();
    }, 5);
    return false;
  }) as typeof process.stdout.write);

  try {
    const exitCode = await run();
    return { exitCode, chunks, started, flushed };
  } finally {
    write.mockRestore();
  }
}

// Recursion bomb: an explain argument only, never executed by a shell.
const ANALYSIS_LIMIT_COMMAND = 'loop() { loop; }; loop';

describe('runExplain stdout completion', () => {
  test('waits for the trace write to complete before returning', async () => {
    await withTempDir('safety-net-explain-run-', async (dir) => {
      const captured = await captureStdout(() =>
        withEnv({ HOME: dir, NO_COLOR: '1' }, () =>
          runExplain(['--json', '--cwd', dir, 'echo hello']),
        ),
      );

      expect(captured.exitCode).toBe(0);
      expect(captured.started).toBe(1);
      expect(captured.flushed).toBe(captured.started);
      expect(JSON.parse(captured.chunks.join(''))).toMatchObject({ result: 'allowed' });
    });
  });

  test('waits for the human trace write to complete before returning', async () => {
    await withTempDir('safety-net-explain-run-', async (dir) => {
      const captured = await captureStdout(() =>
        withEnv({ HOME: dir, NO_COLOR: '1' }, () => runExplain(['--cwd', dir, 'echo hello'])),
      );

      expect(captured.exitCode).toBe(0);
      expect(captured.flushed).toBe(captured.started);
      expect(captured.chunks.join('')).toContain('echo hello');
    });
  });

  test('waits for the analysis-limit error write to complete before returning', async () => {
    await withTempDir('safety-net-explain-run-', async (dir) => {
      const captured = await captureStdout(() =>
        withEnv({ HOME: dir, NO_COLOR: '1' }, () =>
          runExplain(['--json', '--cwd', dir, ANALYSIS_LIMIT_COMMAND]),
        ),
      );

      expect(captured.exitCode).toBe(1);
      expect(captured.started).toBe(1);
      expect(captured.flushed).toBe(captured.started);
      expect(JSON.parse(captured.chunks.join('')).error).toContain('limit exceeded');
    });
  });

  test('reports an analysis limit on stderr without stdout output in human mode', async () => {
    await withTempDir('safety-net-explain-run-', async (dir) => {
      const captured = await captureConsoleOutput(() =>
        captureStdout(() =>
          withEnv({ HOME: dir, NO_COLOR: '1' }, () =>
            runExplain(['--cwd', dir, ANALYSIS_LIMIT_COMMAND]),
          ),
        ),
      );

      expect(captured.result.exitCode).toBe(1);
      expect(captured.result.chunks).toEqual([]);
      expect(captured.stderr.join('\n')).toContain('limit exceeded');
    });
  });

  test('reports unusable flags without writing a trace', async () => {
    const captured = await captureConsoleOutput(() => captureStdout(() => runExplain([])));

    expect(captured.result.exitCode).toBe(1);
    expect(captured.result.chunks).toEqual([]);
    expect(captured.stderr.join('\n')).toContain('No command provided');
  });
});
