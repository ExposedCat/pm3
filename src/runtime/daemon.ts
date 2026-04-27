import type { RunCommandOptions } from "../cli/commands.ts";
import type { PM3Database } from "../database/database.ts";
import { listEnabledProjects } from "../database/projects.ts";
import { startProject } from "./project.ts";

export type DaemonRunOptions = {
  signal?: AbortSignal;
  wait?: (signal: AbortSignal) => Promise<void>;
};

export async function runDaemon(
  db: PM3Database,
  commandOptions: RunCommandOptions,
  daemonOptions: DaemonRunOptions = {},
): Promise<void> {
  const signal = daemonOptions.signal ?? new AbortController().signal;

  await startEnabledProjects(db, commandOptions);
  await (daemonOptions.wait ?? waitForDaemonStop)(signal);
}

export async function startEnabledProjects(
  db: PM3Database,
  options: RunCommandOptions,
): Promise<void> {
  const projects = (await listEnabledProjects(db)).sort(
    compareProjectStartupOrder,
  );

  for (const project of projects) {
    await startProject(project, options, {
      detached: true,
    });
  }
}

type StartupProject = Awaited<ReturnType<typeof listEnabledProjects>>[number];

function compareProjectStartupOrder(
  left: StartupProject,
  right: StartupProject,
): number {
  return left.name.localeCompare(right.name) || left.id - right.id;
}

function waitForDaemonStop(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
