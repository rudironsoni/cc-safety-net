import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import type { EnvironmentContext } from '@/ir/analysis';
import { testEnvironment } from '../helpers/environment';
import {
  analyzeTestCommand as analyzeCommand,
  type TestPolicyInput as Config,
} from '../helpers/policy';
import { withSymlinkedHomeCwd } from '../helpers.ts';

const config: Config = { version: 1, rules: [] };

function withTempProject(fn: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'safety-net-powershell-'));
  try {
    fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function analyzePowerShell(
  command: string,
  cwd: string,
  options: {
    config?: Config;
    paranoidRm?: boolean;
    strict?: boolean;
    environment?: EnvironmentContext;
  } = {},
) {
  return analyzeCommand(command, { cwd, config, shell: 'powershell', ...options });
}

function expectStrictOnly(command: string, cwd: string, ruleId: string): void {
  expect(analyzePowerShell(command, cwd)).toBeNull();
  expect(analyzePowerShell(command, cwd, { strict: true })?.ruleId).toBe(ruleId);
}

describe('PowerShell Remove-Item support', () => {
  test('blocks recursive forced deletion of current directory', () => {
    withTempProject((cwd) => {
      const result = analyzePowerShell('Remove-Item . -Recurse -Force', cwd);

      expect(result?.ruleId).toBe('powershell.remove-item-recursive-force-cwd-self');
      expect(result?.reason).toContain('Remove-Item -Recurse -Force');
    });
  });

  test('blocks recursive forced deletion of home shorthand', () => {
    withTempProject((cwd) => {
      const result = analyzePowerShell('Remove-Item ~ -Recurse -Force', cwd);

      expect(result?.ruleId).toBe('powershell.remove-item-recursive-force-root-or-home');
      expect(result?.reason).toContain('root or home directory');
    });
  });

  test('blocks non-recursive root and home targets', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Remove-Item ~', cwd)?.ruleId).toBe(
        'powershell.remove-item-root-or-home',
      );
      expect(analyzePowerShell('Remove-Item /', cwd)?.ruleId).toBe(
        'powershell.remove-item-root-or-home',
      );
    });
  });

  test('blocks recursive forced deletion with dynamic targets only in strict mode', () => {
    withTempProject((cwd) => {
      expectStrictOnly(
        'Remove-Item $target -Recurse -Force',
        cwd,
        'powershell.remove-item-recursive-force-dynamic-target',
      );
    });
  });

  test('blocks recursive forced deletion with dynamic home target', () => {
    withTempProject((cwd) => {
      const result = analyzePowerShell('Remove-Item $HOME -Recurse -Force', cwd);

      expect(result?.ruleId).toBe('powershell.remove-item-recursive-force-root-or-home');
    });
  });

  test('blocks PowerShell environment home tokens through override channels', () => {
    withTempProject((cwd) => {
      const configs: Config[] = [
        config,
        { destructiveCommandProtectionEnabled: false },
        {
          destructiveCommandRuleOverrides: {
            'powershell.remove-item-recursive-force-root-or-home': 'off',
          },
        },
      ];
      for (const target of [
        '$env:USERPROFILE',
        '$env:HOME',
        '$env:USERPROFILE\\',
        '$env:USERPROFILE\\*',
        '$env:HOME/',
      ]) {
        for (const overrideConfig of configs) {
          expect(
            analyzePowerShell(`Remove-Item ${target} -Recurse -Force`, cwd, {
              config: overrideConfig,
            })?.ruleId,
            `${target} ${JSON.stringify(overrideConfig)}`,
          ).toBe('powershell.remove-item-recursive-force-root-or-home');
        }
      }
    });
  });

  test('blocks documented aliases and abbreviated parameters', () => {
    withTempProject((cwd) => {
      const result = analyzePowerShell('ri . -r -fo', cwd);

      expect(result?.ruleId).toBe('powershell.remove-item-recursive-force-cwd-self');
    });
  });

  test('blocks pipeline-fed Remove-Item without explicit target only in strict mode', () => {
    withTempProject((cwd) => {
      expectStrictOnly(
        'Get-ChildItem . -Recurse | Remove-Item -Force',
        cwd,
        'powershell.remove-item-pipeline-dynamic-target',
      );
    });
  });

  test('blocks recursive forced deletion after PowerShell statement separators', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Write-Output ok; Remove-Item . -Recurse -Force', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-cwd-self',
      );
      expect(analyzePowerShell('Write-Output ok\nRemove-Item . -Recurse -Force', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-cwd-self',
      );
      expect(
        analyzePowerShell('Write-Output ok && Remove-Item . -Recurse -Force', cwd)?.ruleId,
      ).toBe('powershell.remove-item-recursive-force-cwd-self');
      expect(
        analyzePowerShell('Write-Output ok || Remove-Item . -Recurse -Force', cwd)?.ruleId,
      ).toBe('powershell.remove-item-recursive-force-cwd-self');
    });
  });

  test('ignores destructive text in PowerShell comments and blocks later real commands', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Write-Output ok # Remove-Item . -Recurse -Force', cwd)).toBeNull();
      expect(
        analyzePowerShell('<# ; | Remove-Item . -Recurse -Force <# nested #> #> git status', cwd),
      ).toBeNull();
      expect(
        analyzePowerShell('<# Remove-Item . -Recurse -Force #>\nRemove-Item . -Recurse -Force', cwd)
          ?.ruleId,
      ).toBe('powershell.remove-item-recursive-force-cwd-self');
    });
  });

  test('fails closed on malformed and depth-limited PowerShell block comments', () => {
    withTempProject((cwd) => {
      expect(
        analyzeCommand('<# Remove-Item . -Recurse -Force', { cwd, shell: 'auto' }),
      ).toMatchObject({
        intent: 'stop_and_explain',
      });
      expect(analyzePowerShell(`${'<#'.repeat(65)}comment${'#>'.repeat(65)}`, cwd)).toMatchObject({
        intent: 'stop_and_explain',
      });
    });
  });

  test('blocks invocation operator form', () => {
    withTempProject((cwd) => {
      const result = analyzePowerShell('& Remove-Item . -Recurse -Force', cwd);

      expect(result?.ruleId).toBe('powershell.remove-item-recursive-force-cwd-self');
    });
  });

  test('blocks invocation operator script block form', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('& { Remove-Item . -Recurse -Force }', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-cwd-self',
      );
      expect(analyzePowerShell('. { Remove-Item . -Recurse -Force }', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-cwd-self',
      );
    });
  });

  test('analyzes literal commands passed to PowerShell expression evaluation', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell("iex 'Remove-Item . -Recurse -Force'", cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-cwd-self',
      );
      expect(analyzePowerShell("Invoke-Expression -Command 'git reset --hard'", cwd)?.ruleId).toBe(
        'git.reset-hard',
      );
      expect(analyzePowerShell("iex 'Write-Output ok'", cwd)).toBeNull();
    });
  });

  test('analyzes nested PowerShell subexpressions before their containing command', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Write-Output $(git reset --hard)', cwd)?.ruleId).toBe(
        'git.reset-hard',
      );
      expect(analyzePowerShell('Write-Output $(Remove-Item . -Recurse -Force)', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-cwd-self',
      );
      expect(analyzePowerShell('Write-Output $(git status)', cwd)).toBeNull();
      expect(
        analyzePowerShell('Remove-Item . -Recurse -Force $(git reset --hard)', cwd)?.ruleId,
      ).toBe('git.reset-hard');
    });
  });

  test('fails closed on malformed and depth-limited PowerShell subexpressions', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Write-Output $(git reset --hard', cwd)?.ruleId).toBe(
        'git.reset-hard',
      );
      const deeplyNested = `${'$('.repeat(65)}Write-Output ok${')'.repeat(65)}`;
      expect(analyzePowerShell(deeplyNested, cwd)?.reason).toContain('recursion depth');
    });
  });

  test('allows recursive forced deletion of an explicit child path in standard mode', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Remove-Item .\\dist -Recurse -Force', cwd)).toBeNull();
    });
  });

  test('does not treat braces inside path text as script block boundaries', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Remove-Item .\\{dist} -Recurse -Force', cwd)).toBeNull();
      expect(analyzePowerShell('Remove-Item ../{other} -Recurse -Force', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-outside-cwd',
      );
    });
  });

  test('allows recursive forced deletion with Path and LiteralPath inside cwd', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Remove-Item -Path .\\dist -Recurse -Force', cwd)).toBeNull();
      expect(analyzePowerShell('Remove-Item -LiteralPath:.\\dist -Recurse -Force', cwd)).toBeNull();
    });
  });

  test('blocks recursive forced deletion with comma-separated path arrays', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Remove-Item -Path .\\dist,/ -Recurse -Force', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-root-or-home',
      );
      expect(analyzePowerShell('Remove-Item .\\dist,/ -Recurse -Force', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-root-or-home',
      );
      expect(
        analyzePowerShell('Remove-Item -Path .\\dist,../other -Recurse -Force', cwd)?.ruleId,
      ).toBe('powershell.remove-item-recursive-force-outside-cwd');
    });
  });

  test('allows quoted comma path inside cwd as one literal target', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell("Remove-Item -Path '.\\dist,old' -Recurse -Force", cwd)).toBeNull();
    });
  });

  test('allows targets inside configured allow paths', () => {
    withTempProject((cwd) => {
      expect(
        analyzeCommand('Remove-Item /some/allowed/dir -Recurse -Force', {
          cwd,
          shell: 'powershell',
          config: { ...config, destructiveCommandAllowPaths: ['/some/allowed'] },
        }),
      ).toBeNull();
      expect(analyzePowerShell('Remove-Item /some/allowed/dir -Recurse -Force', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-outside-cwd',
      );
    });
  });

  test('allows allow-path targets in strict and paranoid mode', () => {
    withTempProject((cwd) => {
      const allowConfig: Config = { ...config, destructiveCommandAllowPaths: ['/some/allowed'] };
      expect(
        analyzePowerShell('Remove-Item /some/allowed/dir -Recurse -Force', cwd, {
          strict: true,
          config: allowConfig,
        }),
      ).toBeNull();
      expect(
        analyzePowerShell('Remove-Item /some/allowed/dir -Recurse -Force', cwd, {
          strict: true,
          paranoidRm: true,
          config: allowConfig,
        }),
      ).toBeNull();
    });
  });

  test('blocks the remaining documented Remove-Item aliases', () => {
    withTempProject((cwd) => {
      for (const alias of ['del', 'erase', 'rd', 'rm', 'rmdir']) {
        expect(analyzePowerShell(`${alias} . -Recurse -Force`, cwd)?.ruleId, alias).toBe(
          'powershell.remove-item-recursive-force-cwd-self',
        );
        expect(analyzePowerShell(`${alias} ../other -Recurse -Force`, cwd)?.ruleId, alias).toBe(
          'powershell.remove-item-recursive-force-outside-cwd',
        );
      }
    });
  });

  test('allows temp targets and blocks outside cwd targets', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Remove-Item /tmp/test-dir -Recurse -Force', cwd)).toBeNull();
      expect(analyzePowerShell('Remove-Item ../other -Recurse -Force', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-outside-cwd',
      );
      expect(analyzePowerShell('Remove-Item ..\\other -Recurse -Force', cwd)?.ruleId).toBe(
        'powershell.remove-item-recursive-force-outside-cwd',
      );
    });
  });

  test.skipIf(process.platform !== 'win32')(
    '[windows] blocks Windows namespace targets for Remove-Item, including target lists',
    () => {
      withTempProject((cwd) => {
        const namespace = toNamespacedPath(join(cwd, 'dist'));
        for (const target of [namespace, String.raw`\\server\share`, String.raw`/\server\share`]) {
          const result = analyzePowerShell(`Remove-Item '${target}' -Recurse -Force`, cwd);
          expect(result?.ruleId).toBe('powershell.remove-item-recursive-force-outside-cwd');
          expect(result?.reason).toContain('outside cwd is blocked');
        }

        expect(
          analyzePowerShell(`Remove-Item -Path '.\\dist','${namespace}' -Recurse -Force`, cwd)
            ?.ruleId,
        ).toBe('powershell.remove-item-recursive-force-outside-cwd');
        expect(
          analyzePowerShell(`Remove-Item '${join(cwd, 'dist')}' -Recurse -Force`, cwd),
        ).toBeNull();
      });
    },
  );

  test('blocks relative targets when cwd is home', () => {
    withTempProject((cwd) => {
      expect(
        analyzePowerShell('Remove-Item build -Recurse -Force', cwd, {
          environment: testEnvironment({ HOME: cwd }),
        })?.ruleId,
      ).toBe('powershell.remove-item-recursive-force-home-cwd');
    });
  });

  test('blocks relative targets when cwd is a symlink to home', () => {
    withSymlinkedHomeCwd('safety-net-powershell-home-link-', (home, cwd) => {
      expect(
        analyzePowerShell('Remove-Item build -Recurse -Force', cwd, {
          environment: testEnvironment({ HOME: home }),
        })?.ruleId,
      ).toBe('powershell.remove-item-recursive-force-home-cwd');
    });
  });

  test('blocks recursive forced child deletion in paranoid mode', () => {
    withTempProject((cwd) => {
      const result = analyzePowerShell('Remove-Item .\\dist -Recurse -Force', cwd, {
        paranoidRm: true,
      });

      expect(result?.ruleId).toBe('powershell.remove-item-recursive-force-paranoid');
    });
  });

  test('allows WhatIf-protected recursive forced deletion', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Remove-Item . -Recurse -Force -WhatIf', cwd)).toBeNull();
      expect(analyzePowerShell('Remove-Item . -Recurse -Force -WhatIf:$true', cwd)).toBeNull();
      expect(analyzePowerShell('Remove-Item . -Recurse -Force -wi', cwd)).toBeNull();
    });
  });

  test('blocks explicit WhatIf false', () => {
    withTempProject((cwd) => {
      const result = analyzePowerShell('Remove-Item . -Recurse -Force -WhatIf:$false', cwd);

      expect(result?.ruleId).toBe('powershell.remove-item-recursive-force-cwd-self');
    });
  });

  test('allows simple file deletion outside the minimal destructive rule', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell('Remove-Item file.txt', cwd)).toBeNull();
    });
  });

  test('allows simple quoted and escaped file deletion outside the minimal destructive rule', () => {
    withTempProject((cwd) => {
      expect(analyzePowerShell("Remove-Item 'file''name.txt'", cwd)).toBeNull();
      expect(analyzePowerShell('Remove-Item .`x -Recurse -Force', cwd)).toBeNull();
      expect(analyzePowerShell('Remove-Item ".`x" -Recurse -Force', cwd)).toBeNull();
      expect(analyzePowerShell('Remove-Item "$target -Recurse -Force', cwd)).toBeNull();
    });
  });

  test('blocks recursive forced deletion after end-of-parameters marker', () => {
    withTempProject((cwd) => {
      const result = analyzePowerShell('Remove-Item -Recurse -Force -- .', cwd);

      expect(result?.ruleId).toBe('powershell.remove-item-recursive-force-cwd-self');
    });
  });

  test('blocks recursive forced deletion with missing Path value only in strict mode', () => {
    withTempProject((cwd) => {
      expectStrictOnly(
        'Remove-Item -Recurse -Force -Path',
        cwd,
        'powershell.remove-item-recursive-force-dynamic-target',
      );
    });
  });

  test('blocks recursive forced deletion with splatted target only in strict mode', () => {
    withTempProject((cwd) => {
      expectStrictOnly(
        'Remove-Item @params -Recurse -Force',
        cwd,
        'powershell.remove-item-recursive-force-dynamic-target',
      );
    });
  });

  test('PowerShell shell still blocks Bash-like git commands', () => {
    withTempProject((cwd) => {
      const result = analyzePowerShell('git reset --hard', cwd);

      expect(result?.ruleId).toBe('git.reset-hard');
    });
  });

  test('posix shell does not apply PowerShell Remove-Item rules', () => {
    withTempProject((cwd) => {
      expect(
        analyzeCommand('Remove-Item . -Recurse -Force', { cwd, config, shell: 'posix' }),
      ).toBeNull();
    });
  });

  test('auto shell detects explicit Remove-Item but not plain POSIX rm -r', () => {
    withTempProject((cwd) => {
      expect(analyzeCommand('Remove-Item . -Recurse -Force', { cwd, config })?.ruleId).toBe(
        'powershell.remove-item-recursive-force-cwd-self',
      );
      expect(analyzeCommand('rm -r /', { cwd, config })?.ruleId).toBe(
        'rm.recursive-force-root-or-home',
      );
    });
  });

  test('auto shell selects PowerShell from later command heads and keeps cross-shell rules', () => {
    withTempProject((cwd) => {
      expect(
        analyzeCommand('Write-Output ok; Remove-Item . -Recurse -Force', { cwd, config })?.ruleId,
      ).toBe('powershell.remove-item-recursive-force-cwd-self');
      expect(
        analyzeCommand('Write-Output ok\nRemove-Item . -Recurse -Force', { cwd, config })?.ruleId,
      ).toBe('powershell.remove-item-recursive-force-cwd-self');
      expect(analyzeCommand('Write-Output ok; git reset --hard', { cwd, config })?.ruleId).toBe(
        'git.reset-hard',
      );
      expect(analyzeCommand('Write-Output ok; rm -rf /', { cwd, config })?.ruleId).toBe(
        'rm.recursive-force-root-or-home',
      );
    });
  });
});
