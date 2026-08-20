# Recursive-delete temp-target security findings

This document records two security findings discovered while adding quote provenance for safe
`mktemp -d` cleanup. Reproductions below are analyzer inputs only. Do not execute them in a shell.

## 1. Quote-provenance sentinel spoofing

Status: resolved. The internal-parser rewrite removed the sentinel mechanism entirely; the
reproduction is analyzed without any sentinel rewriting.

### Impact

A shell token could be mistaken for an exact, double-quoted variable operand. That could cause a
second unsafe recursive-delete target to be rewritten internally as the proven `mktemp` variable
and allowed. Home-directory and paranoid-mode protections were bypassed in the analyzer result.

### Analyzer-only reproduction

```sh
tmp=$(mktemp -d); rm -rf "$tmp" '__CC_SAFETY_NET_EXACT_'DOUBLE_QUOTED_VARIABLE_0__
```

The final operand is a literal relative path. Shell quote concatenation produces the token
`__CC_SAFETY_NET_EXACT_DOUBLE_QUOTED_VARIABLE_0__`, even though that full string is not contiguous
in the source. Before the fix, the parser restored both that token and the genuine provenance
sentinel as `$tmp`, marked both operands as double-quoted, and returned an allowed result.

### Root cause

The temporary sentinel prefix was checked only against raw command text. `shell-quote` removes
quotes and concatenates adjacent shell-word fragments, so parsed tokens can contain a sentinel
that never appeared contiguously in the source.

### Fix and coverage

The interim sentinel-selection hardening described here was superseded before it landed: the
analyzer now parses commands with the internal parser in `src/parser/` and never rewrites operands
through sentinel markers, so no token can be mistaken for the proven `mktemp` variable. The
`__CC_SAFETY_NET_EXACT` sentinel and the `shell-quote` dependency are absent from `src/`. No
dedicated regression fixture exists for the reproduction above; the mechanism it attacked was
removed, and the reproduction is blocked by the ordinary home-directory recursive-delete rules.

## 2. Pre-existing dynamic temp-path classification gaps

Status: resolved at the strict tier. Strict and paranoid block every shape below as
`rm.recursive-force-dynamic-target` (brace traversal is blocked in every mode); standard keeps the
RR-3 compatibility allowance for the variable shapes. Regression tests live in
`tests/analyzer/rules-rm.test.ts`.

### 2.1 Dynamic suffixes under literal temp roots

Analyzer-only examples:

```sh
name=../Users; rm -rf /tmp/$name
name=../Users; rm -rf /var/tmp/$name
rm -rf /tmp/{safe,../Users}
```

Targets beginning with `/tmp/` or `/var/tmp/` are currently classified as safe temp targets before
dynamic syntax is checked. At shell execution time, variable or brace expansion can produce paths
outside the intended temp root.

Expected behavior: dynamic expansions, traversal, command substitutions, backticks, globs, brace
expansion, and extglob syntax should not receive the literal temp-root exception. Unsafe cases
should return `rm.recursive-force-dynamic-target`.

Strict-tier code now rejects dynamic syntax beneath literal `/tmp` and `/var/tmp` roots; the brace
form's `..` component defeats temp classification in every mode.

### 2.2 Word splitting in unquoted `$TMPDIR` targets

Analyzer-only example:

```sh
TMPDIR="/tmp/safe /Users"; rm -rf $TMPDIR/literal
```

The statement-level assignment previously never reached tracked shell state (the space-containing
single-token segment returned before env application), so the rm segment trusted `$TMPDIR`.
Assignment tracking now applies on that path, and word-splitting values are distrusted, so strict
and paranoid block the reproduction; standard keeps the RR-3 allowance. During real shell
execution, word splitting turns the target into multiple operands, including a path outside the
intended temp root. Mutated `IFS` values can create related splitting hazards.

Expected behavior: an unquoted `$TMPDIR` target must not be trusted when the effective value can
split into multiple shell words. Unsafe `TMPDIR` assignments and relevant `IFS` mutations should
fail closed.

Fixed by applying shell-state tracking on the deferred single-token path; the existing
word-splitting distrust in `src/analyzer/tmpdir.ts` then applies.

## Required follow-up

All follow-ups are resolved: strict and paranoid block dynamic syntax beneath literal temp roots
and distrust word-splitting `TMPDIR` assignments in both statement and prefix form; standard keeps
the RR-3 compatibility allowance. `IFS` mutation already fails closed in every mode.
