import { basename, resolve } from "@std/path";
import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { inputError, usageError } from "../errors.ts";
import { requireArgument, requireOptionValue } from "../utils.ts";

export type CreateCommand = CliCommand<"create"> & {
  composeFile?: string;
  git?: boolean;
  workdir: string;
  name?: string;
};

export const createCommand = {
  names: ["create"],
  args: ["WORKDIR"],
  options: [
    "[--name NAME]",
    "[-c|--compose COMPOSE]",
    "[-g|--git]",
    "[-l|--local]",
  ],
  description: "Register project",
  parse: parseCreateArgs,
} satisfies CommandDefinition<CreateCommand>;

function parseCreateArgs(args: string[]): CreateCommand {
  let composeFile: string | undefined;
  let git: boolean | undefined;
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

    if (arg === "-c" || arg === "--compose") {
      composeFile = requireOptionValue(arg, args[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--compose=")) {
      composeFile = requireOptionValue(
        "--compose",
        arg.slice("--compose=".length),
      );
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
    composeFile,
    git,
    workdir: parsedWorkdir,
    name,
    run: (options: RunCommandOptions) =>
      runCreateCommand(
        { composeFile, git, workdir: parsedWorkdir, name },
        options,
      ),
  } satisfies CreateCommand;
}

async function runCreateCommand(
  command: Pick<CreateCommand, "composeFile" | "git" | "name" | "workdir">,
  options: RunCommandOptions,
): Promise<void> {
  const { addProject } = await import("../../database/projects.ts");
  const { withCliDatabase } = await import("../runtime/database.ts");

  await withCliDatabase(options, async (db) => {
    const workingDir = resolve(command.workdir);
    const composeFile = await resolveCreateComposeFile(command.composeFile);
    const name = command.name ?? basename(workingDir);
    if (command.git) {
      const { requireProjectGitRepository } = await import(
        "../../runtime/git.ts"
      );
      await requireProjectGitRepository({ name, workingDir }, options);
    }

    await addProject(db, { name, workingDir, composeFile, git: command.git });
    console.log(`Created ${name} at ${workingDir}`);
    if (composeFile) {
      console.log(`Compose file: ${composeFile}`);
    }
    console.log(`Start with \`pm3 start ${name}\``);
  });
}

async function resolveCreateComposeFile(
  path: string | undefined,
): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }

  const composeFile = resolve(path);

  try {
    const stat = await Deno.stat(composeFile);
    if (!stat.isFile) {
      throw inputError(`Compose path is not a file: ${composeFile}`);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw inputError(`Compose file not found: ${composeFile}`);
    }

    throw error;
  }

  return composeFile;
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
