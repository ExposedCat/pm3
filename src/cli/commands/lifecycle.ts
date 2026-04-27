import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../command.ts";
import { inputError, usageError } from "../errors.ts";
import { requireArgument } from "../utils.ts";

type LifecycleCommandKind = "start" | "stop" | "restart";

type LifecycleCommand = CliCommand<LifecycleCommandKind> & {
  name: string;
  build: boolean;
  detach: boolean;
  noCache: boolean;
};

export const startCommand = createLifecycleCommand({
  kind: "start",
  args: ["up", "-d"],
  supportsBuild: true,
  description: "Start the project",
});

export const stopCommand = createLifecycleCommand({
  kind: "stop",
  args: ["stop"],
  description: "Stop the project",
});

export const restartCommand = createLifecycleCommand({
  kind: "restart",
  args: ["restart"],
  supportsBuild: true,
  description: "Restart the project",
});

type LifecycleCommandConfig = {
  kind: LifecycleCommandKind;
  args: readonly string[];
  supportsBuild?: boolean;
  description: string;
};

function createLifecycleCommand(
  config: LifecycleCommandConfig,
): CommandDefinition<LifecycleCommand> {
  return {
    names: [config.kind],
    args: ["NAME"],
    options: [
      "[-d|--detach]",
      ...(config.supportsBuild ? ["[-b|--build]", "[-c|--no-cache]"] : []),
    ],
    description: config.description,
    parse: (args) => parseLifecycleArgs(config, args),
  };
}

function parseLifecycleArgs(
  config: LifecycleCommandConfig,
  args: string[],
): LifecycleCommand {
  let name: string | undefined;
  let build = false;
  let detach = false;
  let noCache = false;

  for (const arg of args) {
    if (arg === "-d" || arg === "--detach") {
      detach = true;
      continue;
    }

    if (arg === "-b" || arg === "--build") {
      assertLifecycleBuildOption(config, arg);
      build = true;
      continue;
    }

    if (arg === "-c" || arg === "--no-cache") {
      assertLifecycleBuildOption(config, arg);
      build = true;
      noCache = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw usageError(`Unknown option for ${config.kind}: ${arg}`);
    }

    if (name) {
      throw usageError(`Unexpected argument for ${config.kind}: ${arg}`);
    }

    name = arg;
  }

  const parsedName = requireArgument("project name", name);

  return {
    kind: config.kind,
    name: parsedName,
    build,
    detach,
    noCache,
    run: (options) =>
      runLifecycleCommand(
        { name: parsedName, build, detach, noCache },
        config.args,
        options,
      ),
  };
}

function assertLifecycleBuildOption(
  config: LifecycleCommandConfig,
  option: string,
): void {
  if (!config.supportsBuild) {
    throw usageError(`Unknown option for ${config.kind}: ${option}`);
  }
}

type LifecycleRunCommand = Pick<
  LifecycleCommand,
  "build" | "detach" | "name" | "noCache"
>;

async function runLifecycleCommand(
  command: LifecycleRunCommand,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<void> {
  const { getProjectByName } = await import("../../database/projects.ts");
  const { withCliDatabase } = await import("../runtime/database.ts");
  const { runProjectCompose } = await import("../runtime/compose.ts");

  await withCliDatabase(options, async (db) => {
    const project = await getProjectByName(db, command.name);
    if (!project) {
      throw inputError(`Project not found: ${command.name}`);
    }

    if (!command.build) {
      await runProjectCompose(project, args, options, {
        detached: command.detach,
      });
      return;
    }

    await runProjectCompose(
      project,
      ["build", ...(command.noCache ? ["--no-cache"] : [])],
      options,
      { detached: command.detach },
    );
    await runProjectCompose(
      project,
      ["up", "-d", "--force-recreate"],
      options,
      {
        detached: command.detach,
      },
    );
  });
}
