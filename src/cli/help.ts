import type { CommandDefinition } from "./command.ts";

export function formatHelpText(commands: readonly CommandDefinition[]): string {
  const commandUsageLength = Math.max(
    ...commands.map((command) => formatCommandUsage(command).length),
  );
  const usageLines = commands.map(
    (command) =>
      `  pm3 ${formatCommandUsage(command).padEnd(
        commandUsageLength,
      )}  ${command.description}`,
  );

  return ["pm3 = pm2 + podman", "", "Usage:", ...usageLines, ""].join("\n");
}

function formatCommandUsage(command: CommandDefinition): string {
  return [
    command.names[0],
    ...command.args,
    "[-v|--verbose]",
    ...(command.options ?? []),
  ].join(" ");
}
