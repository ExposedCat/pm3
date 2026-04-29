import type { RunCommandOptions } from "../commands.ts";
import { inputError } from "../errors.ts";
import { startLoader } from "../output/loader.ts";
import {
  getComposeEventService,
  getComposeEventWorkingDir,
  getComposeHealthStatus,
  type ProjectComposeHealthChange,
  type ProjectComposeHealthStatus,
  parsePodmanEvent,
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
  type ProjectComposeContainer,
  parseComposeContainerJson,
} from "./compose_ps.ts";
import type { ProcessCommand } from "./process.ts";

export type {
  ProjectComposeContainer,
  ProjectComposeHealthChange,
  ProjectComposeHealthStatus,
};

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
  let progress = createEmptyComposeProgress();

  const result = await (async () => {
    try {
      progress = runOptions.detached
        ? createEmptyComposeProgress()
        : await startComposeProgress(project, operation, options, {
            finishLine: loader.finishLine,
            writeLineAfter: loader.writeLineAfter,
            startLine: loader.startLine,
          });

      const command: ProcessCommand = {
        command: PODMAN_COMPOSE_COMMAND,
        args: progress.captureComposeCommands ? ["--verbose", ...args] : args,
        cwd: project.workingDir,
      };
      if (runOptions.detached) {
        command.detached = true;
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

  if (result.code !== 0) {
    throw inputError(formatComposeFailure(result));
  }

  if (runOptions.detached) {
    return;
  }

  const warnings = countWarnings(result);
  if (warnings > progress.shownNoticeCount()) {
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

function countWarnings(result: { stdout?: string; stderr?: string }): number {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /\bwarn(?:ing)?\b/i.test(line)).length;
}
