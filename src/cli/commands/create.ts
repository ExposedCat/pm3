import { basename, resolve } from "@std/path";
import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../command.ts";
import { usageError } from "../errors.ts";
import { printProject } from "../output/project.ts";
import { requireArgument, requireOptionValue } from "../utils.ts";

export type CreateCommand = CliCommand<"create"> & {
  workdir: string;
  name?: string;
};

export const createCommand = {
  names: ["create"],
  args: ["WORKDIR"],
  options: ["[--name NAME]"],
  description: "Create a project. NAME defaults to the workdir base name.",
  parse: parseCreateArgs,
} satisfies CommandDefinition<CreateCommand>;

function parseCreateArgs(args: string[]): CreateCommand {
  let workdir: string | undefined;
  let name: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--name") {
      name = requireOptionValue("--name", args[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--name=")) {
      name = requireOptionValue("--name", arg.slice("--name=".length));
      continue;
    }

    if (arg.startsWith("-")) {
      throw usageError(`Unknown option for create: ${arg}`);
    }

    if (workdir) {
      throw usageError(`Unexpected argument for create: ${arg}`);
    }

    workdir = arg;
  }

  const parsedWorkdir = requireArgument("workdir", workdir);

  return {
    kind: "create",
    workdir: parsedWorkdir,
    name,
    run: (options: RunCommandOptions) =>
      runCreateCommand({ workdir: parsedWorkdir, name }, options),
  } satisfies CreateCommand;
}

async function runCreateCommand(
  command: Pick<CreateCommand, "name" | "workdir">,
  options: RunCommandOptions,
): Promise<void> {
  const { addProject } = await import("../../database/projects.ts");
  const { withCliDatabase } = await import("../runtime/database.ts");

  await withCliDatabase(options, async (db) => {
    const workingDir = resolve(command.workdir);
    const name = command.name ?? basename(workingDir);
    const project = await addProject(db, { name, workingDir });
    printProject(project);
  });
}
