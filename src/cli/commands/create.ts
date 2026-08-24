import { basename, resolve } from "@std/path";
import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { usageError } from "../errors.ts";
import { requireArgument, requireOptionValue } from "../utils.ts";

export type CreateCommand = CliCommand<"create"> & {
  composeArgs: string[];
  git?: boolean;
  workdir: string;
  name?: string;
};

export const createCommand = {
  names: ["create"],
  args: ["WORKDIR"],
  options: [
    "[--name NAME]",
    "[-g|--git]",
    "[-l|--local]",
    "[-- PODMAN-COMPOSE-ARGS...]",
  ],
  description: "Register project; pass podman-compose arguments after --",
  parse: parseCreateArgs,
} satisfies CommandDefinition<CreateCommand>;

function parseCreateArgs(args: string[]): CreateCommand {
  let composeArgs: string[] = [];
  let git: boolean | undefined;
  let workdir: string | undefined;
  let name: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      composeArgs = args.slice(index + 1);
      break;
    }

    if (arg === "--name") {
      name = requireOptionValue("--name", args[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--name=")) {
      name = requireOptionValue("--name", arg.slice("--name=".length));
      continue;
    }

    if (arg === "-g" || arg === "--git") {
      git = updateGitOption("create", git, true);
      continue;
    }

    if (arg === "-l" || arg === "--local") {
      git = updateGitOption("create", git, false);
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
    composeArgs,
    git,
    workdir: parsedWorkdir,
    name,
    run: (options: RunCommandOptions) =>
      runCreateCommand(
        { composeArgs, git, workdir: parsedWorkdir, name },
        options,
      ),
  } satisfies CreateCommand;
}

async function runCreateCommand(
  command: Pick<CreateCommand, "composeArgs" | "git" | "name" | "workdir">,
  options: RunCommandOptions,
): Promise<void> {
  const { addProject } = await import("../../database/projects.ts");
  const { withCliDatabase } = await import("../runtime/database.ts");

  await withCliDatabase(options, async (db) => {
    const workingDir = resolve(command.workdir);
    const name = command.name ?? basename(workingDir);
    if (command.git) {
      const { requireProjectGitRepository } = await import(
        "../../runtime/git.ts"
      );
      await requireProjectGitRepository({ name, workingDir }, options);
    }

    await addProject(db, {
      name,
      workingDir,
      composeArgs: command.composeArgs,
      git: command.git,
    });
    console.log(
      `Created ${name} with compose arguments \`${command.composeArgs.join(" ")}\``,
    );
    console.log(`Start with \`pm3 start ${name}\``);
  });
}

function updateGitOption(
  command: string,
  current: boolean | undefined,
  next: boolean,
): boolean {
  if (current !== undefined && current !== next) {
    throw usageError(`Cannot use --git with --local for ${command}`);
  }

  return next;
}
