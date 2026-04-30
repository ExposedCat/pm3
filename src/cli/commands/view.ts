import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { withNamedProject } from "../commands.ts";
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
  await withNamedProject(options, name, async (_db, project) => {
    printProject(project);
  });
}
