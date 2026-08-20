import { describe, expect, test } from 'bun:test';
import { parseCommand } from '@/parser/command';
import { projectCommandViews } from '@/parser/traversal';

describe('PowerShell command parser boundary', () => {
  test('preserves drive, UNC, backslash, and quoted literal argv', () => {
    const views = projectCommandViews(
      parseCommand(
        String.raw`Remove-Item "C:\Program Files\cache" \\server\share\cache -Recurse -Force`,
        'powershell',
      ),
    );

    expect(views[0]?.dialect).toBe('powershell');
    expect(views[0]?.words.map((word) => word.text)).toEqual([
      'Remove-Item',
      String.raw`C:\Program Files\cache`,
      String.raw`\\server\share\cache`,
      '-Recurse',
      '-Force',
    ]);
  });

  test('keeps quoted separators inert and models pipelines and connectors', () => {
    const program = parseCommand(
      "Write-Output 'safe;still-safe' | Remove-Item . -Recurse -Force; git reset --hard",
      'powershell',
    );

    expect(projectCommandViews(program).map((view) => view.words.map((word) => word.text))).toEqual(
      [
        ['Write-Output', 'safe;still-safe'],
        ['Remove-Item', '.', '-Recurse', '-Force'],
        ['git', 'reset', '--hard'],
      ],
    );
    expect(
      program.nodes.filter((node) => node.kind === 'connector').map((node) => node.operator),
    ).toEqual(['|', ';']);
  });

  test('marks variables and subexpressions as dynamic without executing both dialects', () => {
    const views = projectCommandViews(
      parseCommand(
        'Remove-Item "$target" -Recurse -Force; Write-Output $(Get-Item .)',
        'powershell',
      ),
    );

    expect(views[0]?.dialect).toBe('powershell');
    expect(views[0]?.words[1]?.provenance).toBe('variable');
    expect(views[1]?.words[1]?.provenance).toBe('command-substitution');
  });

  test('models executable subexpressions and script blocks as nested PowerShell programs', () => {
    const program = parseCommand(
      'Write-Output $(git reset --hard); & { Remove-Item . -Recurse -Force }',
      'powershell',
    );
    const views = projectCommandViews(program);

    expect(views.map((view) => [view.dialect, ...view.words.map((word) => word.text)])).toEqual([
      ['powershell', 'Write-Output', '$(git reset --hard)'],
      ['powershell', 'git', 'reset', '--hard'],
      ['powershell', '&'],
      ['powershell', 'Remove-Item', '.', '-Recurse', '-Force'],
    ]);
    expect(program.nodes.some((node) => node.kind === 'group')).toBeTrue();
    expect(views[0]?.nested[0]?.span).toEqual({ start: 15, end: 31 });
  });

  test('keeps a closing parenthesis inside a doubled-quote string in its subexpression', () => {
    const program = parseCommand("Write-Output $('it''s ) safe')", 'powershell');

    expect(program.status).toBe('complete');
    expect(program.issues).toEqual([]);
    expect(projectCommandViews(program).map((view) => view.words.map((word) => word.text))).toEqual(
      [['Write-Output', "$('it''s ) safe')"], ["it's ) safe"]],
    );
  });

  test('propagates malformed and depth-limited PowerShell subexpressions', () => {
    expect(parseCommand('Write-Output $(git reset --hard', 'powershell')).toMatchObject({
      status: 'partial',
      issues: [{ code: 'unclosed-command-subexpression' }],
    });
    const deeplyNested = `${'$('.repeat(65)}Write-Output ok${')'.repeat(65)}`;
    const limited = parseCommand(deeplyNested, 'powershell');

    expect(limited.status).toBe('limited');
    expect(JSON.stringify(limited)).toContain('depth-limit');
  });

  test('reports an unclosed script block without losing its nested command', () => {
    const program = parseCommand('& { Remove-Item . -Recurse -Force', 'powershell');

    expect(program.status).toBe('partial');
    expect(program.issues.map(({ code }) => code)).toContain('unclosed-script-block');
    expect(projectCommandViews(program).map((view) => view.words.map((word) => word.text))).toEqual(
      [['&'], ['Remove-Item', '.', '-Recurse', '-Force']],
    );
  });

  test('auto is quote-aware and chooses one parser from recognized syntax', () => {
    expect(parseCommand('Remove-Item . -Recurse -Force', 'auto').dialect).toBe('powershell');
    expect(parseCommand("echo 'Remove-Item . -Recurse -Force'", 'auto').dialect).toBe('posix');
    expect(parseCommand('git reset --hard', 'auto').dialect).toBe('posix');
    expect(parseCommand('rm -rf /', 'auto').dialect).toBe('posix');
  });

  test('auto inspects every command head without matching quoted or commented text', () => {
    for (const connector of ['; ', '\n', ' && ', ' | ']) {
      expect(
        parseCommand(`Write-Output ok${connector}Remove-Item . -Recurse -Force`, 'auto').dialect,
      ).toBe('powershell');
    }
    expect(parseCommand('Write-Output $(Remove-Item . -Recurse -Force)', 'auto').dialect).toBe(
      'powershell',
    );
    expect(parseCommand("echo 'Remove-Item . -Recurse -Force'; git status", 'auto').dialect).toBe(
      'posix',
    );
    expect(
      parseCommand('echo ok # Remove-Item . -Recurse -Force\ngit status', 'auto').dialect,
    ).toBe('posix');
  });

  test('ignores PowerShell line and nested block comments structurally', () => {
    const program = parseCommand(
      'Write-Output ok # ; | Remove-Item . -Recurse -Force\n<# outer ; <# nested | #> Remove-Item / #>\nRemove-Item . -Recurse -Force',
      'powershell',
    );

    expect(projectCommandViews(program).map((view) => view.words.map((word) => word.text))).toEqual(
      [
        ['Write-Output', 'ok'],
        ['Remove-Item', '.', '-Recurse', '-Force'],
      ],
    );
    expect(
      program.nodes.filter((node) => node.kind === 'connector').map((node) => node.operator),
    ).toEqual(['\n', '\n']);
  });

  test('auto ignores commented command heads and detects later real PowerShell commands', () => {
    expect(parseCommand('# Remove-Item . -Recurse -Force\ngit status', 'auto').dialect).toBe(
      'posix',
    );
    expect(
      parseCommand('<# Remove-Item . -Recurse -Force; | && #> git status', 'auto').dialect,
    ).toBe('posix');
    expect(
      parseCommand('<# Remove-Item . -Recurse -Force #>\nRemove-Item . -Recurse -Force', 'auto')
        .dialect,
    ).toBe('powershell');
  });

  test('reports unterminated and depth-limited PowerShell block comments conservatively', () => {
    expect(parseCommand('<# Remove-Item . -Recurse -Force', 'auto')).toMatchObject({
      dialect: 'powershell',
      status: 'invalid',
      issues: [{ code: 'unclosed-block-comment' }],
    });
    const deeplyNested = `${'<#'.repeat(65)}comment${'#>'.repeat(65)}`;
    expect(parseCommand(deeplyNested, 'powershell')).toMatchObject({
      status: 'limited',
      issues: [{ code: 'comment-depth-limit' }],
    });
  });

  test('preserves cross-shell Git and rm argv and reports malformed quotes', () => {
    expect(
      projectCommandViews(parseCommand('git reset --hard', 'powershell'))[0]?.words.map(
        (word) => word.text,
      ),
    ).toEqual(['git', 'reset', '--hard']);
    expect(
      projectCommandViews(parseCommand('rm -rf C:\\temp\\x', 'powershell'))[0]?.words.map(
        (word) => word.text,
      ),
    ).toEqual(['rm', '-rf', 'C:\\temp\\x']);
    expect(parseCommand('Remove-Item "unterminated', 'powershell')).toMatchObject({
      status: 'partial',
      issues: [{ code: 'unclosed-double-quote' }],
    });
  });

  test('handles PowerShell backtick escapes deterministically', () => {
    const source = 'Write-Output safe`;literal `"quoted`"';
    const first = parseCommand(source, 'powershell');

    expect(projectCommandViews(first)[0]?.words.map((word) => word.text)).toEqual([
      'Write-Output',
      'safe;literal',
      '"quoted"',
    ]);
    expect(parseCommand(source, 'powershell')).toEqual(first);
  });

  test('models redirects and reports input and word limits explicitly', () => {
    const limits = { maxInputLength: 16, maxWords: 2, maxDepth: 4 };
    const redirects = parseCommand('Write-Output ok > out', 'powershell');

    expect(projectCommandViews(redirects)[0]?.redirections).toMatchObject([
      { operator: '>', target: { text: 'out' } },
    ]);
    expect(parseCommand('x'.repeat(17), 'powershell', limits)).toMatchObject({
      status: 'limited',
      issues: [{ code: 'input-limit' }],
    });
    expect(parseCommand('one two three', 'powershell', limits)).toMatchObject({
      status: 'limited',
      issues: [{ code: 'word-limit' }],
    });
  });

  test('models line breaks, script-block boundaries, arrays, and malformed escapes', () => {
    const program = parseCommand(
      "Write-Output one, two\r\n& { Write-Output 'it''s' > out }",
      'powershell',
    );

    expect(projectCommandViews(program).map((view) => view.words.map((word) => word.text))).toEqual(
      [['Write-Output', 'one', ',', 'two'], ['&'], ['Write-Output', "it's"]],
    );
    expect(
      program.nodes.filter((node) => node.kind === 'connector').map((node) => node.operator),
    ).toEqual(['\r\n']);
    expect(program.nodes.some((node) => node.kind === 'group')).toBeTrue();
    expect(parseCommand("Write-Output 'unterminated", 'powershell')).toMatchObject({
      status: 'partial',
      issues: [{ code: 'unclosed-single-quote' }],
    });
    expect(parseCommand('Write-Output trailing`', 'powershell')).toMatchObject({
      status: 'partial',
      issues: [{ code: 'trailing-escape' }],
    });
  });
});
