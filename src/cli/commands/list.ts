import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../command.ts";
import { requireNoExtraArgs } from "../utils.ts";

export type ListCommand = CliCommand<"list">;

export const listCommand = {
  names: ["list"],
  args: [],
  options: [],
  description: "List projects.",
  parse: parseListArgs,
} satisfies CommandDefinition<ListCommand>;

function parseListArgs(args: string[]): ListCommand {
  requireNoExtraArgs("list", args);

  return {
    kind: "list",
    run: runListCommand,
  };
}

async function runListCommand(options: RunCommandOptions): Promise<void> {
  const { listProjects } = await import("../../database/projects.ts");
  const { withCliDatabase } = await import("../runtime/database.ts");

  await withCliDatabase(options, async (db) => {
    const projects = await listProjects(db);
    for (const project of projects) {
      console.log(`${project.name}\t${project.id}`);
    }
  });
}
