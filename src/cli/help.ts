import type { CommandDefinition } from "./command.ts";

export function formatHelpText(commands: readonly CommandDefinition[]): string {
  const usageLines = commands.map(
    (command) => `  pm3 ${formatCommandUsage(command)}`,
  );
  const commandNameLength = Math.max(
    ...commands.map((command) => command.names[0].length),
  );
  const commandLines = commands.map(
    (command) =>
      `  ${command.names[0].padEnd(commandNameLength)}  ${command.description}`,
  );

  return [
    "pm3",
    "",
    "Usage:",
    ...usageLines,
    "",
    "Commands:",
    ...commandLines,
    "",
  ].join("\n");
}

function formatCommandUsage(command: CommandDefinition): string {
  return [command.names[0], ...command.args, ...(command.options ?? [])].join(
    " ",
  );
}
