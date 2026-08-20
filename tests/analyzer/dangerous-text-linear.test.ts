import { describe, expect, test } from 'bun:test';
import { dangerousInTextMatch } from '@/analyzer/dangerous-text';
import { containsDangerousCode } from '@/analyzer/interpreters';

const dangerousInText = (text: string) => dangerousInTextMatch(text)?.reason ?? null;

function expectLabel(text: string, label: string): void {
  expect(dangerousInText(text)).toContain(`(${label})`);
}

describe('linear raw danger matcher parity', () => {
  test.each([
    'rm -rf /tmp/x',
    'rm -fr /tmp/x',
    'rm -R -f /tmp/x',
    'rm -f -r /tmp/x',
    'rm --recursive x --force /tmp/x',
    'rm --recursive-extra --force-extra /tmp/x',
    '\\r\\m\u00a0--force\u00a0--recursive /tmp/x',
    'rm -r; -f /tmp/x',
    'rm -f| -r /tmp/x',
    'rm x--recursive y--force /',
    'rm x--recursive-extra y--force-extra /',
    'rm x--recursive--force /',
    'rm -r -rvf /tmp/x',
    'rm -f -fvr /tmp/x',
    'rm -xrf;tail /tmp/x',
    'rm -xfr|tail /tmp/x',
    'rm -r -xf;tail /tmp/x',
    'rm -f -xr|tail /tmp/x',
    'rm -rfé /tmp/x',
    'rm x rm -rf /tmp/x',
    'rm x rm -r -f /tmp/x',
    'rm x rm -f -r /tmp/x',
    'rm x rm y rm -fr /tmp/x',
    'rm x \\r\\m -rf /tmp/x',
    "rm x 'rm -rf /tmp/x",
    'rm x "rm -fr /tmp/x',
    'rm\n--recursive --force /tmp/x',
    'rm\u2028--recursive --force /tmp/x',
    'rm rm -rf /tmp/x',
    'rm rm -fr /tmp/x',
    'rm rm -r -f /tmp/x',
    'rm rm -f -r /tmp/x',
    'rm rm rm -rf /tmp/x',
    'rm\trm -rf /tmp/x',
    'rm\nrm -rf /tmp/x',
    'rm\rrm -rf /tmp/x',
    'rm\u2028rm -rf /tmp/x',
    'rm\u2029rm -rf /tmp/x',
  ])('matches rm recursive-force variant %s', (text) => expectLabel(text, 'rm -rf'));

  test.each([
    'xrm -rf /tmp/x',
    'rm -r proof-of-work',
    'rm --recursive -- /tmp/f',
    'rm operand -r -f /tmp/x',
    'rm -r; x -f /tmp/x',
    'rm -r; x rm -f /tmp/x',
    'rm -rxf /tmp/x',
    'rm -fxr /tmp/x',
    'rm x--recursive; y--force /',
    'rm x--recursive\n y--force /',
    'rm -rfx /tmp/x',
    'rm -frx /tmp/x',
    'rm -xrfx /tmp/x',
    'rm -xfrx /tmp/x',
    'rm -r -fx /tmp/x',
    'rm -f -rx /tmp/x',
    'rm -rf_ /tmp/x',
    'rm -r; rm -f /tmp/x',
    'rm -f | rm -r /tmp/x',
    'rm rm -r /tmp/x',
    'rm rm -rfx /tmp/x',
    'rm\nrm -r; rm -f /tmp/x',
  ])('does not invent an rm recursive-force match for %s', (text) =>
    expect(dangerousInText(text)).toBeNull());

  test.each([
    'git checkout topic -f',
    'git checkout topic --fo',
    'git checkout topic --for',
    'git checkout topic --forc',
    'git checkout topic --force',
    'git checkout topic & -f',
    'git checkout topic\n-f',
    'git checkout topic\r-f',
    'git checkout topic\u2028-f',
    "git checkout 'unterminated -f",
    'git checkout -Ufix',
    'git checkout --force-with-lease',
    'git checkout -btopic--force',
    'git checkout -x|f',
    'git checkout -x;f',
    'git checkout -x;git checkout -f',
    'git checkout -x|git checkout -f',
    'git checkout -f;git checkout -btopic',
  ])('preserves checkout force match %s', (text) => expectLabel(text, 'git checkout --force'));

  test.each([
    'git checkout topic | -f',
    'git checkout topic ; -f',
    'git checkout -bfix',
    'git checkout -Bfix',
    'git checkout: topic -f',
    'git checkout -x|z -f',
    'git checkout -x;git checkout -btopic',
    'git checkout -x|git checkout -Btopic',
  ])('preserves checkout non-match %s', (text) => expect(dangerousInText(text)).toBeNull());

  test.each([
    'git push origin -f',
    'git push origin --fo',
    'git push origin --for',
    'git push origin --forc',
    'git push origin --force',
    'git push origin & --force',
    'git push origin\n--force',
    'git push origin\r--force',
    'git push origin\u2029--force',
    'git push origin -f--with-lease',
  ])('preserves push force match %s', (text) => expectLabel(text, 'git push --force'));

  test.each([
    'git push origin | --force',
    'git push origin ; --force',
    'git push origin --fo-with-lease',
    'git push origin --for-with-lease',
    'git push origin --forc-with-lease',
    'git push origin --force-with-lease',
    'git push origin --forceful',
    'git push origin -f-with-lease',
    'git push origin -f-with-lease-extra',
    'git push: origin -f',
    'git push: origin --force',
  ])('preserves push force non-match %s', (text) => expect(dangerousInText(text)).toBeNull());

  test.each([
    'git push origin +main',
    'git push origin main:+',
    'git push origin :+topic',
    'git push origin\r+main',
    'git push origin\u2028+main',
    'git push origin\n+main',
  ])('preserves forced refspec match %s', (text) => expectLabel(text, 'git push --force'));

  test.each([
    'git push origin +',
    'git push origin ; +main',
    'git push origin;\n+main',
    'git push origin\n;+main',
  ])('preserves forced refspec non-match %s', (text) => expect(dangerousInText(text)).toBeNull());

  test.each([
    'git push origin --de',
    'git push origin --del',
    'git push origin --dele',
    'git push origin --delet',
    'git push origin --delete',
    'git push origin :topic',
    'git push origin\r:topic',
    'git push origin\n:topic',
  ])('preserves push delete match %s', (text) => expectLabel(text, 'git push delete'));

  test.each([
    'git push origin --destructive',
    'git push origin :',
    'git push origin;\n:topic',
    'git push origin\n;:topic',
  ])('preserves push delete non-match %s', (text) => expect(dangerousInText(text)).toBeNull());

  test.each([
    'git branch -D topic',
    'git branch -d -f topic',
    'git branch -f -d topic',
    'git branch -df topic',
    'git branch -fd topic',
    'git branch --delete --force topic',
    'git branch --force --delete topic',
    'git branch x--delete y--force topic',
    'git branch -aDtopic',
    'git branch -d x git branch -f',
    'git branch -f x git branch -d',
  ])('preserves branch delete-force match %s', (text) => expectLabel(text, 'git branch -D'));

  test.each([
    'GIT BRANCH -D topic',
    'git branch -d -F topic',
    'git branch --delete topic',
    'git branch --force topic',
    'git branch -d\n-f topic',
    'git branch -d & -f topic',
    'git branch -d1 -f topic',
    'git branch -d; git branch -f',
    'git branch -d & git branch -f',
    'git branch -d | git branch -f',
    'git branch -d\n git branch -f',
  ])('preserves branch non-match %s', (text) => expect(dangerousInText(text)).toBeNull());

  test.each([
    'git tag -d v1',
    'git tag --de v1',
    'git tag --delete v1',
    'git tag x & -d v1',
    'git tag x\n-d v1',
    'git tag x\r-d v1',
    'git tag --describe',
    'git tag x--delete',
    'git tag -abcd',
    'git tag -x|d',
    'git tag -x;git tag -d',
    'git tag -x|git tag -d',
    'git tag -d;git tag -x',
    'git tag --contains $(git tag -d v1)',
    'git tag --contains $(git log -Sneedle) -d v1',
    `git tag --contains "$(git log --fixed-strings --grep='(' -1 --format=%H)" -d v1`,
    String.raw`git tag --contains $(printf \() -d v1`,
  ])('preserves tag delete match %s', (text) => expectLabel(text, 'git tag -d'));

  test.each([
    'git tag x | -d v1',
    'git tag x ; -d v1',
    'git tag: x -d',
    'git tag -x|z -d',
    'git tag -x;git tag -x',
    'git tag -x|git tag -x',
    "git tag --contains $(git log --all --format='%H' -Sneedle -- src/file.ts | tail -n 1)",
    `git tag --contains "$(git log --fixed-strings --grep=')' -1 --format='-d')"`,
    String.raw`git tag --contains $(printf \) -d)`,
  ])('preserves tag delete non-match %s', (text) => expect(dangerousInText(text)).toBeNull());

  test.each([
    'git restore file',
    '--staged first; git restore file',
    'git restore --staged first; git restore file',
    'git restore file\n--staged',
    'git restore file\r--help',
    'git restore file\u2028--staged',
  ])('preserves restore match direction %s', (text) =>
    expectLabel(text, 'git restore without --staged'));

  test.each([
    'git restore file --staged',
    'git restore file; --helpful',
  ])('preserves restore exclusion %s', (text) => expect(dangerousInText(text)).toBeNull());

  test.each([
    'find . -delete',
    'prefix find .\t-delete',
    'find .\n-delete',
    'find .\r-delete',
    'find .\u2029-delete',
  ])('preserves raw find match %s', (text) => expectLabel(text, 'find -delete'));

  test.each([
    'find . ; -delete',
    'find .;\n-delete',
    'find .\n -delete',
    'echo "find . -delete',
    'rg "find . -delete',
  ])('preserves raw find non-match %s', (text) => expect(dangerousInText(text)).toBeNull());

  test('keeps original matcher priority rather than text position', () => {
    expectLabel('git reset --hard; rm -rf /tmp/x', 'rm -rf');
    expectLabel('git checkout -f; git clean -f', 'git clean -f');
  });
});

describe('linear interpreter danger matcher parity', () => {
  test.each([
    'rm -rf /tmp/x',
    'rm -R -f /tmp/x',
    'rm --force x --recursive /tmp/x',
    'rm\r-f\r-r /tmp/x',
    'rm\u2028-f\u2028-r /tmp/x',
  ])('preserves interpreter rm match %s', (text) => expect(containsDangerousCode(text)).toBe(true));

  test.each([
    'rm -r proof-of-work',
    'rm --recursive -- --force',
    'rm -r\n-f /tmp/x',
    'rm -r ; -f /tmp/x',
    'rm -r -- x rm -f',
    'rm -f -- x rm -r',
    'rm -rf\nnext',
  ])('preserves interpreter rm non-match %s', (text) =>
    expect(containsDangerousCode(text)).toBe(false));

  test.each([
    'dd if=/tmp/x of=/dev/sda',
    'dd x\rof=/dev/sda',
    'dd x\u2028of=/dev/sda',
  ])('preserves interpreter dd match %s', (text) => expect(containsDangerousCode(text)).toBe(true));

  test.each([
    'xdd of=/dev/sda',
    'dd x\nof=/dev/sda',
    'dd of=/dev/',
    'dd of=/dev/"sda"',
  ])('preserves interpreter dd non-match %s', (text) =>
    expect(containsDangerousCode(text)).toBe(false));

  test.each([
    'find . -delete',
    'find . ; -delete',
    'find . & -delete',
    'find .\n-delete',
    'find .\r-delete',
    'find .\u2028-delete',
    'find .\u2029-delete',
  ])('preserves interpreter find match %s', (text) =>
    expect(containsDangerousCode(text)).toBe(true));

  test.each([
    'find .\n -delete',
    'find .\n;-delete',
  ])('preserves interpreter find non-match %s', (text) =>
    expect(containsDangerousCode(text)).toBe(false));
});
