import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ENV_FLAGS,
  envTruthy,
  getCCSafetyNetEnvModes,
  loadPolicySnapshot,
  resolveEffectiveDestructiveCommandRules,
} from '@/engine/facade';
import { readBoundedHookInput } from '@/integrations/hook/common';

/**
 * Read piped stdin content asynchronously, bounded by the hook input limit.
 * Returns null if stdin is a TTY (no piped input), empty, unreadable, or over the limit.
 */
type StatuslineInput = Parameters<typeof readBoundedHookInput>[0] & { isTTY?: boolean };

async function readStdinAsync(input: StatuslineInput): Promise<string | null> {
  if (input.isTTY) {
    return null;
  }

  // A statusline is decoration: oversized or unreadable input drops the prefix instead of
  // denying, unlike the fail-closed hook path that shares this reader.
  const content = await readBoundedHookInput(input).catch(() => null);
  return content?.trim() || null;
}

function getSettingsPath(): string {
  // Allow override for testing
  if (process.env.CLAUDE_SETTINGS_PATH) {
    return process.env.CLAUDE_SETTINGS_PATH;
  }
  return join(homedir(), '.claude', 'settings.json');
}

interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
}

/**
 * Whether the plugin is enabled in Claude Code. Nothing is enforced while it is
 * off, however valid the configuration is.
 */
export function isPluginEnabled(): boolean {
  const settingsPath = getSettingsPath();

  if (!existsSync(settingsPath)) {
    // Default to disabled if settings file doesn't exist
    return false;
  }

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as ClaudeSettings;

    // If enabledPlugins doesn't exist or plugin not listed, default to disabled
    if (!settings.enabledPlugins) {
      return false;
    }

    const pluginKey = 'cc-safety-net@cc-marketplace';
    // If not explicitly set, default to disabled
    if (!(pluginKey in settings.enabledPlugins)) {
      return false;
    }

    return settings.enabledPlugins[pluginKey] === true;
  } catch (error) {
    if (envTruthy(ENV_FLAGS.debug)) {
      console.error(
        `CC Safety Net debug: failed to read Claude settings: ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // On any error (invalid JSON, etc.), default to disabled
    return false;
  }
}

export async function printStatusline(input: StatuslineInput = process.stdin): Promise<void> {
  const enabled = isPluginEnabled();

  // Build our status string
  let status: string;

  if (!enabled) {
    status = '🛡️ CC Safety Net ❌';
  } else {
    const snapshot = loadPolicySnapshot({ cwd: process.cwd() });
    const policy = snapshot.policy;
    const modes = getCCSafetyNetEnvModes(policy);
    const hasEffectiveRuleCustomization = Object.values(
      resolveEffectiveDestructiveCommandRules(policy, modes.capabilities),
    ).some((rule) => rule.changesInherited);
    const levelEmoji = {
      standard: '✅',
      strict: '🔒',
      paranoid: '👁️',
      custom: '🔧',
    }[hasEffectiveRuleCustomization ? 'custom' : modes.effectiveLevel];

    status = `🛡️ CC Safety Net ${levelEmoji}${modes.worktreeMode ? '🌳' : ''}${snapshot.state === 'degraded' ? '⚠️' : ''}`;
  }

  // Check for piped stdin input and prepend with separator
  // Skip JSON input (Claude Code pipes status JSON that shouldn't be echoed)
  const stdinInput = await readStdinAsync(input);
  if (stdinInput && !stdinInput.startsWith('{')) {
    console.log(`${stdinInput} | ${status}`);
  } else {
    console.log(status);
  }
}
