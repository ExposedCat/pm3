import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../command.ts";
import { inputError } from "../errors.ts";
import { requireArgument, requireNoExtraArgs } from "../utils.ts";

type LifecycleCommandKind = "start" | "stop" | "restart";

type LifecycleCommand = CliCommand<LifecycleCommandKind> & {
  name: string;
};

export const startCommand = createLifecycleCommand({
  kind: "start",
  args: ["up", "-d"],
  description: "Start one project.",
});

export const stopCommand = createLifecycleCommand({
  kind: "stop",
  args: ["stop"],
  description: "Stop one project.",
});

export const restartCommand = createLifecycleCommand({
  kind: "restart",
  args: ["restart"],
  description: "Restart one project.",
});

type LifecycleCommandConfig = {
  kind: LifecycleCommandKind;
  args: readonly string[];
  description: string;
};

function createLifecycleCommand(
  config: LifecycleCommandConfig,
): CommandDefinition<LifecycleCommand> {
  return {
    names: [config.kind],
    args: ["NAME"],
    options: [],
    description: config.description,
    parse: (args) => parseLifecycleArgs(config, args),
  };
}

function parseLifecycleArgs(
  config: LifecycleCommandConfig,
  args: string[],
): LifecycleCommand {
  const [nameArg, ...extra] = args;
  const name = requireArgument("project name", nameArg);
  requireNoExtraArgs(config.kind, extra);

  return {
    kind: config.kind,
    name,
    run: (options) => runLifecycleCommand(name, config.args, options),
  };
}

async function runLifecycleCommand(
  name: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<void> {
  const { getProjectByName } = await import("../../database/projects.ts");
  const { withCliDatabase } = await import("../runtime/database.ts");
  const { runProjectCompose } = await import("../runtime/compose.ts");

  await withCliDatabase(options, async (db) => {
    const project = await getProjectByName(db, name);
    if (!project) {
      throw inputError(`Project not found: ${name}`);
    }

    await runProjectCompose(project, args, options);
  });
}
