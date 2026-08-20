import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json';
import { getRuntimeImportSpecifiers } from '../../scripts/verify-build';

const MANIFEST_PATH = 'kimi.plugin.json';

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    name: string;
    version: string;
    hooks: Array<{ event: string; command: string; timeout: number }>;
  };
}

function gitIncludes(path: string) {
  const result = Bun.spawnSync(['git', 'ls-files', '--cached', path], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.stdout.toString().trim().split('\n').filter(Boolean);
}

describe('Kimi Code plugin manifest', () => {
  test('ships at the repository root and is visible to git', () => {
    expect(existsSync(MANIFEST_PATH)).toBeTrue();
    expect(gitIncludes(MANIFEST_PATH)).toEqual([MANIFEST_PATH]);
    expect(readManifest().name).toBe('cc-safety-net');
  });

  test('declares the package version', () => {
    expect(readManifest().version).toBe(pkg.version);
  });

  test('declares one blocking hook that runs the packaged Kimi adapter for every tool', () => {
    const hooks = readManifest().hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.event).toBe('PreToolUse');
    expect(Object.hasOwn(hooks[0] ?? {}, 'matcher')).toBeFalse();
    expect(hooks[0]?.command).toBe('node ./dist/bin/cc-safety-net.js hook --kimi-code');
    expect(hooks[0]?.timeout).toBe(30);
  });

  test('targets a bundle whose required chunks are present', () => {
    const target = readManifest().hooks[0]?.command.split(' ')[1] ?? '';
    expect(existsSync(target)).toBeTrue();
    const chunks = getRuntimeImportSpecifiers(readFileSync(target, 'utf8')).filter((specifier) =>
      specifier.startsWith('../chunks/'),
    );
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach((specifier) => {
      expect(existsSync(join('dist/bin', specifier))).toBeTrue();
    });
  });
});
