import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { withNamedProject } from "../commands.ts";
import { inputError, usageError } from "../errors.ts";
import { requireArgument } from "../utils.ts";

export type RemoveCommand = CliCommand<"remove"> & {
  name: string;
  force: boolean;
};

export const removeCommand = {
  names: ["rm", "remove"],
  args: ["NAME"],
  options: ["[-f|--force]"],
  description: "Remove the project and its Podman artifacts",
  parse: parseRemoveArgs,
} satisfies CommandDefinition<RemoveCommand>;

function parseRemoveArgs(args: string[]): RemoveCommand {
  let name: string | undefined;
  let force = false;

  for (const arg of args) {
    if (arg === "-f" || arg === "--force") {
      force = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw usageError(`Unknown option for remove: ${arg}`);
    }

    if (name) {
      throw usageError(`Unexpected argument for remove: ${arg}`);
    }

    name = arg;
  }

  const parsedName = requireArgument("project name", name);

  return {
    kind: "remove",
    name: parsedName,
    force,
    run: (options) => runRemoveCommand({ name: parsedName, force }, options),
  };
}

type RemoveRunCommand = Pick<RemoveCommand, "force" | "name">;

async function runRemoveCommand(
  command: RemoveRunCommand,
  options: RunCommandOptions,
): Promise<void> {
  const { deleteProject } = await import("../../database/projects.ts");
  const { listProjectContainers, removeProjectArtifacts } = await import(
    "../../runtime/project.ts"
  );

  await withNamedProject(
    options,
    command.name,
    async (db, project) => {
      const containers = await listProjectContainers(project, options);
      if (!command.force && hasRunningContainer(containers)) {
        throw inputError(
          `Failed to remove project: "${command.name}" is running`,
        );
      }

      await removeProjectArtifacts(project, options);
      await deleteProject(db, project.id);
    },
    (name) => `Failed to remove project: "${name}" not found`,
  );
}

type ProjectStateContainer = {
  state: string;
};

function hasRunningContainer(
  containers: readonly ProjectStateContainer[],
): boolean {
  return containers.some(
    (container) => container.state.toLocaleLowerCase() === "running",
  );
}
