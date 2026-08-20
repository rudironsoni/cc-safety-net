# Residual Risk Registry

This registry records bypass families adjudicated as **accepted residual risk** for standard mode
under the review boundary in `REVIEW.md` and the mode contract in `SECURITY.md`. Its job is to make
review converge: each family is adjudicated once, here, instead of re-litigated in every review
cycle. `docs/residual-risk-registry.json` is the canonical structured index for identifiers,
boundaries, affected modes, and adjudication metadata; this file is the human-readable rationale.

All command examples are analyzer input strings only. Do not execute them in a shell.

## How Reviews Consume This Registry

- A finding that falls inside a listed family is pre-adjudicated. It is not merge-blocking and does
  not get a standard-mode parser fix. Report it, if at all, as a non-blocking residual note.
- The productive response to a newly crafted bypass inside a listed family is a strict or paranoid
  fail-closed fixture (see `tests/analyzer/strict-unverifiable.test.ts`), not more standard-mode
  parser logic. Strict mode's fail-closed promise is finite and checkable; standard's blocklist is
  not.
- Realistic non-adversarial provenance or field evidence makes a standard-mode false negative
  must-fix. A reviewer-constructed shape may become a new residual family only when the automated
  gates in `REVIEW.md` pass and an independent classifier confirms it. Otherwise it is
  evidence-invalid.
- Corpus growth follows evidence, not imagination. New must-block entries in
  `tests/analyzer/behavioral-contract-cases.ts` come from field evidence; the fix is then the
  smallest change that makes the corpus pass, preferring an ownership boundary, a bounded
  conservative check, or a strict-only denial over parser fidelity.

## How a Family Gets Adjudicated

1. The primary agent verifies and classifies the finding using the deterministic decision order in
   `REVIEW.md`.
2. Existing-family matches reuse that family. Must-fix findings become behavioral-contract corpus
   entries before the smallest corrective change. Evidence-invalid findings create no registry
   entry.
3. A candidate new family requires an independent, context-isolated classifier. Both agents must
   agree on every gate; disagreement cannot accept risk.
4. Accepted new families get a strict or paranoid fail-closed fixture, a structured entry in
   `docs/residual-risk-registry.json`, and the rationale below.
5. Review confirms the registry entry and this document stay synchronized before the
   classification is complete.

RR-1 through RR-10 are immutable legacy records. Automated adjudication starts at RR-11.

Automated entries use this shape; the candidate identifies the adjudicated finding and the
evidence must cite existing repository files:

```json
{
  "id": "RR-11",
  "title": "Family Title",
  "boundary": "distinct-ownership-boundary",
  "affected_modes": ["standard"],
  "strict_fixture": {
    "path": "tests/core/analyze/residual-risk-fixtures.test.ts",
    "case_id": "rr-11-case-id",
    "mode": "strict",
    "command": "analyzer input that must fail closed",
    "expected_rule_id": "expected.rule-id"
  },
  "adjudication": {
    "kind": "automated",
    "date": "YYYY-MM-DD",
    "candidate": {
      "summary": "Canonical description of the exact finding being classified.",
      "path": "src/relevant-source.ts",
      "line": 123
    },
    "documented_boundary": "SECURITY.md boundary",
    "evidence": [{ "path": "SECURITY.md", "note": "Relevant contract evidence." }]
  }
}
```

The central `tests/core/analyze/residual-risk-fixtures.test.ts` harness executes every automated
fixture under its declared mode and asserts the expected blocking rule.

## What Is Never Residual Risk

A finding in any of these areas is always in scope and merge-blocking, no matter how contrived the
triggering input is:

- Catastrophic protections failing in any mode: recursive deletion of root or home, destructive
  mutation of the protected Git metadata set, or destructive mutation of the canonical user policy
  file.
- Strict or paranoid mode failing open where `SECURITY.md` documents fail-closed behavior.
- False positives: a safe command that agents commonly run being blocked.
- Documented resource bounds regressing, or new resource-exhaustion behavior such as catastrophic
  regex backtracking or unbounded recursion.
- Secret redaction failing in audit or diagnostic output, or the tool itself becoming a harmful
  vector (`SECURITY.md`, "The Boundary: Bug or Vulnerability?").

## Adjudicated Families

### RR-1: Dynamic Executables and Computed Command Names

Command names assembled at runtime: `$(printf r)m -rf /`; `c=rm; "$c" -rf dir`;
`$(which rm) -rf dir`. Standard allows these by contract: helpful agents write the literal command
name, and resolving computed names means emulating shell expansion. Strict blocks the family as
`shell.dynamic-executable`.

Adjudicated 2026-07-22. Sources: `SECURITY.md` safety-preset contract; behavioral-contract case
"allows an executable assembled by command substitution at standard safety".

### RR-2: Command Structure Assembled Through Substitution

Flags or operands that materialize from substitution output at runtime, such as
`rm $(printf -- '-rf') dir`. Standard allows guarded structure-via-substitution; the bounded
conservative rules that already catch dynamic input, such as the xargs and GNU Parallel
dynamic-input rules and the linear dangerous-text scans, stay active. Strict fails closed on
unverifiable forms.

Adjudicated 2026-07-22. Sources: `SECURITY.md` safety-preset contract;
`tests/analyzer/strict-unverifiable.test.ts`.

### RR-3: Unverifiable Recursive-Delete Targets

Recursive-delete targets whose runtime value static analysis cannot prove, such as
`rm -rf "$BUILD_DIR"` or computed paths under temp roots. Standard allows them because temp-cleanup
idioms are pervasive and blocking them is false-positive-prohibitive; strict blocks the family as
`rm.recursive-force-dynamic-target`, and that rule can be force-enabled under standard through
per-rule policy controls. `allow_paths` never apply to dynamic targets, and the catastrophic set
remains enforced.

Adjudicated 2026-07-22. Sources: `SECURITY.md` safety-preset and allow-path contracts;
`docs/rm-temp-target-security-findings.md` section 2;
`tests/analyzer/strict-unverifiable.test.ts`.

### RR-4: Runtime-Reconstructed Strings Inside Interpreter Code

Sensitive paths or commands assembled by interpreter expressions: `chr()` and
`String.fromCharCode()` character assembly, split base64 or hex fragments, concatenation,
reversal, and runtime-discovered filenames. Standard scans literals, including complete base64
literals; expression evaluation is refused because it would require partial interpreters for every
language. The complete mitigation is OS-level filesystem enforcement.

Adjudicated 2026-07-22. Sources: `docs/secret-protection-known-limitations.md`;
`docs/secret-protection-bypass-findings.md`.

### RR-5: Script and Interpreter File Bodies

Destructive content inside a file the analyzed command merely invokes, such as `bash setup.sh` or
`python tool.py`. The gate analyzes command text, not file contents; inline `-c` and `-e` code is
analyzed. This is inherent residual risk for a static pre-execution text gate in every mode; the
mitigation is OS-level enforcement or a sandbox.

Adjudicated 2026-07-22. Source: `SECURITY.md` policy-file protection non-goals ("does not inspect
interpreter bodies").

### RR-6: Exact Shell-Expansion Emulation

Glob, brace, extglob, arithmetic, and `IFS` word-splitting semantics. Standard applies bounded
conservative checks and the documented compatibility exceptions but never exact expansion
emulation; crafted expansion tricks that survive those checks are residual, and strict-tier
fail-closed behavior owns the adversarial case.

Adjudicated 2026-07-22. Sources: `SECURITY.md` non-goals ("does not expand shell globs or
braces"); `docs/rm-temp-target-security-findings.md` section 2.

### RR-7: Runtime Shell-State Mutation

Aliases, shell functions, `PATH` or `IFS` mutation, sourced files, and disabled built-ins crafted
to change what command text means at execution time. Tracking is limited to simple assignment-only
variables, explicit `cd`, and the documented shell-state factors; the linear dangerous-text scans
still catch recognizable destructive text regardless of surrounding structure.

Adjudicated 2026-07-22. Sources: `REVIEW.md` threat model (runtime mutation); `SECURITY.md`
policy-file protection scope.

### RR-8: Quoting-Concatenation and Analyzer-Marker Attacks

Crafted quote concatenation aimed at analyzer internals, such as the sentinel-spoofing shape
`rm -rf "$tmp" '__PREFIX_'SUFFIX__`. The archetype was eliminated when the internal parser replaced
sentinel-based quote rewriting; no sentinel markers exist in the analyzer today. The family remains
adversarial by construction, and standard mode makes no bypass-proof claim against deliberate
quoting tricks. The same input causing
a strict or paranoid fail-open is never residual.

Adjudicated 2026-07-22. Source: `docs/rm-temp-target-security-findings.md` section 1.

### RR-9: Exact Tool-Language Emulation

Full emulation of `find` actions, `xargs`, GNU Parallel, archive member layouts, `find`-style
simulation, remote filenames, or a transfer's final filename. Bounded conservative rules stay
active in standard, including `find.delete` and the xargs and parallel dynamic-input rules; exact
argument-language emulation is refused in every mode.

Adjudicated 2026-07-22. Sources: `REVIEW.md` threat model; `SECURITY.md` policy-file protection
non-goals.

### RR-10: Standalone Metadata-Only Sensitive-Path Checks

Metadata-only discovery of built-in sensitive paths, such as `ls -la ~/.ssh` or `stat .env`.
Standard intentionally allows standalone metadata checks while keeping content access blocked;
strict and paranoid block metadata-only discovery.

Adjudicated 2026-07-22. Source: `SECURITY.md` safety-preset contract.
