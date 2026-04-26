import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../command.ts";
import { inputError } from "../errors.ts";
import { printProject } from "../output/project.ts";
import { requireArgument, requireNoExtraArgs } from "../utils.ts";

export type ViewCommand = CliCommand<"view"> & {
  name: string;
};

export const viewCommand = {
  names: ["view"],
  args: ["NAME"],
  options: [],
  description: "Show the project",
  parse: parseViewArgs,
} satisfies CommandDefinition<ViewCommand>;

function parseViewArgs(args: string[]): ViewCommand {
  const [nameArg, ...extra] = args;
  const name = requireArgument("project name", nameArg);
  requireNoExtraArgs("view", extra);

  return {
    kind: "view",
    name,
    run: (options) => runViewCommand(name, options),
  };
}

async function runViewCommand(
  name: string,
  options: RunCommandOptions,
): Promise<void> {
  const { getProjectByName } = await import("../../database/projects.ts");
  const { withCliDatabase } = await import("../runtime/database.ts");

  await withCliDatabase(options, async (db) => {
    const project = await getProjectByName(db, name);
    if (!project) {
      throw inputError(`Project not found: ${name}`);
    }

    printProject(project);
  });
}
