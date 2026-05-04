import { basename, fromFileUrl } from "@std/path";
import type {
  CliCommand,
  CommandDefinition,
  DetachedLifecycleLaunch,
  RunCommandOptions,
} from "../commands.ts";
import { withNamedProject } from "../commands.ts";
import { usageError } from "../errors.ts";
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
  supportsBuild: true,
  description: "Start the project",
});

export const stopCommand = createLifecycleCommand({
  kind: "stop",
  description: "Stop the project",
});

export const restartCommand = createLifecycleCommand({
  kind: "restart",
  supportsBuild: true,
  description: "Restart the project",
});

type LifecycleCommandConfig = {
  kind: LifecycleCommandKind;
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
        { kind: config.kind, name: parsedName, build, detach, noCache },
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
  "build" | "detach" | "kind" | "name" | "noCache"
>;

async function runLifecycleCommand(
  command: LifecycleRunCommand,
  options: RunCommandOptions,
): Promise<void> {
  await withNamedProject(options, command.name, async (_db, project) => {
    if (command.detach) {
      await launchDetachedLifecycle(command, options);
      return;
    }

    const { notifyDaemon } = await import("../../runtime/daemon_ipc.ts");
    const { listProjectContainers, restartProject, startProject, stopProject } =
      await import("../../runtime/project.ts");
    const stopState =
      command.kind === "stop"
        ? await snapshotProjectState(project, options, listProjectContainers)
        : [];
    await notifyDaemon({
      type: "lifecycle.begin",
      projectId: project.id,
      project: project.name,
      operation: command.kind,
    });

    try {
      if (command.kind === "start") {
        await startProject(project, options, {
          build: command.build,
          detached: command.detach,
          noCache: command.noCache,
        });
      } else if (command.kind === "restart") {
        await restartProject(project, options, {
          build: command.build,
          detached: command.detach,
          noCache: command.noCache,
        });
      } else {
        await stopProject(project, options, { detached: command.detach });
      }

      await notifyDaemon({
        type: "lifecycle.end",
        projectId: project.id,
        project: project.name,
        operation: command.kind,
        health:
          command.kind === "stop"
            ? []
            : await snapshotProjectHealth(
                project,
                options,
                listProjectContainers,
              ),
        state:
          command.kind === "stop"
            ? stopState
            : await snapshotProjectState(
                project,
                options,
                listProjectContainers,
              ),
      });
    } catch (error) {
      await notifyDaemon({
        type: "lifecycle.abort",
        projectId: project.id,
        project: project.name,
        operation: command.kind,
      });
      throw error;
    }
  });
}

async function launchDetachedLifecycle(
  command: LifecycleRunCommand,
  options: RunCommandOptions,
): Promise<void> {
  const launch = {
    args: createDetachedLifecycleArgs(command, options.verbose ?? false),
    env: createDetachedLifecycleEnv(options),
  } satisfies DetachedLifecycleLaunch;

  if (options.launchDetachedLifecycle) {
    await options.launchDetachedLifecycle(launch);
    return;
  }

  const invocation = createDetachedLifecycleInvocation(launch.args);
  const child = new Deno.Command(invocation.command, {
    args: invocation.args,
    env: launch.env,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  child.unref();
}

function createDetachedLifecycleArgs(
  command: LifecycleRunCommand,
  verbose: boolean,
): string[] {
  return [
    ...(verbose ? ["--verbose"] : []),
    command.kind,
    ...(command.build ? ["--build"] : []),
    ...(command.noCache ? ["--no-cache"] : []),
    command.name,
  ];
}

function createDetachedLifecycleEnv(
  options: RunCommandOptions,
): Record<string, string> {
  return options.databasePath
    ? { PM3_DATABASE_PATH: options.databasePath }
    : {};
}

function createDetachedLifecycleInvocation(commandArgs: readonly string[]): {
  command: string;
  args: string[];
} {
  const execPath = Deno.execPath();
  if (basename(execPath) !== "deno") {
    return {
      command: execPath,
      args: [...commandArgs],
    };
  }

  return {
    command: execPath,
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "--allow-run=deno,pm3,podman-compose,podman",
      fromFileUrl(new URL("../main.ts", import.meta.url)),
      ...commandArgs,
    ],
  };
}

type ProjectRuntime = {
  name: string;
  workingDir: string;
};

type ProjectHealthSnapshot = {
  service: string;
  status: "starting" | "healthy" | "degraded";
};

async function snapshotProjectHealth(
  project: ProjectRuntime,
  options: RunCommandOptions,
  listContainers: typeof import("../../runtime/project.ts").listProjectContainers,
): Promise<ProjectHealthSnapshot[]> {
  const containers = await listContainers(project, options);
  return containers.flatMap((container) =>
    container.service && container.healthStatus
      ? [{ service: container.service, status: container.healthStatus }]
      : [],
  );
}

type ProjectStateSnapshot = {
  service: string;
  status: "starting" | "started" | "stopping" | "stopped";
};

async function snapshotProjectState(
  project: ProjectRuntime,
  options: RunCommandOptions,
  listContainers: typeof import("../../runtime/project.ts").listProjectContainers,
): Promise<ProjectStateSnapshot[]> {
  const containers = await listContainers(project, options);
  const states = new Map<string, ProjectStateSnapshot["status"]>();

  for (const container of containers) {
    if (!container.service) {
      continue;
    }

    states.set(
      container.service,
      combineProjectState(
        states.get(container.service),
        container.serviceStatus,
      ),
    );
  }

  return [...states].map(([service, status]) => ({ service, status }));
}

function combineProjectState(
  current: ProjectStateSnapshot["status"] | undefined,
  next: ProjectStateSnapshot["status"],
): ProjectStateSnapshot["status"] {
  if (current === "starting" || next === "starting") {
    return "starting";
  }

  if (current === "stopping" || next === "stopping") {
    return "stopping";
  }

  if (current === "started" || next === "started") {
    return "started";
  }

  return "stopped";
}
