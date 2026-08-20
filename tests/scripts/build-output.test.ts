import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { getBundledOutputs, isRootDeclarationOutput } from '../../scripts/build-output';
import { verifyBuildArtifacts } from '../../scripts/verify-build';

describe('getBundledOutputs', () => {
  // Phase 5 artifact evidence compares raw `wc -c` bytes for index/CLI/Pi to
  // revision 0bf15f82. CLI startup is measured separately with 10 interleaved
  // cold Node `--help` subprocesses for current and baseline artifacts; it is
  // intentionally not asserted here because absolute process timing is host-sensitive.
  test('finds bundled outputs with Windows paths', () => {
    const outputs = getBundledOutputs([
      { path: 'C:\\a\\cc-safety-net\\cc-safety-net\\dist\\index.js', size: 1000 },
      { path: 'C:\\a\\cc-safety-net\\cc-safety-net\\dist\\cli\\cc-safety-net.js', size: 2000 },
      { path: 'C:\\a\\cc-safety-net\\cc-safety-net\\dist\\integrations\\pi\\index.js', size: 3000 },
    ]);

    expect(outputs.indexOutput?.size).toBe(1000);
    expect(outputs.binOutput?.size).toBe(2000);
    expect(outputs.piOutput?.size).toBe(3000);
  });

  test('keeps the root declaration with Windows paths', () => {
    expect(isRootDeclarationOutput('dist\\index.d.ts')).toBeTrue();
    expect(isRootDeclarationOutput('dist\\pi\\index.d.ts')).toBeFalse();
  });

  test('lazily loads the vendored Zod copy from the split bundles', async () => {
    // The split bundles ship in repository checkouts with no node_modules, so
    // nothing may resolve Zod from a package; they require the vendored copy
    // instead, and only when a schema is first built.
    const artifacts = (await verifyBuildArtifacts()).filter(
      (path) => /\.c?js$/.test(path) && !path.startsWith('dist/openclaw/'),
    );
    const sources = artifacts.map((path) => [path, readFileSync(path, 'utf-8')] as const);

    // The build minifies identifiers, so the `createRequire` binding schema.ts
    // calls has no stable name; the specifier it is called with does.
    expect(sources.some(([, source]) => /(?:from|\w+\()"zod"/.test(source))).toBeFalse();
    // Zod names its internal schema classes with string literals minification
    // cannot rewrite, so their presence marks the copy that holds Zod itself.
    expect(
      sources
        .filter(([path]) => path.endsWith('.js'))
        .some(([, source]) => source.includes('"$ZodString"')),
    ).toBeFalse();
    expect(readFileSync('dist/vendor/zod.cjs', 'utf-8')).toContain('"$ZodString"');

    const vendorConsumers = sources.filter(([, source]) => source.includes('vendor/zod.cjs'));
    expect(vendorConsumers.length).toBeGreaterThan(0);
    vendorConsumers.forEach(([path, source]) => {
      expect(source).toMatch(/\w+\("\.\.\/vendor\/zod\.cjs"\)/);
      expect(source).not.toMatch(/from\s*"[^"]*vendor\/zod\.cjs"/);
      expect(posix.join(posix.dirname(path), '../vendor/zod.cjs')).toBe('dist/vendor/zod.cjs');
    });
  });
});
