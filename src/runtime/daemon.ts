import type { RunCommandOptions } from "../cli/commands.ts";
import {
  listProjectComposeContainers,
  type ProjectComposeContainer,
  watchProjectComposeHealthChanges,
} from "../cli/runtime/compose.ts";
import type { ProjectComposeHealthStatus } from "../cli/runtime/compose_events.ts";
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
  const healthStatuses = new Map<string, ProjectComposeHealthStatus>();
  const healthContainerIds = new Map<string, string>();
  let monitorTimer: number | undefined;
  let monitorPromise: Promise<void> | undefined;
  let monitoring = false;

  let healthChanges: { stop(): Promise<void> } | undefined;
  try {
    await reconcileRegisteredProjects(db, projects);
    const containers = await snapshotProjectContainers(
      commandOptions,
      [...projects.values()],
      healthStatuses,
      healthContainerIds,
    );
    healthChanges = await watchProjectComposeHealthChanges(
      () => [...projects.values()],
      commandOptions,
      ({ project, service, status }) => {
        const key = formatHealthStatusKey(project, service);
        if (healthStatuses.get(key) === status) {
          return;
        }

        healthContainerIds.delete(key);
        healthStatuses.set(key, status);
        console.log(`${project}/${service} ${status}`);
      },
    );
    await startEnabledProjects(
      db,
      commandOptions,
      containers,
      healthStatuses,
      healthContainerIds,
    );
    monitorTimer = setInterval(() => {
      if (monitoring) {
        return;
      }

      monitoring = true;
      monitorPromise = monitorRegisteredProjects(
        db,
        commandOptions,
        projects,
        healthStatuses,
        healthContainerIds,
      )
        .catch(() => {})
        .finally(() => {
          monitoring = false;
          monitorPromise = undefined;
        });
    }, daemonOptions.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS);
    await (daemonOptions.wait ?? waitForDaemonStop)(signal);
  } finally {
    if (monitorTimer !== undefined) {
      clearInterval(monitorTimer);
    }
    await monitorPromise;
    await healthChanges?.stop();
  }
}

async function monitorRegisteredProjects(
  db: PM3Database,
  options: RunCommandOptions,
  projects: Map<number, RegisteredProject>,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  healthContainerIds: Map<string, string>,
): Promise<void> {
  await reconcileRegisteredProjects(db, projects);
  await snapshotProjectContainers(
    options,
    [...projects.values()],
    healthStatuses,
    healthContainerIds,
    {
      logKnownChanges: true,
    },
  );
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
  containers: ReadonlyMap<number, readonly ProjectComposeContainer[]>,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  healthContainerIds: Map<string, string>,
): Promise<void> {
  for (const project of await listStartupProjects(db)) {
    if (!isProjectDown(containers.get(project.id) ?? [])) {
      continue;
    }

    await startProject(project, options, {
      detached: true,
      onHealthChange: (change) =>
        trackHealthStatus(
          healthStatuses,
          healthContainerIds,
          change.project,
          change.service,
          change.status,
          "",
          { logKnownChanges: true },
        ),
    });
  }
}

async function snapshotProjectContainers(
  options: RunCommandOptions,
  projects: readonly RegisteredProject[],
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  healthContainerIds: Map<string, string>,
  snapshotOptions: HealthSnapshotOptions = {},
): Promise<Map<number, ProjectComposeContainer[]>> {
  const containersByProject = new Map<number, ProjectComposeContainer[]>();

  for (const project of projects) {
    const containers = await listProjectComposeContainers(project, options);
    containersByProject.set(project.id, containers);
    for (const container of containers) {
      if (!container.service || !container.healthStatus) {
        continue;
      }

      trackHealthStatus(
        healthStatuses,
        healthContainerIds,
        project.name,
        container.service,
        container.healthStatus,
        container.id,
        snapshotOptions,
      );
    }
  }

  return containersByProject;
}

type StartupProject = Awaited<ReturnType<typeof listEnabledProjects>>[number];
type RegisteredProject = Awaited<ReturnType<typeof listProjects>>[number];

type HealthSnapshotOptions = {
  logKnownChanges?: boolean;
};

function trackHealthStatus(
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  healthContainerIds: Map<string, string>,
  project: string,
  service: string,
  status: ProjectComposeHealthStatus,
  containerId: string,
  options: HealthSnapshotOptions,
): void {
  const key = formatHealthStatusKey(project, service);
  const previousStatus = healthStatuses.get(key);
  const previousContainerId = healthContainerIds.get(key);
  if (containerId) {
    healthContainerIds.set(key, containerId);
  }
  healthStatuses.set(key, status);

  const changedContainer = Boolean(
    previousContainerId && containerId && previousContainerId !== containerId,
  );
  if (
    options.logKnownChanges &&
    (changedContainer || previousStatus !== status)
  ) {
    console.log(`${project}/${service} ${status}`);
  }
}

function isProjectDown(
  containers: readonly ProjectComposeContainer[],
): boolean {
  if (containers.length === 0) {
    return true;
  }

  return containers.every((container) =>
    ["created", "exited", "stopped"].includes(container.state.toLowerCase()),
  );
}

function formatHealthStatusKey(project: string, service: string): string {
  return `${project}/${service}`;
}

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
