import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SOURCE_ROOT = join(process.cwd(), 'src');

function sourceFiles(dir = SOURCE_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function imports(path: string): string[] {
  return [
    ...readFileSync(path, 'utf-8').matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g),
  ].flatMap((match) => (match[1] ? [match[1]] : []));
}

function layer(path: string): string {
  return relative(SOURCE_ROOT, path).split('/')[0] ?? '';
}

function importedLayer(specifier: string): string | null {
  return specifier.startsWith('@/') ? (specifier.slice(2).split('/')[0] ?? null) : null;
}

describe('source architecture', () => {
  test('keeps dependency direction between ir, parser, core, engine, integrations, cli, and gui', () => {
    const violations = sourceFiles().flatMap((path) => {
      const owner = layer(path);
      return imports(path).flatMap((specifier) => {
        const target = importedLayer(specifier);
        const invalid =
          (owner === 'ir' && target !== null && target !== 'ir') ||
          (owner === 'parser' && target !== null && !['ir', 'parser'].includes(target)) ||
          (['rules', 'policy', 'analyzer', 'guards'].includes(owner) &&
            target !== null &&
            ['engine', 'integrations', 'cli', 'gui'].includes(target)) ||
          (owner === 'engine' &&
            target !== null &&
            ['integrations', 'cli', 'gui'].includes(target)) ||
          (owner === 'integrations' && (target === 'cli' || target === 'gui'));
        return invalid ? [`${relative(SOURCE_ROOT, path)} -> ${specifier}`] : [];
      });
    });
    expect(violations).toEqual([]);
  });

  test('routes guard access through the runtime integration boundary', () => {
    const violations = sourceFiles()
      .filter((path) => relative(SOURCE_ROOT, path) !== 'integrations/runtime.ts')
      .flatMap((path) =>
        imports(path).includes('@/engine/guard') ? [relative(SOURCE_ROOT, path)] : [],
      );
    expect(violations).toEqual([]);
  });

  test('the cli and gui consume core only through the engine facade', () => {
    const adminExceptions: readonly [string, RegExp][] = [
      // rules administration is read-write, outside the facade
      ['cli/rule/', /^@\/rules\//],
      // GUI policy editor is read-write, outside the facade
      ['gui/', /^@\/policy\/store$/],
    ];
    const violations = sourceFiles()
      .filter((path) => ['cli', 'gui'].includes(layer(path)))
      .flatMap((path) => {
        const file = relative(SOURCE_ROOT, path);
        return imports(path)
          .filter((specifier) => specifier.startsWith('@/'))
          .filter(
            (specifier) =>
              !/^@\/(?:cli|gui|ir|integrations)(?:\/|$)/.test(specifier) &&
              !['@/engine/facade', '@/engine/browser-facade'].includes(specifier) &&
              !adminExceptions.some(
                ([prefix, allowed]) => file.startsWith(prefix) && allowed.test(specifier),
              ),
          )
          .map((specifier) => `${file} -> ${specifier}`);
      });
    expect(violations).toEqual([]);
  });

  test('keeps the parser and ir layers free of third-party imports', () => {
    // A vendored shell parser or any other bare dependency pulled into src/parser
    // or src/ir passes every layering test above, which only sees @/ specifiers.
    const violations = ['parser', 'ir'].flatMap((owner) =>
      sourceFiles(join(SOURCE_ROOT, owner)).flatMap((path) =>
        imports(path)
          .filter((specifier) => !/^(?:node:|@\/|\.)/.test(specifier))
          .map((specifier) => `${relative(SOURCE_ROOT, path)} -> ${specifier}`),
      ),
    );
    expect(violations).toEqual([]);
  });

  test('contains no source import cycles', () => {
    const files = sourceFiles();
    const byModule = new Map(
      files.map((path) => [relative(SOURCE_ROOT, path).replace(/\.ts$/, ''), path]),
    );
    const edges = new Map(
      files.map((path) => [
        path,
        imports(path).flatMap((specifier) => {
          const unresolvedModule = specifier.startsWith('@/')
            ? specifier.slice(2)
            : specifier.startsWith('.')
              ? relative(SOURCE_ROOT, resolve(dirname(path), specifier))
              : null;
          if (unresolvedModule === null) return [];
          const module = unresolvedModule.replace(/\.(?:js|ts)$/, '');
          return [byModule.get(module), byModule.get(`${module}/index`)]
            .filter((candidate): candidate is string => candidate !== undefined)
            .slice(0, 1);
        }),
      ]),
    );
    const cycles = new Set<string>();
    const visit = (path: string, active: string[], done: Set<string>) => {
      const cycleAt = active.indexOf(path);
      if (cycleAt !== -1) {
        cycles.add(
          active
            .slice(cycleAt)
            .map((item) => relative(SOURCE_ROOT, item))
            .concat(relative(SOURCE_ROOT, path))
            .join(' -> '),
        );
        return;
      }
      if (done.has(path)) return;
      for (const target of edges.get(path) ?? []) visit(target, [...active, path], done);
      done.add(path);
    };
    const done = new Set<string>();
    for (const path of files) visit(path, [], done);
    expect([...cycles]).toEqual([]);
  });
});
