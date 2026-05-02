import type { RunCommandOptions } from "../cli/commands.ts";
import {
  listProjectComposeContainers,
  type ProjectComposeContainer,
  watchProjectComposeHealthChanges,
} from "../cli/runtime/compose.ts";
import type { ProjectComposeHealthStatus } from "../cli/runtime/compose_events.ts";
import type { PM3Database } from "../database/database.ts";
import {
  listProjectServiceHealth,
  setProjectServiceHealth,
} from "../database/project_health.ts";
import { listProjects } from "../database/projects.ts";
import { type DaemonMessage, startDaemonIpcServer } from "./daemon_ipc.ts";
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
  console.log("Starting PM3 Daemon...");
  const signal =
    daemonOptions.signal ??
    commandOptions.signal ??
    new AbortController().signal;
  const healthStatuses = new Map<string, ProjectComposeHealthStatus>();
  const lifecycleOperations = new Map<string, DaemonLifecycleOperation>();

  let ipcServer: { stop(): Promise<void> } | undefined;
  let healthChanges: { stop(): Promise<void> } | undefined;
  try {
    const startupProjects = await listDaemonProjects(db);
    seedPersistedHealthStatuses(
      healthStatuses,
      startupProjects,
      await listProjectServiceHealth(db),
    );
    const enabledProjects = startupProjects.filter(isEnabledProject);
    const startupContainers = await snapshotProjectContainers(
      db,
      commandOptions,
      enabledProjects,
      healthStatuses,
      { logKnownChanges: true },
    );
    await startDownProjects(commandOptions, enabledProjects, startupContainers);
    ipcServer = await startDaemonIpcServer((message) => {
      void handleDaemonMessage(
        db,
        lifecycleOperations,
        healthStatuses,
        message,
      );
    });
    healthChanges = await watchProjectComposeHealthChanges(
      () => startupProjects,
      commandOptions,
      ({ project, service, status }) => {
        if (lifecycleOperations.has(project)) {
          return;
        }

        const daemonProject = findDaemonProject(startupProjects, project);
        if (!daemonProject) {
          return;
        }

        void trackHealthStatus(
          db,
          healthStatuses,
          daemonProject,
          service,
          status,
          { logKnownChanges: true },
        );
      },
    );
    await (daemonOptions.wait ?? waitForDaemonStop)(signal);
  } finally {
    await healthChanges?.stop();
    await ipcServer?.stop();
  }
}

async function listDaemonProjects(db: PM3Database): Promise<DaemonProject[]> {
  return (await listProjects(db)).sort(compareProjectStartupOrder);
}

async function startDownProjects(
  options: RunCommandOptions,
  projects: readonly EnabledProject[],
  containers: ReadonlyMap<number, readonly ProjectComposeContainer[]>,
): Promise<void> {
  for (const project of projects) {
    if (!isProjectDown(containers.get(project.id) ?? [])) {
      continue;
    }

    await startProject(project, options, {
      detached: true,
      trackHealth: false,
    });
  }
}

async function snapshotProjectContainers(
  db: PM3Database,
  options: RunCommandOptions,
  projects: readonly EnabledProject[],
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
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

      await trackHealthStatus(
        db,
        healthStatuses,
        project,
        container.service,
        container.healthStatus,
        snapshotOptions,
      );
    }
  }

  return containersByProject;
}

type DaemonProject = Awaited<ReturnType<typeof listProjects>>[number];
type EnabledProject = DaemonProject & { enabled: 1 };

type HealthSnapshotOptions = {
  logKnownChanges?: boolean;
};

type DaemonLifecycleOperation = "restart" | "start" | "stop";

type PersistedProjectHealth = Awaited<
  ReturnType<typeof listProjectServiceHealth>
>[number];

function isEnabledProject(project: DaemonProject): project is EnabledProject {
  return project.enabled === 1;
}

async function handleDaemonMessage(
  db: PM3Database,
  lifecycleOperations: Map<string, DaemonLifecycleOperation>,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  message: DaemonMessage,
): Promise<void> {
  if (message.type === "lifecycle.begin") {
    lifecycleOperations.set(message.project, message.operation);
    return;
  }

  if (message.type === "lifecycle.abort") {
    lifecycleOperations.delete(message.project);
    return;
  }

  if (message.operation === "stop") {
    lifecycleOperations.set(message.project, message.operation);
    return;
  }

  lifecycleOperations.delete(message.project);
  for (const health of message.health) {
    await trackHealthStatus(
      db,
      healthStatuses,
      { id: message.projectId, name: message.project },
      health.service,
      health.status,
      { logKnownChanges: true },
    );
  }
}

async function trackHealthStatus(
  db: PM3Database,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  project: Pick<DaemonProject, "id" | "name">,
  service: string,
  status: ProjectComposeHealthStatus,
  options: HealthSnapshotOptions,
): Promise<void> {
  const key = formatHealthStatusKey(project.name, service);
  const previousStatus = healthStatuses.get(key);
  healthStatuses.set(key, status);
  await setProjectServiceHealth(db, {
    projectId: project.id,
    service,
    status,
  });
  if (options.logKnownChanges && previousStatus !== status) {
    console.log(`${project.name}/${service} ${status}`);
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

function seedPersistedHealthStatuses(
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  projects: readonly DaemonProject[],
  persistedHealth: readonly PersistedProjectHealth[],
): void {
  const projectsById = new Map(
    projects.map((project) => [project.id, project]),
  );
  for (const health of persistedHealth) {
    const project = projectsById.get(health.projectId);
    if (!project) {
      continue;
    }

    healthStatuses.set(
      formatHealthStatusKey(project.name, health.service),
      health.status,
    );
  }
}

function findDaemonProject(
  projects: readonly DaemonProject[],
  name: string,
): DaemonProject | undefined {
  return projects.find((project) => project.name === name);
}

function compareProjectStartupOrder(
  left: DaemonProject,
  right: DaemonProject,
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
