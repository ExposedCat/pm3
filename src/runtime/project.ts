import type { RunCommandOptions } from "../cli/commands.ts";
import {
  listProjectComposeContainers,
  type ProjectComposeContainer,
  type ProjectComposeHealthChange,
  removeProjectComposeArtifacts,
  runProjectCompose,
  STOP_COMPOSE_ARGS,
  streamProjectComposeLogs,
} from "../cli/runtime/compose.ts";

type ProjectRuntime = {
  composeArgs?: readonly string[];
  git?: 0 | 1;
  name: string;
  workingDir: string;
};

export type ProjectStartOptions = {
  build?: boolean;
  detached?: boolean;
  git?: boolean;
  noCache?: boolean;
  onHealthChange?: (change: ProjectComposeHealthChange) => void;
  trackHealth?: boolean;
};

export async function startProject(
  project: ProjectRuntime,
  options: RunCommandOptions,
  startOptions: ProjectStartOptions = {},
): Promise<void> {
  if (shouldPullProjectGit(project, startOptions.git)) {
    const { pullProjectGit } = await import("./git.ts");
    await pullProjectGit(project, options);
  }

  if (startOptions.build) {
    await buildProject(project, options, {
      detached: startOptions.detached,
      noCache: startOptions.noCache,
    });
    await runProjectCompose(
      project,
      ["up", "-d", "--force-recreate"],
      options,
      {
        detached: startOptions.detached,
        onHealthChange: startOptions.onHealthChange,
        trackHealth: startOptions.trackHealth,
      },
    );
    return;
  }

  await runProjectCompose(project, ["up", "-d"], options, {
    detached: startOptions.detached,
    onHealthChange: startOptions.onHealthChange,
    trackHealth: startOptions.trackHealth,
  });
}

export async function stopProject(
  project: ProjectRuntime,
  options: RunCommandOptions,
  stopOptions: ProjectStopOptions = {},
): Promise<void> {
  await runProjectCompose(project, STOP_COMPOSE_ARGS, options, {
    detached: stopOptions.detached,
  });
}

export type ProjectRestartOptions = ProjectStartOptions;
export type ProjectStopOptions = Pick<ProjectStartOptions, "detached">;

export async function restartProject(
  project: ProjectRuntime,
  options: RunCommandOptions,
  restartOptions: ProjectRestartOptions = {},
): Promise<void> {
  if (shouldPullProjectGit(project, restartOptions.git)) {
    const { pullProjectGit } = await import("./git.ts");
    await pullProjectGit(project, options);
  }

  await stopProject(project, options, {
    detached: restartOptions.detached,
  });
  await startProject(project, options, { ...restartOptions, git: false });
}

export async function listProjectContainers(
  project: ProjectRuntime,
  options: RunCommandOptions,
): Promise<ProjectComposeContainer[]> {
  return await listProjectComposeContainers(project, options);
}

export async function removeProjectArtifacts(
  project: ProjectRuntime,
  options: RunCommandOptions,
): Promise<void> {
  await removeProjectComposeArtifacts(project, options);
}

export async function streamProjectLogs(
  project: ProjectRuntime,
  logsOptions: ProjectLogsOptions,
  options: RunCommandOptions,
): Promise<void> {
  await streamProjectComposeLogs(project, logsOptions, options);
}

export type ProjectLogsOptions = {
  services: readonly string[];
  since: string | undefined;
  lines: number | undefined;
  raw: boolean;
  once: boolean;
};

type ProjectBuildOptions = {
  detached?: boolean;
  noCache?: boolean;
};

async function buildProject(
  project: ProjectRuntime,
  options: RunCommandOptions,
  buildOptions: ProjectBuildOptions,
): Promise<void> {
  await runProjectCompose(
    project,
    ["build", ...(buildOptions.noCache ? ["--no-cache"] : [])],
    options,
    { detached: buildOptions.detached },
  );
}

function shouldPullProjectGit(
  project: ProjectRuntime,
  gitOverride: boolean | undefined,
): boolean {
  return gitOverride ?? project.git === 1;
}
