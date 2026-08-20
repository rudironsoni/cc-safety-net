#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

function run(command: string[]) {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode === 0) return;
  throw new Error(`${command.join(' ')} failed\n${result.stdout}${result.stderr}`);
}

export function verifyRepositoryPlugin(): void {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8')) as {
    version: string;
  };
  if (pkg.version !== plugin.version) throw new Error('Package and plugin versions disagree');
  const hooks = JSON.parse(readFileSync('hooks/hooks.json', 'utf8')) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
  };
  const command = hooks.hooks.PreToolUse[0]?.hooks[0]?.command;
  if (command !== 'node "${CLAUDE_PLUGIN_ROOT}/dist/bin/cc-safety-net.js" hook --coding-cli') {
    throw new Error('Claude plugin hook target drifted');
  }
  run(['node', '--check', 'dist/bin/cc-safety-net.js']);
  run(['git', 'ls-files', '--error-unmatch', 'assets/cc-safety-net.schema.json']);
  run(['git', 'ls-files', '--error-unmatch', '.claude-plugin/plugin.json']);
  run(['git', 'ls-files', '--error-unmatch', 'hooks/hooks.json']);
  console.log(`Verified repository plugin v${pkg.version}`);
}

if (import.meta.main) verifyRepositoryPlugin();
