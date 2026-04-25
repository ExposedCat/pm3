import { createCommand } from "./commands/create.ts";
import { helpCommand } from "./commands/help.ts";
import { listCommand } from "./commands/list.ts";
import { viewCommand } from "./commands/view.ts";
import { usageError } from "./errors.ts";
import { formatHelpText } from "./help.ts";
import type { RunCommandOptions } from "./command.ts";

export const commandDefinitions = [
  createCommand,
  listCommand,
  viewCommand,
  helpCommand,
] as const;

export type Command = ReturnType<(typeof commandDefinitions)[number]["parse"]>;
export type { RunCommandOptions };

export function parseArgs(args: string[]): Command {
  const [commandName, ...rest] = args;

  if (!commandName) {
    return helpCommand.parse([]);
  }

  const definition = commandDefinitions.find((command) =>
    command.names.includes(commandName)
  );
  if (!definition) {
    throw usageError(`Unknown command: ${commandName}`);
  }

  return definition.parse(rest);
}

export async function runCommand(
  command: Command,
  options: RunCommandOptions = {},
): Promise<void> {
  if (command.kind === "help") {
    console.log(formatHelpText(commandDefinitions).trimEnd());
    return;
  }

  await command.run(options);
}
