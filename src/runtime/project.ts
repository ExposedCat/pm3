import type { RunCommandOptions } from "../cli/commands.ts";
import {
  listProjectComposeContainers,
  type ProjectComposeContainer,
  removeProjectComposeArtifacts,
  runProjectCompose,
} from "../cli/runtime/compose.ts";

type ProjectRuntime = {
  name: string;
  workingDir: string;
};

export type ProjectStartOptions = {
  build?: boolean;
  detached?: boolean;
  noCache?: boolean;
};

export async function startProject(
  project: ProjectRuntime,
  options: RunCommandOptions,
  startOptions: ProjectStartOptions = {},
): Promise<void> {
  if (startOptions.build) {
    await buildProject(project, options, { noCache: startOptions.noCache });
    await runProjectCompose(
      project,
      ["up", "-d", "--force-recreate"],
      options,
      { detached: startOptions.detached },
    );
    return;
  }

  await runProjectCompose(project, ["up", "-d"], options, {
    detached: startOptions.detached,
  });
}

export async function stopProject(
  project: ProjectRuntime,
  options: RunCommandOptions,
): Promise<void> {
  await runProjectCompose(project, ["stop"], options);
}

export type ProjectRestartOptions = ProjectStartOptions;

export async function restartProject(
  project: ProjectRuntime,
  options: RunCommandOptions,
  restartOptions: ProjectRestartOptions = {},
): Promise<void> {
  if (restartOptions.build) {
    await startProject(project, options, restartOptions);
    return;
  }

  await runProjectCompose(project, ["restart"], options, {
    detached: restartOptions.detached,
  });
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
  );
}
