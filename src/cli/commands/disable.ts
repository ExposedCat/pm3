import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { withTargetProjects } from "../commands.ts";
import { usageError } from "../errors.ts";

export type DisableCommand = CliCommand<"disable"> & {
  name: string | undefined;
  now: boolean;
};

export const disableCommand = {
  names: ["disable"],
  args: ["[NAME]"],
  options: ["[-n|--now]"],
  description: "Disable project startup",
  parse: parseDisableArgs,
} satisfies CommandDefinition<DisableCommand>;

function parseDisableArgs(args: string[]): DisableCommand {
  let name: string | undefined;
  let now = false;

  for (const arg of args) {
    if (arg === "-n" || arg === "--now") {
      now = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw usageError(`Unknown option for disable: ${arg}`);
    }

    if (name) {
      throw usageError(`Unexpected argument for disable: ${arg}`);
    }

    name = arg;
  }

  return {
    kind: "disable",
    name,
    now,
    run: (options) => runDisableCommand({ name, now }, options),
  };
}

async function runDisableCommand(
  command: Pick<DisableCommand, "name" | "now">,
  options: RunCommandOptions,
): Promise<void> {
  const { disableProject } = await import("../../database/projects.ts");
  const { stopProject } = await import("../../runtime/project.ts");

  await withTargetProjects(options, command.name, async (db, project) => {
    await disableProject(db, project.id);
    console.log(`Disabled ${project.name}`);

    if (command.now) {
      await stopProject(project, options);
    }
  });
}
