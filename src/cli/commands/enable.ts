import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { withTargetProjectList } from "../commands.ts";
import { usageError } from "../errors.ts";

export type EnableCommand = CliCommand<"enable"> & {
  git?: boolean;
  name: string | undefined;
  now: boolean;
};

export const enableCommand = {
  names: ["enable"],
  args: ["[NAME]"],
  options: ["[-n|--now]", "[-g|--git]", "[-l|--local]"],
  description: "Enable project startup",
  parse: parseEnableArgs,
} satisfies CommandDefinition<EnableCommand>;

function parseEnableArgs(args: string[]): EnableCommand {
  let git: boolean | undefined;
  let name: string | undefined;
  let now = false;

  for (const arg of args) {
    if (arg === "-n" || arg === "--now") {
      now = true;
      continue;
    }

    if (arg === "-g" || arg === "--git") {
      git = updateGitOption("enable", git, true);
      continue;
    }

    if (arg === "-l" || arg === "--local") {
      git = updateGitOption("enable", git, false);
      continue;
    }

    if (arg.startsWith("-")) {
      throw usageError(`Unknown option for enable: ${arg}`);
    }

    if (name) {
      throw usageError(`Unexpected argument for enable: ${arg}`);
    }

    name = arg;
  }

  return {
    kind: "enable",
    git,
    name,
    now,
    run: (options) => runEnableCommand({ git, name, now }, options),
  };
}

async function runEnableCommand(
  command: Pick<EnableCommand, "git" | "name" | "now">,
  options: RunCommandOptions,
): Promise<void> {
  const { enableProject, setProjectGit } = await import(
    "../../database/projects.ts"
  );
  const { startProject } = await import("../../runtime/project.ts");

  await withTargetProjectList(options, command.name, async (db, projects) => {
    if (command.git) {
      const { requireProjectGitRepository } = await import(
        "../../runtime/git.ts"
      );
      for (const project of projects) {
        await requireProjectGitRepository(project, options);
      }
    }

    for (const project of projects) {
      await enableProject(db, project.id);
      if (command.git !== undefined) {
        await setProjectGit(db, project.id, command.git);
      }
      console.log(`Enabled ${project.name}`);

      if (command.now) {
        await startProject(project, options, { git: command.git });
      }
    }
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
