import { describe, expect, test } from 'bun:test';
import {
  extractPatchTargetsFromToolInput,
  extractPathLikeToolValues,
  getCommandFromToolInput,
  getNonCommandToolInputKind,
  isReadOnlyTool,
  normalizeToolName,
  TOOL_INPUT_LIMITS,
} from '@/parser/tool-input';

function gitFallbackTarget(comparison: number, marker: string): string {
  return Array.from({ length: comparison }, (_, index) => `${marker}-${index}`).join(' ');
}

function captureToolInputError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected tool input parsing to fail');
}

describe('tool input routing', () => {
  test('reads only safe own data command fields', () => {
    expect(getCommandFromToolInput({ command: 'git status' })).toBe('git status');
    const nonEnumerable = Object.defineProperty({}, 'command', {
      value: 'git diff',
      enumerable: false,
    });
    expect(getCommandFromToolInput(nonEnumerable)).toBe('git diff');
    expect(getCommandFromToolInput({ command: '' })).toBeUndefined();
  });

  test('rejects inherited, accessor, nonstandard, and proxy command fields without reading them', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'command', {
      enumerable: true,
      get: () => {
        getterCalls++;
        return 'rm -rf /';
      },
    });
    const descriptorProxy = new Proxy(
      { command: 'rm -rf /' },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('descriptor trap');
        },
      },
    );

    expect(() => getCommandFromToolInput(Object.create({ command: 'rm -rf /' }))).toThrow(
      'tool input traversal limit exceeded',
    );
    expect(() => getCommandFromToolInput(accessor)).toThrow('tool input traversal limit exceeded');
    expect(() => getCommandFromToolInput(descriptorProxy)).toThrow(
      'tool input traversal limit exceeded',
    );
    expect(getterCalls).toBe(0);
  });

  test.each([
    ['apply_patch', 'applypatch'],
    ['apply-patch', 'applypatch'],
    [' Apply Patch ', 'applypatch'],
    ['GREP_SEARCH', 'grepsearch'],
    ['mcp__shell__run', 'mcpshellrun'],
  ])('normalizes %s to %s', (toolName, normalized) => {
    expect(normalizeToolName(toolName)).toBe(normalized);
  });

  test.each([
    ['apply_patch', 'patch'],
    ['apply-patch', 'patch'],
    ['patch', 'patch'],
    ['Read', 'path'],
    ['read_file', 'path'],
    ['read_url_content', 'path'],
    ['Write', 'path'],
    ['write_file', 'path'],
    ['write_to_file', 'path'],
    ['multi_replace_file_content', 'path'],
    ['Create', 'path'],
    ['Edit', 'path'],
    ['MultiEdit', 'path'],
    ['notebook_edit', 'path'],
    ['replace_file_content', 'path'],
    ['str_replace_editor', 'path'],
    ['view', 'path'],
    ['view_file', 'path'],
    ['list_dir', 'path'],
    ['list_permissions', 'path'],
    ['ls', 'path'],
    ['search_web', 'path'],
    ['grep', 'grep'],
    ['grep_search', 'grep'],
    ['rg', 'grep'],
    ['glob', 'glob'],
    ['find', 'glob'],
    ['find_by_name', 'glob'],
    ['execute_command', 'unknown'],
    ['mcp__shell__run', 'unknown'],
    ['Bash', 'unknown'],
    ['PowerShell', 'unknown'],
  ] as const)('classifies %s as %s', (toolName, kind) => {
    expect(getNonCommandToolInputKind(toolName)).toBe(kind);
  });

  test('treats search tools as read-only and writers as possible writers', () => {
    expect(isReadOnlyTool('find')).toBe(true);
    expect(isReadOnlyTool('find_by_name')).toBe(true);
    expect(isReadOnlyTool('write_file')).toBe(false);
  });
});

describe('bounded tool input traversal', () => {
  test('preserves ordered duplicates for shared non-cyclic input objects', () => {
    const shared = { path: 'src/shared.ts' };
    expect(extractPathLikeToolValues({ first: shared, second: shared }, new Set(['path']))).toEqual(
      ['src/shared.ts', 'src/shared.ts'],
    );
  });

  test('accepts exact string and aggregate byte boundaries and rejects one byte more', () => {
    const exactString = 'x'.repeat(TOOL_INPUT_LIMITS.maxStringBytes);
    expect(extractPathLikeToolValues({ path: exactString }, new Set(['path']))).toEqual([
      exactString,
    ]);
    expect(() => extractPathLikeToolValues({ path: `${exactString}x` }, new Set(['path']))).toThrow(
      'tool input traversal limit exceeded',
    );

    const quarter = 'x'.repeat(TOOL_INPUT_LIMITS.maxStringBytes);
    expect(
      extractPathLikeToolValues(
        { path: quarter, nested: [{ path: quarter }, { path: quarter }, { path: quarter }] },
        new Set(['path']),
      ),
    ).toEqual([quarter, quarter, quarter, quarter]);
    expect(() =>
      extractPathLikeToolValues(
        {
          path: quarter,
          nested: [{ path: quarter }, { path: quarter }, { path: quarter }, { path: 'x' }],
        },
        new Set(['path']),
      ),
    ).toThrow('tool input traversal limit exceeded');
  });

  test('fails closed on cycles and exhausted depth or node budgets', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => extractPathLikeToolValues(cyclic, new Set(['path']))).toThrow(
      'tool input traversal limit exceeded',
    );

    const exactDepth: Record<string, unknown> = { path: 'target' };
    let nested = exactDepth;
    for (let depth = 1; depth < TOOL_INPUT_LIMITS.maxDepth; depth++) nested = { nested };
    expect(extractPathLikeToolValues(nested, new Set(['path']))).toEqual(['target']);
    expect(() => extractPathLikeToolValues({ nested }, new Set(['path']))).toThrow(
      'tool input traversal limit exceeded',
    );

    expect(
      extractPathLikeToolValues(
        Array.from({ length: TOOL_INPUT_LIMITS.maxNodes - 1 }, () => null),
        new Set(['path']),
      ),
    ).toEqual([]);
    expect(() =>
      extractPathLikeToolValues(
        Array.from({ length: TOOL_INPUT_LIMITS.maxNodes }, () => null),
        new Set(['path']),
      ),
    ).toThrow('tool input traversal limit exceeded');
  });

  test('rejects inherited fields, nonstandard prototypes, accessors, and proxy traps', () => {
    const inherited = Object.create({ path: '.env' }) as Record<string, unknown>;
    const getter = Object.defineProperty({}, 'path', {
      enumerable: true,
      get: () => '.env',
    });
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('proxy trap');
        },
      },
    );
    const transparentProxy = new Proxy({ path: 'README.md' }, {});

    expect(() => extractPathLikeToolValues(inherited, new Set(['path']))).toThrow(
      'tool input traversal limit exceeded',
    );
    expect(() => extractPathLikeToolValues(getter, new Set(['path']))).toThrow(
      'tool input traversal limit exceeded',
    );
    expect(() => extractPathLikeToolValues(throwingProxy, new Set(['path']))).toThrow();
    expect(() => extractPathLikeToolValues(transparentProxy, new Set(['path']))).toThrow(
      'tool input traversal limit exceeded',
    );
  });

  test('rejects wide accessor objects before consulting any descriptor value', () => {
    let getterCalls = 0;
    const input = Object.defineProperties(
      {},
      Object.fromEntries(
        Array.from({ length: TOOL_INPUT_LIMITS.maxKeys + 50 }, (_, index) => [
          `path${index}`,
          {
            enumerable: true,
            get: () => {
              getterCalls++;
              return '.env';
            },
          },
        ]),
      ),
    );

    expect(() => extractPathLikeToolValues(input, new Set(['path']))).toThrow(
      'tool input traversal limit exceeded',
    );
    expect(getterCalls).toBe(0);
  });
});

describe('bounded Git diff fallback parsing', () => {
  test('accepts fallback comparison 64 and rejects comparison 65 with a typed fixed error', () => {
    const acceptedTarget = gitFallbackTarget(64, 'accepted');
    expect(
      extractPatchTargetsFromToolInput({ patch: `diff --git ${acceptedTarget} ${acceptedTarget}` }),
    ).toEqual([acceptedTarget, acceptedTarget]);

    const rejectedTarget = gitFallbackTarget(65, 'private-fallback-marker');
    const error = captureToolInputError(() =>
      extractPatchTargetsFromToolInput({ patch: `diff --git ${rejectedTarget} ${rejectedTarget}` }),
    );
    expect(error.constructor.name).toBe('ToolInputLimitError');
    expect(error.message).toBe('tool input traversal limit exceeded');
    expect(error.message).not.toContain('private-fallback-marker');
  });

  test('rejects the exact one-mebibyte slash-free fallback payload deterministically', () => {
    const prefix = 'diff --git ';
    const payload = `${prefix}${'x '.repeat(
      Math.floor((TOOL_INPUT_LIMITS.maxStringBytes - prefix.length) / 2),
    )}${(TOOL_INPUT_LIMITS.maxStringBytes - prefix.length) % 2 === 0 ? '' : 'x'}`;
    expect(Buffer.byteLength(payload)).toBe(1_048_576);

    const error = captureToolInputError(() =>
      extractPatchTargetsFromToolInput({ command: payload }),
    );
    expect(error.constructor.name).toBe('ToolInputLimitError');
    expect(error.message).toBe('tool input traversal limit exceeded');
  });

  test('keeps canonical quoted paths with more than 64 internal whitespace runs off fallback', () => {
    const target = `nested/${gitFallbackTarget(66, 'quoted')}`;
    expect(
      extractPatchTargetsFromToolInput({
        patch: `diff --git "a/${target}" "b/${target}"`,
      }),
    ).toEqual([target, target]);
  });

  test('accepts an exact-max canonical patch in order and rejects max plus one at traversal', () => {
    const prefix = 'diff --git /dev/null "b/';
    const suffix = '"';
    const target = 'x'.repeat(TOOL_INPUT_LIMITS.maxStringBytes - prefix.length - suffix.length);
    const exact = `${prefix}${target}${suffix}`;
    expect(Buffer.byteLength(exact)).toBe(TOOL_INPUT_LIMITS.maxStringBytes);
    expect(extractPatchTargetsFromToolInput({ patch: exact })).toEqual([`b/${target}`, target]);

    const error = captureToolInputError(() =>
      extractPatchTargetsFromToolInput({ patch: `${exact}x` }),
    );
    expect(error.constructor.name).toBe('ToolInputLimitError');
    expect(error.message).toBe('tool input traversal limit exceeded');
  });
});

describe('patch target extraction', () => {
  test('extracts Apply Patch headers recursively from every patch text field', () => {
    expect(
      extractPatchTargetsFromToolInput({
        command: [
          '*** Begin Patch',
          '*** Add File: src/added.ts',
          '*** Update File: src/updated.ts',
          '*** Move to: src/moved.ts',
          '*** Delete File: src/deleted.ts',
          '*** End Patch',
        ].join('\n'),
        nested: [
          { patch: '*** Update File: src/patched.ts' },
          { diff: '*** Delete File: src/diffed.ts' },
          { input: '*** Add File: src/input.ts' },
          { patchText: '*** Update File: src/opencode.ts' },
        ],
      }),
    ).toEqual([
      'src/added.ts',
      'src/updated.ts',
      'src/moved.ts',
      'src/deleted.ts',
      'src/patched.ts',
      'src/diffed.ts',
      'src/input.ts',
      'src/opencode.ts',
    ]);
  });

  test('extracts unified and git diff targets while ignoring /dev/null', () => {
    expect(
      extractPatchTargetsFromToolInput({
        diff: [
          'diff --git a/src/old.ts b/src/new.ts',
          '--- a/src/old.ts',
          '+++ b/src/new.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '--- /dev/null',
          '+++ b/src/created.ts',
          '@@ -0,0 +1 @@',
          '+created',
        ].join('\n'),
      }),
    ).toEqual([
      'src/old.ts',
      'src/new.ts',
      'src/old.ts',
      'src/new.ts',
      'b/src/created.ts',
      'src/created.ts',
    ]);
  });

  test('extracts unprefixed, quoted, and escaped git diff targets', () => {
    expect(
      extractPatchTargetsFromToolInput({
        patch: [
          'diff --git .env .env',
          'diff --git secret file.pem secret file.pem',
          'diff --git a/file with space b/file with space',
          'diff --git a/foo b/bar b/foo b/bar',
          'diff --git "a/secret file.pem" "b/secret file.pem"',
          String.raw`diff --git "a/\056env" "b/\056env"`,
          String.raw`diff --git "a/secret-\303\251.pem" "b/secret-\303\251.pem"`,
          String.raw`diff --git "a/foo\tbar.pem" "b/foo\tbar.pem"`,
        ].join('\n'),
      }),
    ).toEqual([
      '.env',
      '.env',
      'secret file.pem',
      'secret file.pem',
      'file with space',
      'file with space',
      'foo b/bar',
      'foo b/bar',
      'secret file.pem',
      'secret file.pem',
      '.env',
      '.env',
      'secret-é.pem',
      'secret-é.pem',
      'foo\tbar.pem',
      'foo\tbar.pem',
    ]);
  });

  test('extracts ambiguous rename and copy targets from extended Git headers', () => {
    expect(
      extractPatchTargetsFromToolInput({
        patch: [
          'diff --git a/old name b/new name',
          'similarity index 100%',
          'rename from old name',
          'rename to new name',
          'copy from source name',
          'copy to copied name',
        ].join('\n'),
      }),
    ).toEqual(['old name', 'new name', 'source name', 'copied name']);
  });

  test('decodes quoted unified and extended Git metadata targets before normalization', () => {
    expect(
      extractPatchTargetsFromToolInput({
        patch: [
          '--- "a/.cc-safety-net/rules/rule.json"',
          '+++ "b/.cc-safety-net/rules/rule.json"',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          'rename from old.txt',
          'rename to "private secret.txt"',
          String.raw`copy to "secret-\303\251.pem"`,
        ].join('\n'),
      }),
    ).toEqual([
      '.cc-safety-net/rules/rule.json',
      '.cc-safety-net/rules/rule.json',
      'old.txt',
      'private secret.txt',
      'secret-é.pem',
    ]);
  });

  test('handles standalone new-file metadata and malformed quoted metadata conservatively', () => {
    expect(
      extractPatchTargetsFromToolInput({
        patch: [
          '+++ b/standalone.ts',
          'rename to "private secret.txt" trailing-metadata',
          'diff --git "a/unterminated b/unterminated',
        ].join('\n'),
      }),
    ).toEqual([
      'standalone.ts',
      '"private secret.txt" trailing-metadata',
      '"a/unterminated',
      'b/unterminated',
      'unterminated',
    ]);
  });

  test('distinguishes standard, no-prefix, and custom-prefix Git path pairs', () => {
    expect(
      extractPatchTargetsFromToolInput({
        patch: [
          'diff --git a/src/file.ts b/src/file.ts',
          'diff --git a/private.dat a/private.dat',
          'diff --git old/config.json new/config.json',
        ].join('\n'),
      }),
    ).toEqual([
      'src/file.ts',
      'src/file.ts',
      'a/private.dat',
      'a/private.dat',
      'private.dat',
      'old/config.json',
      'new/config.json',
      'config.json',
    ]);
  });

  test('retains raw and stripped candidates for standalone unified add and delete paths', () => {
    expect(
      extractPatchTargetsFromToolInput({
        patch: [
          '--- /dev/null',
          '+++ new/config.json',
          '@@ -0,0 +1 @@',
          '+new',
          '--- old/removed.json',
          '+++ /dev/null',
          '@@ -1 +0,0 @@',
          '-old',
        ].join('\n'),
      }),
    ).toEqual(['new/config.json', 'config.json', 'old/removed.json', 'removed.json']);
  });

  test('extracts wrapperless multi-file Apply Patch headers after bare hunks', () => {
    expect(
      extractPatchTargetsFromToolInput({
        patch: [
          '*** Update File: safe.txt',
          '@@',
          '-safe',
          '+safer',
          '*** Update File: .env',
          '@@',
          '-old',
          '+new',
        ].join('\n'),
      }),
    ).toEqual(['safe.txt', '.env']);
  });

  test('ignores misleading hunk content even when it resembles patch metadata', () => {
    expect(
      extractPatchTargetsFromToolInput({
        patch: [
          'diff --git a/src/safe.ts b/src/safe.ts',
          '--- a/src/safe.ts',
          '+++ b/src/safe.ts',
          '@@ -1,4 +1,4 @@',
          '*** Update File: .env',
          '--- a/.ssh/id_rsa',
          '+++ b/.ssh/id_rsa',
          'diff --git a/.cc-safety-net/rules/rule.json b/.cc-safety-net/rules/rule.json',
        ].join('\n'),
      }),
    ).toEqual(['src/safe.ts', 'src/safe.ts', 'src/safe.ts', 'src/safe.ts']);
  });

  test('does not promote strings nested under unrelated content fields to patch text', () => {
    expect(
      extractPatchTargetsFromToolInput({
        content: ['*** Update File: .env'],
        nested: { replacement: ['*** Delete File: ~/.ssh/id_rsa'] },
      }),
    ).toEqual([]);
  });
});
