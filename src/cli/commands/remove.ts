import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../command.ts";
import { inputError, usageError } from "../errors.ts";
import { requireArgument } from "../utils.ts";

export type RemoveCommand = CliCommand<"remove"> & {
  name: string;
  detach: boolean;
  force: boolean;
};

export const removeCommand = {
  names: ["rm", "remove"],
  args: ["NAME"],
  options: ["[-d|--detach]", "[-f|--force]"],
  description: "Remove the project and its Podman artifacts",
  parse: parseRemoveArgs,
} satisfies CommandDefinition<RemoveCommand>;

function parseRemoveArgs(args: string[]): RemoveCommand {
  let name: string | undefined;
  let detach = false;
  let force = false;

  for (const arg of args) {
    if (arg === "-d" || arg === "--detach") {
      detach = true;
      continue;
    }

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
    detach,
    force,
    run: (options) =>
      runRemoveCommand({ name: parsedName, detach, force }, options),
  };
}

type RemoveRunCommand = Pick<RemoveCommand, "detach" | "force" | "name">;

async function runRemoveCommand(
  command: RemoveRunCommand,
  options: RunCommandOptions,
): Promise<void> {
  const { deleteProject, getProjectByName } = await import(
    "../../database/projects.ts"
  );
  const { withCliDatabase } = await import("../runtime/database.ts");
  const { listProjectComposeContainers, removeProjectComposeArtifacts } =
    await import("../runtime/compose.ts");

  await withCliDatabase(options, async (db) => {
    const project = await getProjectByName(db, command.name);
    if (!project) {
      throw inputError(`Failed to remove project: "${command.name}" not found`);
    }

    const containers = await listProjectComposeContainers(project, options);
    if (!command.force && hasRunningContainer(containers)) {
      throw inputError(
        `Failed to remove project: "${command.name}" is running`,
      );
    }

    await removeProjectComposeArtifacts(project, options, {
      detached: command.detach,
    });
    await deleteProject(db, project.id);
  });
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
