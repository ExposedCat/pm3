import type { RunCommandOptions } from "../cli/commands.ts";
import {
  listProjectComposeContainers,
  type ProjectComposeContainer,
  type ProjectComposeHealthChange,
  removeProjectComposeArtifacts,
  runProjectCompose,
  STOP_COMPOSE_ARGS,
} from "../cli/runtime/compose.ts";

type ProjectRuntime = {
  name: string;
  workingDir: string;
};

export type ProjectStartOptions = {
  build?: boolean;
  detached?: boolean;
  noCache?: boolean;
  onHealthChange?: (change: ProjectComposeHealthChange) => void;
};

export async function startProject(
  project: ProjectRuntime,
  options: RunCommandOptions,
  startOptions: ProjectStartOptions = {},
): Promise<void> {
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
      },
    );
    return;
  }

  await runProjectCompose(project, ["up", "-d"], options, {
    detached: startOptions.detached,
    onHealthChange: startOptions.onHealthChange,
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
  await stopProject(project, options, {
    detached: restartOptions.detached,
  });
  await startProject(project, options, restartOptions);
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
