import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { withTargetProjectList } from "../commands.ts";
import { usageError } from "../errors.ts";

export type EnableCommand = CliCommand<"enable"> & {
  name: string | undefined;
  now: boolean;
};

export const enableCommand = {
  names: ["enable"],
  args: ["[NAME]"],
  options: ["[-n|--now]"],
  description: "Enable project startup",
  parse: parseEnableArgs,
} satisfies CommandDefinition<EnableCommand>;

function parseEnableArgs(args: string[]): EnableCommand {
  let name: string | undefined;
  let now = false;

  for (const arg of args) {
    if (arg === "-n" || arg === "--now") {
      now = true;
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
    name,
    now,
    run: (options) => runEnableCommand({ name, now }, options),
  };
}

async function runEnableCommand(
  command: Pick<EnableCommand, "name" | "now">,
  options: RunCommandOptions,
): Promise<void> {
  const { enableProject } = await import("../../database/projects.ts");
  const { startProject } = await import("../../runtime/project.ts");

  await withTargetProjectList(options, command.name, async (db, projects) => {
    for (const project of projects) {
      await enableProject(db, project.id);
      console.log(`Enabled ${project.name}`);

      if (command.now) {
        await startProject(project, options);
      }
    }
  });
}
