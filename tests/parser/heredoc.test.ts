import { describe, expect, test } from 'bun:test';
import { parseCommand } from '@/parser/command';
import { projectCommandViews } from '@/parser/traversal';

describe('POSIX heredoc parsing', () => {
  test('attaches quoted body metadata without parsing body prose as shell', () => {
    const source = "cat > note.md <<'EOF'\nit's never executed: rm -rf ~ and git reset --hard\nEOF";
    const program = parseCommand(source, 'posix');
    const views = projectCommandViews(program);
    const heredoc = views[0]?.redirections[1]?.heredoc;

    expect(program.status).toBe('complete');
    expect(program.issues).toEqual([]);
    expect(views).toHaveLength(1);
    expect(views[0]?.words.map((word) => word.text)).toEqual(['cat']);
    expect(heredoc).toMatchObject({
      body: "it's never executed: rm -rf ~ and git reset --hard\n",
      delimiter: 'EOF',
      quotedDelimiter: true,
      stripTabs: false,
    });
    if (!heredoc) throw new Error('expected parser-owned heredoc metadata');
    expect(source.slice(heredoc.bodySpan.start, heredoc.bodySpan.end)).toBe(heredoc.body);
    expect(source.slice(heredoc.terminatorSpan.start, heredoc.terminatorSpan.end)).toBe('EOF');
    expect(Object.isFrozen(heredoc)).toBeTrue();
    expect(Object.isFrozen(heredoc?.bodySpan)).toBeTrue();
    expect(Object.isFrozen(heredoc?.terminatorSpan)).toBeTrue();
  });

  test('parses unquoted and tab-stripping metadata without treating bodies as commands', () => {
    const unquoted = parseCommand('cat <<EOF\nbody\nEOF', 'posix');
    const stripped = parseCommand('cat <<-EOF\n\tbody\n\tEOF', 'posix');

    expect(projectCommandViews(unquoted)).toHaveLength(1);
    expect(projectCommandViews(unquoted)[0]?.redirections[0]?.heredoc).toMatchObject({
      body: 'body\n',
      quotedDelimiter: false,
      stripTabs: false,
    });
    expect(projectCommandViews(stripped)[0]?.redirections[0]?.heredoc).toMatchObject({
      body: 'body\n',
      quotedDelimiter: false,
      stripTabs: true,
    });
  });

  test('preserves CRLF body and terminator spans', () => {
    const source = "cat <<'EOF'\r\nbody\r\nEOF";
    const heredoc = projectCommandViews(parseCommand(source, 'posix'))[0]?.redirections[0]?.heredoc;

    if (!heredoc) throw new Error('expected parser-owned heredoc metadata');
    expect(heredoc.body).toBe('body\r\n');
    expect(source.slice(heredoc.bodySpan.start, heredoc.bodySpan.end)).toBe('body\r\n');
    expect(source.slice(heredoc.terminatorSpan.start, heredoc.terminatorSpan.end)).toBe('EOF');
  });

  test.each([
    ["cat <<'EOF'\nbody\nEOF", false],
    ['cat <<"EOF"\nbody\nEOF', false],
    ['cat <<\\EOF\nbody\nEOF', false],
    ["cat <<E'O'F\nbody\nEOF", false],
    ["cat <<-'EOF'\n\tbody\n\tEOF", true],
  ])('applies delimiter quote removal for %s', (source, stripTabs) => {
    expect(
      projectCommandViews(parseCommand(source, 'posix'))[0]?.redirections[0]?.heredoc,
    ).toMatchObject({
      body: 'body\n',
      delimiter: 'EOF',
      quotedDelimiter: true,
      stripTabs,
    });
  });

  test('removes supported escapes from a double-quoted delimiter', () => {
    const source = String.raw`cat <<"E\$OF"
body
E$OF`;

    expect(
      projectCommandViews(parseCommand(source, 'posix'))[0]?.redirections[0]?.heredoc,
    ).toMatchObject({
      body: 'body\n',
      delimiter: 'E$OF',
      quotedDelimiter: true,
      stripTabs: false,
    });
  });

  test('marks a trailing delimiter escape as ambiguous', () => {
    const program = parseCommand(['cat <<', '\\'].join(''), 'posix');

    expect(program.status).toBe('invalid');
    expect(program.issues.map(({ code }) => code)).toContain('ambiguous-heredoc-delimiter');
  });

  test('marks an unterminated quoted delimiter as ambiguous', () => {
    const program = parseCommand('cat <<"EOF', 'posix');

    expect(program.status).toBe('invalid');
    expect(program.issues.map(({ code }) => code)).toContain('ambiguous-heredoc-delimiter');
  });

  test('keeps here-strings separate from heredocs', () => {
    const view = projectCommandViews(parseCommand("cat <<<'rm -rf ~'", 'posix'))[0];

    expect(view?.redirections).toHaveLength(1);
    expect(view?.redirections[0]).toMatchObject({ operator: '<<<' });
    expect(view?.redirections[0]?.heredoc).toBeUndefined();
  });

  test('preserves declaration order and attached descriptors', () => {
    const program = parseCommand("cat 3<<A 0<<'B'\na\nA\nb\nB", 'posix');
    const redirections = projectCommandViews(program)[0]?.redirections;

    expect(program.status).toBe('complete');
    expect(redirections).toHaveLength(2);
    expect(redirections?.[0]).toMatchObject({ fd: 3, heredoc: { body: 'a\n' } });
    expect(redirections?.[1]).toMatchObject({
      fd: 0,
      heredoc: { body: 'b\n', quotedDelimiter: true },
    });
  });

  test('supports the issue 41 heredoc inside command substitution', () => {
    const source = "gh issue create --body \"$(cat <<'EOF'\nit's about rm -rf ~ cleanup\nEOF\n)\"";
    const program = parseCommand(source, 'posix');
    const views = projectCommandViews(program);

    expect(program.status).toBe('complete');
    expect(program.issues).toEqual([]);
    expect(views.map((view) => view.words.map((word) => word.text))).toEqual([
      ['gh', 'issue', 'create', '--body', ''],
      ['cat'],
    ]);
    const heredoc = views[1]?.redirections[0]?.heredoc;
    expect(heredoc).toMatchObject({
      body: "it's about rm -rf ~ cleanup\n",
      quotedDelimiter: true,
    });
    if (!heredoc) throw new Error('expected nested parser-owned heredoc metadata');
    expect(source.slice(heredoc.bodySpan.start, heredoc.bodySpan.end)).toBe(heredoc.body);
    expect(source.slice(heredoc.terminatorSpan.start, heredoc.terminatorSpan.end)).toBe('EOF');
  });

  test.each([
    "(cat <<'EOF')\nrm -rf ~ is body prose\nEOF",
    "{ cat <<'EOF'; }\nrm -rf ~ is body prose\nEOF",
  ])('consumes an unsupported group heredoc body without exposing it as commands in %s', (source) => {
    const program = parseCommand(source, 'posix');

    expect(program.status).toBe('invalid');
    expect(program.issues.map(({ code }) => code)).toContain('unsupported-heredoc-context');
    expect(projectCommandViews(program).map((view) => view.words.map((word) => word.text))).toEqual(
      [['cat']],
    );
  });

  test.each([
    ['cat <<', 'missing-heredoc-delimiter'],
    ['cat <<$(printf EOF)\nbody\nEOF', 'ambiguous-heredoc-delimiter'],
    ['cat <<EOF\nbody', 'unterminated-heredoc'],
    ["printf %s `cat <<'EOF'\nbody\nEOF\n`", 'unsupported-heredoc-context'],
  ])('marks unsupported heredoc syntax invalid for %s', (source, issue) => {
    const program = parseCommand(source, 'posix');

    expect(program.status).toBe('invalid');
    expect(program.issues.map(({ code }) => code)).toContain(issue);
  });
});
