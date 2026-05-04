import type { RunCommandOptions } from "../commands.ts";
import { inputError } from "../errors.ts";
import { startLoader } from "../output/loader.ts";
import {
  getComposeEventService,
  getComposeEventWorkingDir,
  getComposeHealthStatus,
  getComposeServiceStatus,
  type ProjectComposeHealthChange,
  type ProjectComposeHealthStatus,
  type ProjectComposeServiceChange,
  type ProjectComposeServiceStatus,
  parsePodmanEvent,
} from "./compose_events.ts";
import {
  hasComposeFile,
  PODMAN_COMMAND,
  PODMAN_COMPOSE_COMMAND,
} from "./compose_files.ts";
import {
  type ComposeProgress,
  createEmptyComposeProgress,
  getComposeOperation,
  startComposeProgress,
} from "./compose_progress.ts";
import {
  type ProjectComposeContainer,
  parseComposeContainerJson,
} from "./compose_ps.ts";
import { createComposeStartupTracker } from "./compose_startup.ts";
import type { ProcessCommand, ProcessResult } from "./process.ts";

export type {
  ProjectComposeContainer,
  ProjectComposeHealthChange,
  ProjectComposeHealthStatus,
  ProjectComposeServiceChange,
  ProjectComposeServiceStatus,
};

type ProjectComposeStatusEvent = {
  containerId: string;
  healthStatus: ProjectComposeHealthStatus | "";
  project: string;
  service: string;
  serviceStatus: ProjectComposeServiceStatus | "";
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
  const operation = getComposeOperation(args);
  const trackHealth = runOptions.trackHealth ?? true;
  const startupAbortController = new AbortController();
  const canAbortUnhealthy =
    trackHealth &&
    isHealthTrackedOperation(operation) &&
    (!options.runProcess || options.runLineStream);
  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const startupTracker = canAbortUnhealthy
    ? await createComposeStartupTracker(project, runProcess)
    : undefined;
  const failOnUnhealthy = canAbortUnhealthy && !startupTracker;
  const healthAbortController = canAbortUnhealthy
    ? new AbortController()
    : undefined;
  const result = await runComposeCommand(project, operation, args, options, {
    detached: runOptions.detached,
    detachSignal: isHealthTrackedOperation(operation)
      ? options.detachSignal
      : undefined,
    onHealthChange: (change) => {
      runOptions.onHealthChange?.(change);
      startupTracker?.recordHealth(change.service, change.status);
      if (startupTracker?.abortReason()) {
        startupAbortController.abort();
      }
    },
    onServiceChange: startupTracker
      ? (change) => {
          startupTracker.recordService(change.service, change.status);
          if (startupTracker.abortReason()) {
            startupAbortController.abort();
          }
        }
      : undefined,
    onUnhealthy: canAbortUnhealthy
      ? () => healthAbortController?.abort()
      : undefined,
    signal: canAbortUnhealthy
      ? combineAbortSignals(
          options.signal,
          healthAbortController?.signal,
          startupAbortController.signal,
        )
      : options.signal,
    trackHealth,
  });

  if (result.process.detached) {
    return;
  }

  if (result.process.code !== 0) {
    const startupAbortReason = startupTracker?.abortReason() ?? "";
    if (startupAbortReason) {
      await stopStartedComposeServices(project, options, {
        detached: runOptions.detached,
      });
      throw inputError(startupAbortReason);
    }

    const unhealthyServices = result.progress.unhealthyServices();
    if (failOnUnhealthy && unhealthyServices.length > 0) {
      await stopStartedComposeServices(project, options, {
        detached: runOptions.detached,
      });
      throw inputError(
        formatUnhealthyServices(project.name, unhealthyServices),
      );
    }
    if (unhealthyServices.length > 0) {
      return;
    }

    if (options.signal?.aborted && isHealthTrackedOperation(operation)) {
      await stopStartedComposeServices(project, options, {
        detached: runOptions.detached,
      });
    }

    throw inputError(formatComposeFailure(result.process));
  }

  const startupAbortReason = startupTracker?.abortReason() ?? "";
  if (startupAbortReason) {
    await stopStartedComposeServices(project, options, {
      detached: runOptions.detached,
    });
    throw inputError(startupAbortReason);
  }

  const unhealthyServices = result.progress.unhealthyServices();
  if (failOnUnhealthy && unhealthyServices.length > 0) {
    await stopStartedComposeServices(project, options, {
      detached: runOptions.detached,
    });
    throw inputError(formatUnhealthyServices(project.name, unhealthyServices));
  }

  const warnings = countWarnings(result.process);
  if (!runOptions.detached && warnings > result.progress.shownNoticeCount()) {
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
  trackHealth?: boolean;
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

export async function watchProjectComposeStatusChanges(
  getProjects: () => readonly ComposeProject[],
  options: RunCommandOptions,
  onChange: (change: ProjectComposeStatusEvent) => void,
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
      const healthStatus = getComposeHealthStatus(event);
      const serviceStatus = getComposeServiceStatus(event);
      if (!healthStatus && !serviceStatus) {
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

      onChange({
        healthStatus,
        project: project.name,
        service,
        serviceStatus,
        containerId: event?.ID ?? "",
      });
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
  const result = await runComposeCommand(
    project,
    getComposeOperation(STOP_COMPOSE_ARGS),
    STOP_COMPOSE_ARGS,
    {
      ...options,
      detachSignal: undefined,
      signal: undefined,
    },
    {
      detached: runOptions.detached,
    },
  );

  if (result.process.code !== 0) {
    throw inputError(formatComposeFailure(result.process));
  }
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

type ComposeCommandRunOptions = {
  detached?: boolean;
  detachSignal?: AbortSignal;
  onHealthChange?: (change: ProjectComposeHealthChange) => void;
  onServiceChange?: (change: ProjectComposeServiceChange) => void;
  onUnhealthy?: (service: string) => void;
  signal?: AbortSignal;
  trackHealth?: boolean;
};

type ComposeCommandRunResult = {
  process: ProcessResult;
  progress: ComposeProgress;
};

async function runComposeCommand(
  project: ComposeProject,
  operation: string,
  args: readonly string[],
  options: RunCommandOptions,
  runOptions: ComposeCommandRunOptions = {},
): Promise<ComposeCommandRunResult> {
  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const loader = startLoader(`${operation} ${project.name}`, {
    enabled: !options.verbose && !runOptions.detached,
  });
  const output = runOptions.detached
    ? createSilentComposeOutput()
    : {
        finishLine: loader.finishLine,
        startLineAfter: loader.startLineAfter,
        startLine: loader.startLine,
        writeLineAfter: loader.writeLineAfter,
      };
  let progress = createEmptyComposeProgress();

  try {
    if (runOptions.trackHealth ?? true) {
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
          onServiceChange: (service, status) =>
            runOptions.onServiceChange?.({
              project: project.name,
              service,
              status,
            }),
          onUnhealthy: runOptions.onUnhealthy,
        },
      );
    }

    const command: ProcessCommand = {
      command: PODMAN_COMPOSE_COMMAND,
      args: progress.captureComposeCommands ? ["--verbose", ...args] : args,
      cwd: project.workingDir,
      detached: runOptions.detached,
    };
    if (runOptions.signal) {
      command.signal = runOptions.signal;
    }
    if (runOptions.detachSignal) {
      command.detachSignal = runOptions.detachSignal;
    }
    if (progress.captureComposeCommands) {
      command.onOutput = ({ text }) => progress.writeComposeOutput(text);
    }
    if (options.verbose) {
      command.verbose = true;
    }

    return {
      process: await runProcess(command),
      progress,
    };
  } finally {
    loader.stop();
    await progress.stop();
  }
}
