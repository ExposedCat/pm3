import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { withTargetProjectList } from "../commands.ts";
import { usageError } from "../errors.ts";
import { requireArgument, requireNoExtraArgs } from "../utils.ts";

type GitMode = "off" | "on";

export type GitCommand = CliCommand<"git"> & {
  mode: GitMode;
  name: string | undefined;
};

export const gitCommand = {
  names: ["git"],
  args: ["ON|Y|YES|ENABLE|OFF|N|NO|DISABLE", "[NAME]"],
  description: "Enable or disable Git pulls",
  parse: parseGitArgs,
} satisfies CommandDefinition<GitCommand>;

function parseGitArgs(args: string[]): GitCommand {
  const [modeArg, name, ...extra] = args;
  requireNoExtraArgs("git", extra);
  const mode = parseGitMode(requireArgument("git mode", modeArg));

  return {
    kind: "git",
    mode,
    name,
    run: (options) => runGitCommand({ mode, name }, options),
  };
}

function parseGitMode(value: string): GitMode {
  switch (value.toLowerCase()) {
    case "on":
    case "y":
    case "yes":
    case "enable":
      return "on";
    case "off":
    case "n":
    case "no":
    case "disable":
      return "off";
    default:
      throw usageError(`Invalid git mode: ${value}`);
  }
}

async function runGitCommand(
  command: Pick<GitCommand, "mode" | "name">,
  options: RunCommandOptions,
): Promise<void> {
  const { setProjectGit } = await import("../../database/projects.ts");

  await withTargetProjectList(
    options,
    "git",
    command.name,
    async (db, projects) => {
      if (command.mode === "on") {
        const { requireProjectGitRepository } = await import(
          "../../runtime/git.ts"
        );
        for (const project of projects) {
          await requireProjectGitRepository(project, options);
        }
      }

      for (const project of projects) {
        await setProjectGit(db, project.id, command.mode === "on");
        console.log(
          `Git pulling ${command.mode === "on" ? "enabled" : "disabled"} for ${project.name}`,
        );
      }
    },
  );
}
