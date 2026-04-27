import { createCommand } from "./commands/create.ts";
import { daemonCommand } from "./commands/daemon.ts";
import { disableCommand } from "./commands/disable.ts";
import { enableCommand } from "./commands/enable.ts";
import { helpCommand } from "./commands/help.ts";
import {
  restartCommand,
  startCommand,
  stopCommand,
} from "./commands/lifecycle.ts";
import { listCommand } from "./commands/list.ts";
import { removeCommand } from "./commands/remove.ts";
import { viewCommand } from "./commands/view.ts";
import { usageError } from "./errors.ts";
import { formatHelpText } from "./help.ts";
import type { RunLineStream, RunProcess } from "./runtime/process.ts";

export const commandDefinitions = [
  createCommand,
  enableCommand,
  disableCommand,
  startCommand,
  stopCommand,
  restartCommand,
  listCommand,
  viewCommand,
  removeCommand,
  daemonCommand,
  helpCommand,
] as const;

export type Command = ReturnType<(typeof commandDefinitions)[number]["parse"]>;

export type RunCommandOptions = {
  databasePath?: string;
  runLineStream?: RunLineStream;
  runProcess?: RunProcess;
  verbose?: boolean;
};

export type CliCommand<TKind extends string = string> = {
  kind: TKind;
  run(options: RunCommandOptions): Promise<void>;
};

export type CommandDefinition<TCommand extends CliCommand = CliCommand> = {
  names: readonly [string, ...string[]];
  args: readonly string[];
  options?: readonly string[];
  description: string;
  parse(args: string[]): TCommand;
};

export type ParsedCommand = {
  command: Command;
  verbose: boolean;
};

export function parseArgs(args: string[]): ParsedCommand {
  const { commandArgs, verbose } = parseGlobalOptions(args);
  const [commandName, ...rest] = commandArgs;

  if (!commandName) {
    return { command: helpCommand.parse([]), verbose };
  }

  const definition = commandDefinitions.find((command) =>
    command.names.includes(commandName),
  );
  if (!definition) {
    throw usageError(`Unknown command: ${commandName}`);
  }

  return { command: definition.parse(rest), verbose };
}

export async function runCommand(
  parsedCommand: ParsedCommand,
  options: RunCommandOptions = {},
): Promise<void> {
  const { command, verbose } = parsedCommand;
  if (command.kind === "help") {
    console.log(formatHelpText(commandDefinitions).trimEnd());
    return;
  }

  await command.run({ ...options, verbose: options.verbose ?? verbose });
}

type GlobalOptionsResult = {
  commandArgs: string[];
  verbose: boolean;
};

function parseGlobalOptions(args: readonly string[]): GlobalOptionsResult {
  const commandArgs: string[] = [];
  let verbose = false;

  for (const arg of args) {
    if (arg === "-v" || arg === "--verbose") {
      verbose = true;
      continue;
    }

    commandArgs.push(arg);
  }

  return { commandArgs, verbose };
}
