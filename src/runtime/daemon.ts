import type { RunCommandOptions } from "../cli/commands.ts";
import {
  listProjectComposeContainers,
  type ProjectComposeContainer,
  watchProjectComposeHealthChanges,
} from "../cli/runtime/compose.ts";
import type { ProjectComposeHealthStatus } from "../cli/runtime/compose_events.ts";
import type { PM3Database } from "../database/database.ts";
import { listProjects } from "../database/projects.ts";
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
  const signal = daemonOptions.signal ?? commandOptions.signal ??
    new AbortController().signal;
  const watchedProjects = new Map<number, WatchedProject>();
  const managedProjects = new Map<number, ManagedProject>();
  const healthStatuses = new Map<string, ProjectComposeHealthStatus>();
  const healthContainerIds = new Map<string, string>();
  let reconcileTimer: number | undefined;
  let reconcilePromise: Promise<void> | undefined;
  let reconciling = false;
  let reconcileFailed = false;
  let rejectReconcileFailure: ((reason?: unknown) => void) | undefined;
  const reconcileFailure = new Promise<never>((_, reject) => {
    rejectReconcileFailure = reject;
  });

  let healthChanges: { stop(): Promise<void> } | undefined;
  try {
    const startupState = await reconcileDaemonProjects(
      db,
      watchedProjects,
      managedProjects,
      healthStatuses,
      healthContainerIds,
    );
    const startupContainers = await snapshotProjectContainers(
      commandOptions,
      startupState.managedProjects,
      healthStatuses,
      healthContainerIds,
    );
    healthChanges = await watchProjectComposeHealthChanges(
      () => [...watchedProjects.values()],
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
    await startDownProjects(
      commandOptions,
      startupState.managedProjects,
      startupContainers,
      healthStatuses,
      healthContainerIds,
    );
    reconcileTimer = setInterval(() => {
      if (reconciling || reconcileFailed) {
        return;
      }

      reconciling = true;
      reconcilePromise = reconcileDaemonState(
        db,
        commandOptions,
        watchedProjects,
        managedProjects,
        healthStatuses,
        healthContainerIds,
        { logKnownChanges: true },
      )
        .catch((error) => {
          reconcileFailed = true;
          if (reconcileTimer !== undefined) {
            clearInterval(reconcileTimer);
            reconcileTimer = undefined;
          }

          console.error(
            `PM3 daemon reconcile failed: ${formatDaemonError(error)}`,
          );
          rejectReconcileFailure?.(error);
        })
        .finally(() => {
          reconciling = false;
          reconcilePromise = undefined;
        });
    }, daemonOptions.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS);
    await Promise.race([
      (daemonOptions.wait ?? waitForDaemonStop)(signal),
      reconcileFailure,
    ]);
  } finally {
    if (reconcileTimer !== undefined) {
      clearInterval(reconcileTimer);
    }
    await reconcilePromise;
    await healthChanges?.stop();
  }
}

async function reconcileDaemonState(
  db: PM3Database,
  options: RunCommandOptions,
  watchedProjects: Map<number, WatchedProject>,
  managedProjects: Map<number, ManagedProject>,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  healthContainerIds: Map<string, string>,
  reconcileOptions: ReconcileOptions = {},
): Promise<void> {
  const state = await reconcileDaemonProjects(
    db,
    watchedProjects,
    managedProjects,
    healthStatuses,
    healthContainerIds,
  );
  const containers = await snapshotProjectContainers(
    options,
    state.managedProjects,
    healthStatuses,
    healthContainerIds,
    {
      logKnownChanges: reconcileOptions.logKnownChanges ?? false,
    },
  );
  await startDownProjects(
    options,
    state.managedProjects,
    containers,
    healthStatuses,
    healthContainerIds,
  );
}

async function reconcileDaemonProjects(
  db: PM3Database,
  watchedProjects: Map<number, WatchedProject>,
  managedProjects: Map<number, ManagedProject>,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  healthContainerIds: Map<string, string>,
): Promise<ReconciledProjects> {
  const allProjects = await listDaemonProjects(db);
  const nextManagedProjects = allProjects.filter(isManagedProject);
  const allProjectIds = new Set(allProjects.map((project) => project.id));
  const managedProjectIds = new Set(
    nextManagedProjects.map((project) => project.id),
  );

  for (const [id] of watchedProjects) {
    if (!allProjectIds.has(id)) {
      watchedProjects.delete(id);
    }
  }

  for (const [id] of managedProjects) {
    if (!managedProjectIds.has(id)) {
      managedProjects.delete(id);
    }
  }

  for (const project of allProjects) {
    watchedProjects.set(project.id, project);
  }

  for (const project of nextManagedProjects) {
    managedProjects.set(project.id, project);
  }

  pruneHealthState(managedProjects, healthStatuses, healthContainerIds);

  return {
    managedProjects: [...managedProjects.values()],
  };
}

async function listDaemonProjects(db: PM3Database): Promise<WatchedProject[]> {
  return (await listProjects(db)).sort(compareProjectStartupOrder);
}

async function startDownProjects(
  options: RunCommandOptions,
  projects: readonly ManagedProject[],
  containers: ReadonlyMap<number, readonly ProjectComposeContainer[]>,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  healthContainerIds: Map<string, string>,
): Promise<void> {
  for (const project of projects) {
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
  projects: readonly ManagedProject[],
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

type WatchedProject = Awaited<ReturnType<typeof listProjects>>[number];
type ManagedProject = WatchedProject & { enabled: 1 };

type HealthSnapshotOptions = {
  logKnownChanges?: boolean;
};

type ReconcileOptions = {
  logKnownChanges?: boolean;
};

type ReconciledProjects = {
  managedProjects: ManagedProject[];
};

function isManagedProject(project: WatchedProject): project is ManagedProject {
  return project.enabled === 1;
}

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

function pruneHealthState(
  projects: ReadonlyMap<number, ManagedProject>,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  healthContainerIds: Map<string, string>,
): void {
  const activeProjectPrefixes = [...projects.values()].map((project) =>
    `${project.name}/`
  );

  for (const key of [...healthStatuses.keys()]) {
    if (activeProjectPrefixes.some((prefix) => key.startsWith(prefix))) {
      continue;
    }

    healthStatuses.delete(key);
    healthContainerIds.delete(key);
  }
}

function isProjectDown(
  containers: readonly ProjectComposeContainer[],
): boolean {
  if (containers.length === 0) {
    return true;
  }

  return containers.every((container) =>
    ["created", "exited", "stopped"].includes(container.state.toLowerCase())
  );
}

function formatHealthStatusKey(project: string, service: string): string {
  return `${project}/${service}`;
}

function compareProjectStartupOrder(
  left: WatchedProject,
  right: WatchedProject,
): number {
  return left.name.localeCompare(right.name) || left.id - right.id;
}

function formatDaemonError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function waitForDaemonStop(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
