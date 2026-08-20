import { describe, expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRuleCommand } from '@/cli/rule';
import * as systemInfo from '@/integrations/system-info';
import { captureConsoleOutput, runCCSafetyNetCli, withEnv, withTempDir } from '../../helpers';
import { writeProjectRuleConfig } from '../../helpers/rulebook';

describe('rule list exit code', () => {
  test('exits 0 when the merged policy has warnings but no errors', async () => {
    await withTempDir('safety-net-rule-list-warnings-', async (tempDir) => {
      const env = { HOME: join(tempDir, 'home') };
      const rulesDir = join(tempDir, '.cc-safety-net', 'rules');
      writeProjectRuleConfig(rulesDir);
      expect((await runCCSafetyNetCli(['rule', 'sync'], env, tempDir)).exitCode).toBe(0);
      writeFileSync(
        join(rulesDir, 'rule.json'),
        JSON.stringify({
          version: 1,
          rules: ['project-rules'],
          overrides: { 'project-rules/nope': 'off' },
        }),
      );

      const result = await runCCSafetyNetCli(['rule', 'list'], env, tempDir);

      expect(result.output).toContain('unknown override key "project-rules/nope"');
      expect(result.output).toContain('Warnings (1):');
      expect(result.output).toContain('Issues: (none)');
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('rule update notice', () => {
  test('prints the directive to stderr for doc only', async () => {
    await withTempDir('safety-net-rule-update-notice-', async (tempDir) => {
      await withEnv(
        {
          CC_SAFETY_NET_AUDIT_HOME: join(tempDir, 'home'),
          CC_SAFETY_NET_NO_UPDATE_CHECK: undefined,
        },
        async () => {
          const version = spyOn(systemInfo, 'getPackageVersion').mockReturnValue('1.0.0');
          const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ version: '2.0.0' })),
          );

          const list = await captureRuleCommand(['list']);
          expect(list.stderr).not.toContain('UPDATE_AVAILABLE:');
          expect(fetch).not.toHaveBeenCalled();

          const doc = await captureRuleCommand(['doc']);
          expect(doc.exitCode).toBe(0);
          expect(doc.stdout).toContain('# Custom Rules Reference');
          expect(doc.stderr).toBe(
            'UPDATE_AVAILABLE: cc-safety-net v2.0.0 is available (running v1.0.0). Ask the user once whether to run `npx -y cc-safety-net@latest update`; continue the current task either way and do not raise this again.',
          );

          fetch.mockRestore();
          version.mockRestore();
        },
      );
    });
  });
});

describe('rule leaf help', () => {
  test('renders migrate help, not generic rule help', async () => {
    const result = await captureRuleCommand(['migrate', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('cc-safety-net rule migrate');
    expect(result.output).toContain('cc-safety-net rule migrate [--cleanup]');
    expect(result.output).toContain('Migrate legacy inline rules');
    expect(result.output).not.toContain('SUBCOMMANDS:');
    expect(result.output).not.toContain('Print the rulebook authoring guide');
  });

  test('renders wrapper list help, not the first wrapper leaf', async () => {
    const result = await captureRuleCommand(['wrapper', 'list', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('cc-safety-net rule wrapper list');
    expect(result.output).toContain('List transparent command wrappers');
    expect(result.output).not.toContain('Trust a transparent command wrapper');
  });

  test('renders every wrapper action instead of the missing-action error', async () => {
    // The wrapper parser rejects a bare `rule wrapper`; asking for help is not that mistake.
    const result = await captureRuleCommand(['wrapper', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('cc-safety-net rule wrapper <subcommand>');
    expect(result.output).toContain('wrapper add <command>');
    expect(result.output).toContain('wrapper remove <command>');
    expect(result.output).toContain('wrapper list');
  });

  test('reports an unresolvable help target as the typo it is', async () => {
    const bogusLeaf = await captureRuleCommand(['wrapper', 'bogus', '--help']);
    expect(bogusLeaf.exitCode).toBe(1);

    const bogusSubcommand = await captureRuleCommand(['bogus', '--help']);
    expect(bogusSubcommand.exitCode).toBe(1);
  });

  test('renders generic rule help when no subcommand is given', async () => {
    const result = await captureRuleCommand(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('SUBCOMMANDS:');
    expect(result.output).toContain('Print the rulebook authoring guide');
  });

  // Depends on the dispatcher fix in src/cli/cc-safety-net.ts, which stops
  // handleCommandHelp from intercepting `rule <leaf> --help`.
  test('routes rule migrate --help to the leaf handler', async () => {
    const result = await runCCSafetyNetCli(['rule', 'migrate', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('cc-safety-net rule migrate');
    expect(result.output).not.toContain('Print the rulebook authoring guide');
  });
});

async function captureRuleCommand(args: string[]) {
  const {
    result: exitCode,
    stdout,
    stderr,
  } = await captureConsoleOutput(() => runRuleCommand(args));
  return {
    exitCode,
    output: [...stdout, ...stderr].join('\n'),
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
  };
}
