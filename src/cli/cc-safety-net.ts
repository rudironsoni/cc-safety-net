#!/usr/bin/env node
import { parseCommandArgs, reportCommandArgErrors } from '@/cli/args';
import { runLogsCommand } from '@/cli/audit-log';
import { type CommandName, findCommand } from '@/cli/commands';
import { parseDoctorFlags, runDoctor } from '@/cli/doctor/index';
import { runExplain } from '@/cli/explain/run';
import { printHelp, printVersion, showCommandHelp } from '@/cli/help';
import {
  findHookIntegrationByFlag,
  findLegacyTopLevelHookIntegration,
} from '@/cli/hook-integrations';
import { runInstallCommand, runUpdateCommand } from '@/cli/install';
import { runRuleCommand } from '@/cli/rule';
import { printStatus } from '@/cli/status';
import { printStatusline } from '@/cli/statusline';
import { runGuiCommand } from '@/gui';

/**
 * Handle "help <command>" pattern.
 * Returns true if handled (printed help or error), false if not the help command.
 */
function handleHelpCommand(args: readonly string[]): boolean {
  if (args[0] !== 'help') {
    return false;
  }

  const commandName = args[1];
  if (!commandName) {
    // Just "help" with no argument - show main help
    printHelp();
    process.exit(0);
  }

  if (showCommandHelp(commandName)) {
    process.exit(0);
  }

  console.error(`Unknown command: ${commandName}`);
  console.error("Run 'cc-safety-net --help' for available commands.");
  process.exit(1);
}

const commandHandlers = {
  hook: async (args) => {
    const integration = findHookIntegrationByFlag(args);
    if (integration) {
      await integration.run();
      return;
    }
    console.error(
      'hook requires exactly one integration flag. Try: cc-safety-net hook --kimi-code',
    );
    showCommandHelp('hook', console.error);
    process.exit(1);
  },
  install: async (args) => {
    process.exit(await runInstallCommand('install', args));
  },
  update: async (args) => {
    process.exit(await runUpdateCommand(args));
  },
  uninstall: async (args) => {
    process.exit(await runInstallCommand('uninstall', args));
  },
  rule: async (args) => {
    process.exit(await runRuleCommand(args));
  },
  status: async (args) => {
    if (reportCommandArgErrors(parseCommandArgs({ label: 'status' }, args).errors)) {
      process.exit(1);
    }
    printStatus();
  },
  statusline: async (args) => {
    const parsed = parseCommandArgs(
      { label: 'statusline', booleans: { claudeCode: ['-cc', '--claude-code'] } },
      args,
    );
    if (parsed.errors.length === 0 && parsed.flags.claudeCode) {
      await printStatusline();
      return;
    }
    reportCommandArgErrors(parsed.errors);
    if (!parsed.flags.claudeCode) console.error('statusline requires --claude-code (-cc)');
    showCommandHelp('statusline', console.error);
    process.exit(1);
  },
  doctor: async (args) => {
    const flags = parseDoctorFlags(args);
    if (!flags) process.exit(1);
    const exitCode = await runDoctor({
      json: flags.json,
      skipUpdateCheck: flags.skipUpdateCheck,
    });
    process.exit(exitCode);
  },
  logs: async (args) => {
    process.exit(await runLogsCommand(args));
  },
  gui: async (args) => {
    process.exit(await runGuiCommand(args));
  },
  explain: async (args) => {
    process.exit(await runExplain(args));
  },
} satisfies Record<CommandName, (args: string[]) => Promise<void>>;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // The global scan answers one question — was --help or --version given as an
  // option? Everything after the first `--` is command input, so the scan stops
  // there, and unknown tokens belong to whichever command is dispatched below.
  const globalScan = parseCommandArgs(
    { label: 'cc-safety-net', booleans: { version: ['-V', '--version'] }, positionals: 'list' },
    args,
  );

  if (handleHelpCommand(args)) return;

  const commandName = args[0];
  const command = commandName ? findCommand(commandName) : undefined;
  // A known command name keeps its own help; `rule` is the one command that parses
  // `--help` itself, so the request reaches the leaf handler for its subcommand.
  if (globalScan.help && command && command.name !== 'rule') {
    showCommandHelp(command.name);
    process.exit(0);
  }
  if (!commandName || (globalScan.help && !command)) {
    printHelp();
    process.exit(0);
  }
  if (globalScan.flags.version) {
    printVersion();
    process.exit(0);
  }

  if (command) {
    await commandHandlers[command.name](args.slice(1));
    return;
  }

  const legacyIntegration = findLegacyTopLevelHookIntegration(commandName);
  if (legacyIntegration) {
    await legacyIntegration.run();
    return;
  }
  if (commandName === '--statusline') {
    await printStatusline();
    return;
  }

  console.error(
    commandName.startsWith('-')
      ? `Unknown option: ${commandName}`
      : `Unknown command: ${commandName}`,
  );
  console.error("Run 'cc-safety-net --help' for usage.");
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error('CC Safety Net error:', error);
  process.exit(1);
});
