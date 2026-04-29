import type { RunCommandOptions } from "../cli/commands.ts";
import { watchProjectComposeHealthChanges } from "../cli/runtime/compose.ts";
import type { PM3Database } from "../database/database.ts";
import { listEnabledProjects, listProjects } from "../database/projects.ts";
import { startProject } from "./project.ts";

export type DaemonRunOptions = {
  reconcileIntervalMs?: number;
  signal?: AbortSignal;
  wait?: (signal: AbortSignal) => Promise<void>;
};

const DEFAULT_RECONCILE_INTERVAL_MS = 2_000;

export async function runDaemon(
  db: PM3Database,
  commandOptions: RunCommandOptions,
  daemonOptions: DaemonRunOptions = {},
): Promise<void> {
  console.log("Starting PM3 Daemon...");
  const signal = daemonOptions.signal ?? new AbortController().signal;
  const projects = new Map<number, RegisteredProject>();
  const healthStatuses = new Map<string, string>();
  let reconcileTimer: number | undefined;
  let reconciling = false;

  const healthChanges = await watchProjectComposeHealthChanges(
    () => [...projects.values()],
    commandOptions,
    ({ project, service, status }) => {
      const key = `${project}/${service}`;
      if (healthStatuses.get(key) === status) {
        return;
      }

      healthStatuses.set(key, status);
      console.log(`${project}/${service} ${status}`);
    },
  );
  try {
    await reconcileRegisteredProjects(db, projects);
    await startEnabledProjects(db, commandOptions);
    reconcileTimer = setInterval(() => {
      if (reconciling) {
        return;
      }

      reconciling = true;
      void reconcileRegisteredProjects(db, projects).finally(() => {
        reconciling = false;
      });
    }, daemonOptions.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS);
    await (daemonOptions.wait ?? waitForDaemonStop)(signal);
  } finally {
    if (reconcileTimer !== undefined) {
      clearInterval(reconcileTimer);
    }
    await healthChanges.stop();
  }
}

async function reconcileRegisteredProjects(
  db: PM3Database,
  projects: Map<number, RegisteredProject>,
): Promise<void> {
  const registeredProjects = await listRegisteredProjects(db);
  const registeredIds = new Set(
    registeredProjects.map((project) => project.id),
  );

  for (const id of projects.keys()) {
    if (!registeredIds.has(id)) {
      projects.delete(id);
    }
  }

  for (const project of registeredProjects) {
    projects.set(project.id, project);
  }
}

async function listRegisteredProjects(
  db: PM3Database,
): Promise<RegisteredProject[]> {
  return (await listProjects(db)).sort(compareProjectStartupOrder);
}

async function listStartupProjects(db: PM3Database): Promise<StartupProject[]> {
  return (await listEnabledProjects(db)).sort(compareProjectStartupOrder);
}

async function startEnabledProjects(
  db: PM3Database,
  options: RunCommandOptions,
): Promise<void> {
  for (const project of await listStartupProjects(db)) {
    await startProject(project, options, {
      detached: true,
    });
  }
}

type StartupProject = Awaited<ReturnType<typeof listEnabledProjects>>[number];
type RegisteredProject = Awaited<ReturnType<typeof listProjects>>[number];

function compareProjectStartupOrder(
  left: RegisteredProject,
  right: RegisteredProject,
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
