<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/cc-safety-net-header-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./.github/assets/cc-safety-net-header-logo-light.svg">
    <img alt="CC Safety Net" src="./.github/assets/cc-safety-net-header-logo-light.svg">
  </picture>
</h1>

[![CI](https://github.com/kenryu42/cc-safety-net/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/cc-safety-net/actions/workflows/ci.yml)
[![codecov](https://codecov.io/github/kenryu42/cc-safety-net/branch/main/graph/badge.svg?token=C9QTION6ZF)](https://codecov.io/github/kenryu42/cc-safety-net)
[![Version](https://img.shields.io/github/v/tag/kenryu42/cc-safety-net?label=version&color=blue)](https://github.com/kenryu42/cc-safety-net)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](https://opensource.org/licenses/MIT)

<div align="center">

**English** · [简体中文](https://ccsafetynet.com/docs/zh-Hans) · [日本語](https://ccsafetynet.com/docs/ja)

[![CC Safety Net](./.github/assets/cc-safety-net-v2.png)](./.github/assets/cc-safety-net-v2.png)

</div>

CC Safety Net — short for **Coding CLI** Safety Net — is a PreToolUse hook that blocks destructive commands and access to secrets like SSH keys and `.env` files, before AI coding agents run them. It parses command **semantics**, so flag reordering, shell wrappers, and interpreter one-liners can't bypass it.

> [!NOTE]
> **[Full documentation →](https://ccsafetynet.com/docs)** — installation, configuration, reference, guides, and the security model live on the docs site. This README is the short version.

## Why this exists

We learned the [hard way](https://www.reddit.com/r/ClaudeAI/comments/1pgxckk/claude_cli_deleted_my_entire_home_directory_wiped/) that instructions aren't enough to keep AI agents in check. After an agent silently wiped hours of progress with a single `rm -rf ~/` or `git checkout --`, it became clear that **soft** rules in a `CLAUDE.md` or `AGENTS.md` file cannot replace **hard** technical constraints. CC Safety Net is that constraint: it observes relevant tool calls and blocks destructive commands and secret access before they reach the shell. See [What Is CC Safety Net](https://ccsafetynet.com/docs/introduction) for the full background.

## What's new in v2.0.0

> [!TIP]
> **Already running v1?** One command upgrades every installed integration to v2: `npx -y cc-safety-net@latest update`. If you defined custom rules under v1, also read [Upgrading from an older version](#upgrading-from-an-older-version).

- **Rebuilt evaluation engine** — canonical command IR, deeply immutable policy snapshots, and an ordered guard pipeline with intrinsic decision tracing behind `explain`.
- **Secret protection** — built-in rules block content access to SSH keys, `.env` files, cloud credentials, and coding-CLI credential stores, across shell commands and file tools alike.
- **Always-on catastrophic protections** — recursive deletion of root or home, Git metadata mutation (`.git` control plane, hooks, worktrees, submodules), and mutation of the user policy file are blocked in every mode, regardless of overrides.
- **Safety presets** — `standard`/`strict`/`paranoid` levels with per-rule overrides, trusted delete allow-paths, and safety-level and capability env vars that can only raise protection — the one deliberate exception is `CC_SAFETY_NET_WORKTREE`, which allows local git discards in linked worktrees.
- **Policy GUI** — `cc-safety-net gui` serves a local, token-authenticated editor with live preset preview.
- **Universal installer** — interactive `install`/`uninstall` across all twelve supported agent CLIs, with an `update` command for installed integrations.
- **Command-decision audit trail** — allowed and blocked command decisions recorded by default to local per-project JSONL with secret redaction, retained for 30 days by default, browsable via `cc-safety-net logs`.
- **Documented threat model** — the [SECURITY.md](SECURITY.md) mode contract, explicit resource limits, and a residual-risk registry of adjudicated bypass families.

## Quick start

**Prerequisite:** Node.js 18 or higher.

Run the interactive selector to install CC Safety Net into one or more installed coding CLIs:

```bash
npx -y cc-safety-net@latest install
```

To update every installed integration:

```bash
npx -y cc-safety-net@latest update
```

The `@latest` qualifier matters: a bare `cc-safety-net` spec can re-run an older
cached copy from the npx cache instead of the current release.

To remove integrations interactively:

```bash
npx -y cc-safety-net uninstall
```

If you use the CLI often, install it globally to get `ccsn`, a shorter alias for the same commands:

```bash
npm install -g cc-safety-net
ccsn doctor
```

## Supported coding CLIs

CC Safety Net works across all coding agent CLIs on **Windows, macOS, and Linux**. Windows is covered by automated tests for the analyzer and a subset of integrations; for the remaining hosts it is best-effort and untested, and Amp's own manual documents macOS, Linux, and WSL rather than native Windows.

<table align="center">
  <tr>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#amp-code-installation"><picture><source media="(prefers-color-scheme: dark)" srcset="./.github/assets/amp-dark.svg"><img alt="Amp Code" src="./.github/assets/amp-light.svg" height="32"></picture><br>Amp Code</a></td>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#antigravity-cli-installation"><img alt="Antigravity CLI" src="./.github/assets/antigravity-cli.png" height="32"><br>Antigravity CLI</a></td>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#claude-code-installation"><img alt="Claude Code" src="./.github/assets/claude-code.svg" height="32"><br>Claude Code</a></td>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#codex-installation"><img alt="Codex" src="./.github/assets/codex.svg" height="32"><br>Codex</a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#cursor-installation"><picture><source media="(prefers-color-scheme: dark)" srcset="./.github/assets/cursor-dark.svg"><img alt="Cursor" src="./.github/assets/cursor-light.svg" height="32"></picture><br>Cursor</a></td>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#gemini-cli-installation"><img alt="Gemini CLI" src="./.github/assets/gemini-cli.svg" height="32"><br>Gemini CLI</a></td>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#github-copilot-cli-installation"><picture><source media="(prefers-color-scheme: dark)" srcset="./.github/assets/copilot-cli-dark.svg"><img alt="GitHub Copilot CLI" src="./.github/assets/copilot-cli-light.svg" height="32"></picture><br>GitHub Copilot CLI</a></td>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#hermes-agent-installation"><img alt="Hermes Agent" src="./.github/assets/hermes.png" height="32"><br>Hermes Agent</a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#kimi-code-installation"><img alt="Kimi Code" src="./.github/assets/kimi-cli.png" height="32"><br>Kimi Code</a></td>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#openclaw-installation"><img alt="OpenClaw" src="./.github/assets/openclaw.png" height="32"><br>OpenClaw</a></td>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#opencode-installation"><picture><source media="(prefers-color-scheme: dark)" srcset="./.github/assets/opencode-dark.svg"><img alt="OpenCode" src="./.github/assets/opencode-light.svg" height="32"></picture><br>OpenCode</a></td>
    <td align="center"><a href="https://ccsafetynet.com/docs/installation#pi-installation"><picture><source media="(prefers-color-scheme: dark)" srcset="./.github/assets/pi-dark.svg"><img alt="Pi" src="./.github/assets/pi-light.svg" height="32"></picture><br>Pi</a></td>
  </tr>
</table>

## What it does

| Capability | What it catches |
|---|---|
| **Semantic command analysis** | `rm -rf` on destructive targets, `git reset --hard`, `git checkout --`, `git push --force`, `git stash clear`, `git clean -f`, unsafe `find -delete`, `dd`/`mkfs`/`shred` — by intent, not string pattern. `git checkout -b feature` (safe) is allowed while `git checkout -- file` (destructive) is blocked. |
| **Shell wrapper detection** | Destructive commands hidden in `bash -c`, `sh -c`, and similar wrappers, recursively analyzed up to 10 levels deep. |
| **Interpreter one-liners** | Destructive code in `python -c`, `node -e`, `ruby -e`, `perl -e` one-liners (e.g. `os.system("rm -rf /")`). |
| **Fail-closed by default** | Malformed hook input and unparseable commands (in strict mode) block rather than allow. Invalid config never blocks: an unverifiable rule source is dropped and an unreadable `policy.json` falls back to protective defaults, both with a warning on every reporting surface. |
| **Secret protection** | Content access to SSH keys, `.env` files, `~/.aws`, kube/docker/gcloud configs, and coding-CLI credential stores — enforced on shell commands and file tools (read/edit/write/search) alike. |
| **Custom rules via rulebooks** | Add your own blocking rules at user or project scope, pinned by SHA-256 digest when fetched from GitHub. |
| **Audit logging** | Allowed and blocked command decisions written to local per-project JSONL with secrets auto-redacted, retained for 30 days by default. Browse them with `npx cc-safety-net logs`, or triage them in the **Activity** view of `npx cc-safety-net gui`. |

Full rule catalogs: [Blocked Commands](https://ccsafetynet.com/docs/reference/blocked-commands) · [Allowed Commands](https://ccsafetynet.com/docs/reference/allowed-commands) · [Secret Protection](https://ccsafetynet.com/docs/reference/secret-protection).

## Why not just use a sandbox?

A workspace-writable sandbox still permits `git reset --hard`, `git push --force`, and `rm -rf .` *inside* the project directory, because the OS only sees writes to an allowed path. Sandboxing contains blast radius; CC Safety Net catches the destructive operations sandboxing permits — use both for defense-in-depth. See [vs Sandboxing](https://ccsafetynet.com/docs/guides/vs-sandboxing).

## Safety presets

Set a session safety preset with `CC_SAFETY_NET_LEVEL=standard|strict|paranoid`:

| Preset | Effect |
|---|---|
| Standard | Blocks recognizable destructive Git and filesystem commands. Allows metadata-only checks of built-in sensitive paths while continuing to block content access. Recommended for normal coding. |
| Strict | Standard, plus blocks dynamic or unparseable commands the analyzer cannot verify safely and metadata-only discovery of built-in sensitive paths. Occasional false positives on advanced shell. |
| Paranoid | Strict, plus blocks `rm -rf` inside your project and interpreter one-liners. Expect friction; for untrusted agents or high-stakes repos. |

Presets supply inherited defaults; `policy.json` stores only your explicit deviations — per-rule overrides, allow paths, deny paths, worktree mode, and audit retention. Safety-level and capability environment variables can only raise protection, never lower it; the one deliberate relaxation is `CC_SAFETY_NET_WORKTREE`, which enables worktree mode to allow local git discards in linked worktrees. The full contract is on [Modes](https://ccsafetynet.com/docs/configuration/modes), [Policy](https://ccsafetynet.com/docs/configuration/policy), and [Environment](https://ccsafetynet.com/docs/configuration/environment), or edit everything visually with the [local GUI](https://ccsafetynet.com/docs/guides/dashboard).

## Diagnostics and tracing

```bash
# Summarize what is being enforced right now
npx cc-safety-net status
# Verify your installation and run a self-test
npx cc-safety-net doctor
# Trace how a command is analyzed step-by-step
npx cc-safety-net explain "git reset --hard"
# Browse recorded denials from the audit trail (add --all to include allowed commands)
npx cc-safety-net logs
# Review what was blocked and edit your policy in a local web GUI
npx cc-safety-net gui
```

`doctor`, `explain`, and `logs` support `--json` for machine-readable output. The audit trail records command decisions only — never command output or prompts — and stays on your machine. Invalid configuration never blocks your agent: unverifiable rule sources are dropped and every degraded state is reported on the next block message, `doctor`, the status line, and the GUI banner.

Details: [CLI Commands](https://ccsafetynet.com/docs/reference/cli-commands) · [Explain Trace](https://ccsafetynet.com/docs/reference/explain-trace) · [Audit Log](https://ccsafetynet.com/docs/reference/audit-log) · [Dashboard](https://ccsafetynet.com/docs/guides/dashboard) · [Configuration Recovery](https://ccsafetynet.com/docs/configuration/recovery).

## Limitations

CC Safety Net denies a tool call before it runs; it does not enforce filesystem permissions, inspect network egress, or contain a process. Two v2 bounds worth knowing up front: the policy and sensitive-path command extractors remain primarily POSIX-oriented, so native PowerShell path expressions such as `Get-Content $HOME\.ssh\id_rsa` can evade static path extraction; and policy-file protection is a best-effort exact-path guard, not command emulation. Use operating-system permissions, a sandbox, or equivalent runtime enforcement when complete protection is required.

One integration-specific bound: Codex's unified exec path, the default on macOS and Linux, sends a hook payload when a command starts a session but none for `write_stdin`. Text the model types into an already-running interactive session is therefore never inspected and never audited — only the command that opened the session is. The host emits no event for that call, so no adapter change can close it.

The full residual-risk registry lives in [SECURITY.md](SECURITY.md); the practical consequences are on [Known Limitations](https://ccsafetynet.com/docs/guides/known-limitations).

## Upgrading from an older version

Upgrade every installed integration to the current release with one command:

```bash
npx -y cc-safety-net@latest update
```

> [!WARNING]
> If you previously defined custom rules in a legacy inline config (`.safety-net.json` or `~/.cc-safety-net/config.json`), those files are **no longer loaded at runtime** and **their rules are not enforcing anything**. Nothing is blocked, so you will not notice this from normal use — the commands those rules used to block now run. Run `npx -y cc-safety-net rule migrate` to convert them to the rulebook layout, then `npx -y cc-safety-net doctor` to confirm the runtime is `ready`. See the [migration guide](https://ccsafetynet.com/docs/configuration/custom-rules#migrate-legacy-configuration).

## Full documentation

All details live on the docs site at **[ccsafetynet.com/docs](https://ccsafetynet.com/docs)**:

| Area | Pages |
|---|---|
| Get started | [Introduction](https://ccsafetynet.com/docs/introduction) · [Installation](https://ccsafetynet.com/docs/installation) · [Quickstart](https://ccsafetynet.com/docs/quickstart) · [How It Works](https://ccsafetynet.com/docs/guides/how-it-works) · [Dashboard](https://ccsafetynet.com/docs/guides/dashboard) |
| Configuration | [Modes](https://ccsafetynet.com/docs/configuration/modes) · [Policy](https://ccsafetynet.com/docs/configuration/policy) · [Environment](https://ccsafetynet.com/docs/configuration/environment) · [Custom Rules](https://ccsafetynet.com/docs/configuration/custom-rules) · [Status Line](https://ccsafetynet.com/docs/configuration/status-line) · [Configuration Recovery](https://ccsafetynet.com/docs/configuration/recovery) |
| Reference | [Blocked Commands](https://ccsafetynet.com/docs/reference/blocked-commands) · [Allowed Commands](https://ccsafetynet.com/docs/reference/allowed-commands) · [Secret Protection](https://ccsafetynet.com/docs/reference/secret-protection) · [Audit Log](https://ccsafetynet.com/docs/reference/audit-log) · [CLI Commands](https://ccsafetynet.com/docs/reference/cli-commands) · [Explain Trace](https://ccsafetynet.com/docs/reference/explain-trace) · [Glossary](https://ccsafetynet.com/docs/reference/glossary) |
| Guides | [Architecture](https://ccsafetynet.com/docs/guides/architecture) · [Analysis Engine](https://ccsafetynet.com/docs/guides/analysis-engine) · [Design Principles](https://ccsafetynet.com/docs/guides/design-principles) · [Security Model](https://ccsafetynet.com/docs/guides/security-model) · [vs Sandboxing](https://ccsafetynet.com/docs/guides/vs-sandboxing) · [Integration Architecture](https://ccsafetynet.com/docs/guides/integration-architecture) · [Known Limitations](https://ccsafetynet.com/docs/guides/known-limitations) · [Troubleshooting](https://ccsafetynet.com/docs/guides/troubleshooting) |
| Project | [Contributing](https://ccsafetynet.com/docs/contributing) · [Security Policy](https://ccsafetynet.com/docs/security) |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to contribute to this project.

The generated distribution is committed: all 11 files under `dist/` are tracked — the library
bundle and its type declarations, the CLI entrypoint, the shared chunks, the vendored Zod copy,
and the Pi, Amp and OpenClaw adapter files. Run `bun run verify:package` and
`bun run verify:repository-plugin` when changing packaging, integrations, or release automation.

## License

MIT
