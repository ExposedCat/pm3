import type { RunCommandOptions } from "../commands.ts";
import { inputError } from "../errors.ts";
import { startLoader } from "../output/loader.ts";
import {
  getComposeEventService,
  getComposeEventWorkingDir,
  getComposeHealthStatus,
  parsePodmanEvent,
  type ProjectComposeHealthChange,
  type ProjectComposeHealthStatus,
} from "./compose_events.ts";
import {
  hasComposeFile,
  PODMAN_COMMAND,
  PODMAN_COMPOSE_COMMAND,
} from "./compose_files.ts";
import {
  createEmptyComposeProgress,
  getComposeOperation,
  startComposeProgress,
} from "./compose_progress.ts";
import {
  parseComposeContainerJson,
  type ProjectComposeContainer,
} from "./compose_ps.ts";
import type { ProcessCommand } from "./process.ts";

export type {
  ProjectComposeContainer,
  ProjectComposeHealthChange,
  ProjectComposeHealthStatus,
};

export const STOP_COMPOSE_ARGS = ["down", "--remove-orphans"] as const;

type ComposeProject = {
  name: string;
  workingDir: string;
};

export async function runProjectCompose(
  project: ComposeProject,
  args: readonly string[],
  options: RunCommandOptions,
  runOptions: ProjectComposeRunOptions = {},
): Promise<void> {
  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const operation = getComposeOperation(args);
  const loader = startLoader(`${operation} ${project.name}`, {
    enabled: !options.verbose && !runOptions.detached,
  });
  const output = runOptions.detached
    ? createSilentComposeOutput()
    : {
        finishLine: loader.finishLine,
        startLineAfter: loader.startLineAfter,
        writeLineAfter: loader.writeLineAfter,
        startLine: loader.startLine,
      };
  let progress = createEmptyComposeProgress();
  const healthAbortController = new AbortController();
  const abortSignal = combineAbortSignals(
    options.signal,
    healthAbortController.signal,
  );

  const result = await (async () => {
    try {
      progress = await startComposeProgress(
        project,
        operation,
        options,
        output,
        {
          onHealthChange: (service, status) =>
            runOptions.onHealthChange?.({
              project: project.name,
              service,
              status,
            }),
          onUnhealthy: () => healthAbortController.abort(),
        },
      );

      const command: ProcessCommand = {
        command: PODMAN_COMPOSE_COMMAND,
        args: progress.captureComposeCommands ? ["--verbose", ...args] : args,
        cwd: project.workingDir,
      };
      const canAbortUnhealthy =
        isHealthTrackedOperation(operation) &&
        (!options.runProcess || options.runLineStream);
      const canDetach = isHealthTrackedOperation(operation);
      if (canAbortUnhealthy || options.signal) {
        command.signal = abortSignal;
      }
      if (canDetach && options.detachSignal) {
        command.detachSignal = options.detachSignal;
      }
      if (progress.captureComposeCommands) {
        command.onOutput = ({ text }) => progress.writeComposeOutput(text);
      }
      if (options.verbose) {
        command.verbose = true;
      }

      return await runProcess(command);
    } finally {
      loader.stop();
      await progress.stop();
    }
  })();

  if (result.detached) {
    return;
  }

  if (result.code !== 0) {
    const unhealthyServices = progress.unhealthyServices();
    if (unhealthyServices.length > 0) {
      await stopStartedComposeServices(project, options, {
        detached: runOptions.detached,
      });
      throw inputError(
        formatUnhealthyServices(project.name, unhealthyServices),
      );
    }

    if (options.signal?.aborted && isHealthTrackedOperation(operation)) {
      await stopStartedComposeServices(project, options, {
        detached: runOptions.detached,
      });
    }

    throw inputError(formatComposeFailure(result));
  }

  const unhealthyServices = progress.unhealthyServices();
  if (unhealthyServices.length > 0) {
    await stopStartedComposeServices(project, options, {
      detached: runOptions.detached,
    });
    throw inputError(formatUnhealthyServices(project.name, unhealthyServices));
  }

  const warnings = countWarnings(result);
  if (!runOptions.detached && warnings > progress.shownNoticeCount()) {
    console.log(`Finished with ${warnings} warnings`);
  }
}

export async function removeProjectComposeArtifacts(
  project: ComposeProject,
  options: RunCommandOptions,
  runOptions: ProjectComposeRunOptions = {},
): Promise<void> {
  if (!(await hasComposeFile(project.workingDir))) {
    return;
  }

  await runProjectCompose(
    project,
    ["down", "--volumes", "--rmi", "all", "--remove-orphans"],
    options,
    runOptions,
  );
}

export type ProjectComposeRunOptions = {
  detached?: boolean;
  onHealthChange?: (change: ProjectComposeHealthChange) => void;
};

export async function listProjectComposeContainers(
  project: ComposeProject,
  options: RunCommandOptions,
): Promise<ProjectComposeContainer[]> {
  if (!(await hasComposeFile(project.workingDir))) {
    return [];
  }

  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const result = await runProcess({
    command: PODMAN_COMPOSE_COMMAND,
    args: ["ps", "--format", "json"],
    cwd: project.workingDir,
    captureOutput: true,
  });

  if (result.code !== 0) {
    throw new Error(
      `${PODMAN_COMPOSE_COMMAND} exited with code ${result.code}`,
    );
  }

  return parseComposeContainerJson(result.stdout ?? "");
}

export async function watchProjectComposeHealthChanges(
  getProjects: () => readonly ComposeProject[],
  options: RunCommandOptions,
  onChange: (change: ProjectComposeHealthChange) => void,
): Promise<{ stop(): Promise<void> }> {
  if (options.runProcess && !options.runLineStream) {
    return { stop: () => Promise.resolve() };
  }

  const { runSystemLineStream } = await import("./process.ts");
  const runLineStream = options.runLineStream ?? runSystemLineStream;

  return await runLineStream(
    {
      command: PODMAN_COMMAND,
      args: [
        "events",
        "--format",
        "json",
        "--filter",
        "type=container",
        "--since",
        new Date().toISOString(),
      ],
    },
    (line) => {
      const event = parsePodmanEvent(line);
      const status = getComposeHealthStatus(event);
      if (!status) {
        return;
      }

      const workingDir = getComposeEventWorkingDir(event);
      const project = workingDir
        ? findComposeProject(getProjects(), workingDir)
        : "";
      const service = getComposeEventService(event);
      if (!project || !service) {
        return;
      }

      onChange({ project: project.name, service, status });
    },
  );
}

function findComposeProject(
  projects: readonly ComposeProject[],
  workingDir: string,
): ComposeProject | undefined {
  return projects.find((project) => project.workingDir === workingDir);
}

function formatComposeFailure(result: { stdout?: string; stderr?: string }) {
  return result.stderr || result.stdout || `${PODMAN_COMPOSE_COMMAND} failed`;
}

function isHealthTrackedOperation(operation: string): boolean {
  return operation === "Starting";
}

function createSilentComposeOutput() {
  return {
    finishLine: () => {},
    startLineAfter: () => {},
    startLine: () => {},
    writeLineAfter: () => {},
  };
}

function combineAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const activeSignals = signals.filter((signal) => signal !== undefined);
  if (activeSignals.length === 0) {
    return undefined;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      break;
    }

    signal.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener(
      "abort",
      () => signal.removeEventListener("abort", abort),
      { once: true },
    );
  }

  return controller.signal;
}

async function stopStartedComposeServices(
  project: ComposeProject,
  options: RunCommandOptions,
  runOptions: ProjectComposeRunOptions = {},
): Promise<void> {
  await runProjectCompose(
    project,
    STOP_COMPOSE_ARGS,
    {
      ...options,
      detachSignal: undefined,
      signal: undefined,
    },
    runOptions,
  );
}

function formatUnhealthyServices(
  projectName: string,
  services: readonly string[],
): string {
  return `Unhealthy services: ${services
    .map((service) => `${projectName}/${service}`)
    .join(", ")}`;
}

function countWarnings(result: { stdout?: string; stderr?: string }): number {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /\bwarn(?:ing)?\b/i.test(line)).length;
}
