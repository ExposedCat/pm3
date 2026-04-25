import type { CliCommand, CommandDefinition } from "../command.ts";
import { requireNoExtraArgs } from "../utils.ts";

export type HelpCommand = CliCommand<"help">;

export const helpCommand = {
  names: ["help", "--help", "-h"],
  args: [],
  options: [],
  description: "Show this help.",
  parse: parseHelpArgs,
} satisfies CommandDefinition<HelpCommand>;

function parseHelpArgs(args: string[]): HelpCommand {
  requireNoExtraArgs("help", args);

  return {
    kind: "help",
    run: () => Promise.resolve(),
  };
}
