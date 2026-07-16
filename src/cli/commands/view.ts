import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { withTargetProjects } from "../commands.ts";
import { printProject } from "../output/project.ts";
import { requireNoExtraArgs } from "../utils.ts";

export type ViewCommand = CliCommand<"view"> & {
  name: string | undefined;
};

export const viewCommand = {
  names: ["view"],
  args: ["[NAME]"],
  options: [],
  description: "Show the project",
  parse: parseViewArgs,
} satisfies CommandDefinition<ViewCommand>;

function parseViewArgs(args: string[]): ViewCommand {
  const [nameArg, ...extra] = args;
  requireNoExtraArgs("view", extra);

  return {
    kind: "view",
    name: nameArg,
    run: (options) => runViewCommand(nameArg, options),
  };
}

async function runViewCommand(
  name: string | undefined,
  options: RunCommandOptions,
): Promise<void> {
  let firstProject = true;
  await withTargetProjects(options, name, async (_db, project) => {
    if (!firstProject) {
      console.log("");
    }
    firstProject = false;

    printProject(project);
  });
}
