import type { RunCommandOptions } from "../cli/commands.ts";
import {
  listProjectComposeContainers,
  type ProjectComposeContainer,
  watchProjectComposeStatusChanges,
} from "../cli/runtime/compose.ts";
import type {
  ProjectComposeHealthStatus,
  ProjectComposeServiceStatus,
} from "../cli/runtime/compose_events.ts";
import {
  type ComposeHookEvent,
  resolveComposeHookCommand,
} from "../cli/runtime/compose_hooks.ts";
import {
  type ComposeStartupConfig,
  type ComposeStartupServiceState,
  evaluateComposeStartupPolicy,
  getComposeServiceHealthCheckAt,
  readComposeStartupConfig,
} from "../cli/runtime/compose_startup.ts";
import type { PM3Database } from "../database/database.ts";
import {
  listProjectServiceHealth,
  setProjectServiceHealth,
} from "../database/project_health.ts";
import {
  listProjectServiceStates,
  setProjectServiceState,
} from "../database/project_state.ts";
import { listProjects } from "../database/projects.ts";
import { type DaemonMessage, startDaemonIpcServer } from "./daemon_ipc.ts";
import { startProject, stopProject } from "./project.ts";

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
  const hookErrors = new Set<string>();
  const healthStatuses = new Map<string, ProjectComposeHealthStatus>();
  const serviceStatuses = new Map<string, ProjectComposeServiceStatus>();
  const lifecycleOperations = new Map<string, DaemonLifecycleOperation>();

  let ipcServer: { stop(): Promise<void> } | undefined;
  let statusChanges: { stop(): Promise<void> } | undefined;
  try {
    const startupProjects = await listDaemonProjects(db);
    seedPersistedHealthStatuses(
      healthStatuses,
      startupProjects,
      await listProjectServiceHealth(db),
    );
    seedPersistedServiceStatuses(
      serviceStatuses,
      startupProjects,
      await listProjectServiceStates(db),
    );
    const enabledProjects = startupProjects.filter(isEnabledProject);
    const { runSystemProcess } = await import("../cli/runtime/process.ts");
    const runProcess = commandOptions.runProcess ?? runSystemProcess;
    const runHook = createComposeHookRunner(runProcess, hookErrors);
    const watcherConfigs = await loadComposeWatcherConfigs(
      startupProjects,
      runProcess,
    );
    const startupContainers = await snapshotProjectContainers(
      db,
      commandOptions,
      startupProjects,
      healthStatuses,
      serviceStatuses,
      { logKnownChanges: true },
    );
    for (const project of startupProjects) {
      void enforceComposeWatcherPolicy(
        db,
        commandOptions,
        lifecycleOperations,
        healthStatuses,
        serviceStatuses,
        runHook,
        project,
        watcherConfigs.get(project.name),
      );
    }
    ipcServer = await startDaemonIpcServer((message) => {
      void handleDaemonMessage(
        db,
        startupProjects,
        lifecycleOperations,
        healthStatuses,
        serviceStatuses,
        runHook,
        message,
      );
    });
    statusChanges = await watchProjectComposeStatusChanges(
      () => startupProjects,
      commandOptions,
      ({ healthStatus, project, service, serviceStatus }) => {
        const daemonProject = findDaemonProject(startupProjects, project);
        if (!daemonProject) {
          return;
        }

        const lifecycleOperation = lifecycleOperations.get(project);
        if (lifecycleOperation) {
          if (!serviceStatus) {
            return;
          }

          void trackServiceStatus(
            db,
            serviceStatuses,
            daemonProject,
            service,
            normalizeLifecycleServiceStatus(lifecycleOperation, serviceStatus),
            { logKnownChanges: true, runHook },
          );
          return;
        }

        void trackComposeServiceStatuses(
          db,
          healthStatuses,
          serviceStatuses,
          daemonProject,
          { healthStatus, service, serviceStatus },
          { logKnownChanges: true, runHook },
        ).then(() =>
          enforceComposeWatcherPolicy(
            db,
            commandOptions,
            lifecycleOperations,
            healthStatuses,
            serviceStatuses,
            runHook,
            daemonProject,
            watcherConfigs.get(daemonProject.name),
          ),
        );
      },
    );
    await startDownProjects(commandOptions, enabledProjects, startupContainers);
    await (daemonOptions.wait ?? waitForDaemonStop)(signal);
  } finally {
    await statusChanges?.stop();
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
  projects: readonly DaemonProject[],
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  serviceStatuses: Map<string, ProjectComposeServiceStatus>,
  snapshotOptions: TrackStatusOptions = {},
): Promise<Map<number, ProjectComposeContainer[]>> {
  const containersByProject = new Map<number, ProjectComposeContainer[]>();

  for (const project of projects) {
    const containers = await listProjectComposeContainers(project, options);
    containersByProject.set(project.id, containers);
    for (const status of summarizeComposeContainerStatuses(containers)) {
      await trackComposeServiceStatuses(
        db,
        healthStatuses,
        serviceStatuses,
        project,
        status,
        snapshotOptions,
      );
    }
  }

  return containersByProject;
}

type DaemonProject = Awaited<ReturnType<typeof listProjects>>[number];
type EnabledProject = DaemonProject & { enabled: 1 };

type TrackStatusOptions = {
  logKnownChanges?: boolean;
  runHook?: ComposeHookRunner;
};

type DaemonLifecycleOperation = "restart" | "start" | "stop";

type PersistedProjectHealth = Awaited<
  ReturnType<typeof listProjectServiceHealth>
>[number];
type PersistedProjectState = Awaited<
  ReturnType<typeof listProjectServiceStates>
>[number];
type ServiceStatusSnapshot = {
  healthStatus: ProjectComposeHealthStatus | "";
  service: string;
  serviceStatus: ProjectComposeServiceStatus | "";
};

function isEnabledProject(project: DaemonProject): project is EnabledProject {
  return project.enabled === 1;
}

async function loadComposeWatcherConfigs(
  projects: readonly DaemonProject[],
  runProcess: (
    command: import("../cli/runtime/process.ts").ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
): Promise<Map<string, ComposeStartupConfig>> {
  const configs = new Map<string, ComposeStartupConfig>();

  for (const project of projects) {
    const config = await readComposeStartupConfig(project, runProcess);
    const shouldWatch =
      config?.policy.requiredServices.some(
        (service) =>
          getComposeServiceHealthCheckAt(config, service) === "always",
      ) ?? false;
    if (config && shouldWatch) {
      configs.set(project.name, config);
    }
  }

  return configs;
}

async function handleDaemonMessage(
  db: PM3Database,
  projects: readonly DaemonProject[],
  lifecycleOperations: Map<string, DaemonLifecycleOperation>,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  serviceStatuses: Map<string, ProjectComposeServiceStatus>,
  runHook: ComposeHookRunner,
  message: DaemonMessage,
): Promise<void> {
  const project = findDaemonProject(projects, message.project);
  if (!project) {
    return;
  }

  if (message.type === "lifecycle.begin") {
    lifecycleOperations.set(message.project, message.operation);
    if (message.operation === "start") {
      await markProjectServicesStarting(db, serviceStatuses, project, {
        logKnownChanges: true,
        runHook,
      });
    } else if (
      message.operation === "stop" ||
      message.operation === "restart"
    ) {
      await markProjectServicesStopping(db, serviceStatuses, project, {
        logKnownChanges: true,
        runHook,
      });
    }
    return;
  }

  if (message.type === "lifecycle.abort") {
    lifecycleOperations.delete(message.project);
    return;
  }

  if (message.operation === "stop") {
    await markProjectServicesStopped(db, serviceStatuses, project, {
      logKnownChanges: true,
      runHook,
    });
    lifecycleOperations.set(message.project, message.operation);
    return;
  }

  lifecycleOperations.delete(message.project);
  for (const health of message.health) {
    await trackHealthStatus(
      db,
      healthStatuses,
      project,
      health.service,
      health.status,
      { logKnownChanges: true, runHook },
    );
  }
  for (const state of message.state) {
    await trackServiceStatus(
      db,
      serviceStatuses,
      project,
      state.service,
      state.status,
      { logKnownChanges: true, runHook },
    );
  }
}

async function trackComposeServiceStatuses(
  db: PM3Database,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  serviceStatuses: Map<string, ProjectComposeServiceStatus>,
  project: Pick<DaemonProject, "id" | "name" | "workingDir">,
  status: ServiceStatusSnapshot,
  options: TrackStatusOptions,
): Promise<void> {
  if (status.serviceStatus) {
    await trackServiceStatus(
      db,
      serviceStatuses,
      project,
      status.service,
      status.serviceStatus,
      options,
    );
  }

  if (status.healthStatus) {
    await trackHealthStatus(
      db,
      healthStatuses,
      project,
      status.service,
      status.healthStatus,
      options,
    );
  }
}

async function trackHealthStatus(
  db: PM3Database,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  project: Pick<DaemonProject, "id" | "name" | "workingDir">,
  service: string,
  status: ProjectComposeHealthStatus,
  options: TrackStatusOptions,
): Promise<void> {
  const key = formatProjectServiceKey(project.name, service);
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
  if (previousStatus !== status) {
    await options.runHook?.(project, service, status);
  }
}

async function trackServiceStatus(
  db: PM3Database,
  serviceStatuses: Map<string, ProjectComposeServiceStatus>,
  project: Pick<DaemonProject, "id" | "name" | "workingDir">,
  service: string,
  status: ProjectComposeServiceStatus,
  options: TrackStatusOptions,
): Promise<void> {
  const key = formatProjectServiceKey(project.name, service);
  const previousStatus = serviceStatuses.get(key);
  serviceStatuses.set(key, status);
  await setProjectServiceState(db, {
    projectId: project.id,
    service,
    status,
  });
  if (options.logKnownChanges && previousStatus !== status) {
    console.log(`${project.name}/${service} ${status}`);
  }
  if (previousStatus !== status) {
    await options.runHook?.(project, service, status);
  }
}

async function markProjectServicesStopped(
  db: PM3Database,
  serviceStatuses: Map<string, ProjectComposeServiceStatus>,
  project: Pick<DaemonProject, "id" | "name" | "workingDir">,
  options: TrackStatusOptions,
): Promise<void> {
  await markProjectServicesStatus(
    db,
    serviceStatuses,
    project,
    "stopped",
    options,
  );
}

async function markProjectServicesStarting(
  db: PM3Database,
  serviceStatuses: Map<string, ProjectComposeServiceStatus>,
  project: Pick<DaemonProject, "id" | "name" | "workingDir">,
  options: TrackStatusOptions,
): Promise<void> {
  await markProjectServicesStatus(
    db,
    serviceStatuses,
    project,
    "starting",
    options,
  );
}

async function markProjectServicesStopping(
  db: PM3Database,
  serviceStatuses: Map<string, ProjectComposeServiceStatus>,
  project: Pick<DaemonProject, "id" | "name" | "workingDir">,
  options: TrackStatusOptions,
): Promise<void> {
  await markProjectServicesStatus(
    db,
    serviceStatuses,
    project,
    "stopping",
    options,
  );
}

async function markProjectServicesStatus(
  db: PM3Database,
  serviceStatuses: Map<string, ProjectComposeServiceStatus>,
  project: Pick<DaemonProject, "id" | "name" | "workingDir">,
  status: ProjectComposeServiceStatus,
  options: TrackStatusOptions,
): Promise<void> {
  const services = listKnownProjectServices(serviceStatuses, project.name);

  for (const service of services) {
    await trackServiceStatus(db, serviceStatuses, project, service, status, {
      ...options,
      logKnownChanges: true,
    });
  }
}

async function enforceComposeWatcherPolicy(
  db: PM3Database,
  options: RunCommandOptions,
  lifecycleOperations: Map<string, DaemonLifecycleOperation>,
  healthStatuses: Map<string, ProjectComposeHealthStatus>,
  serviceStatuses: Map<string, ProjectComposeServiceStatus>,
  runHook: ComposeHookRunner,
  project: Pick<DaemonProject, "id" | "name" | "workingDir">,
  config: ComposeStartupConfig | undefined,
): Promise<void> {
  if (!config || lifecycleOperations.has(project.name)) {
    return;
  }

  const reason = evaluateComposeStartupPolicy(
    config,
    snapshotComposeStartupState(
      healthStatuses,
      serviceStatuses,
      project,
      config,
    ),
  );
  if (!reason) {
    return;
  }

  lifecycleOperations.set(project.name, "stop");
  await markProjectServicesStopping(db, serviceStatuses, project, {
    logKnownChanges: true,
    runHook,
  });
  try {
    await stopProject(project, options, { detached: true });
  } catch (error) {
    console.error(
      `Failed to stop ${project.name} after watcher policy triggered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function snapshotComposeStartupState(
  healthStatuses: ReadonlyMap<string, ProjectComposeHealthStatus>,
  serviceStatuses: ReadonlyMap<string, ProjectComposeServiceStatus>,
  project: Pick<DaemonProject, "name">,
  config: ComposeStartupConfig,
): Map<string, ComposeStartupServiceState> {
  const state = new Map<string, ComposeStartupServiceState>();

  for (const service of config.services) {
    const key = formatProjectServiceKey(project.name, service);
    const serviceStatus = serviceStatuses.get(key) ?? "starting";
    state.set(service, {
      everStarted: serviceStatus === "started" || serviceStatus === "stopped",
      health: healthStatuses.get(key) ?? "",
      status: serviceStatus,
    });
  }

  return state;
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

function formatProjectServiceKey(project: string, service: string): string {
  return `${project}/${service}`;
}

function normalizeLifecycleServiceStatus(
  operation: DaemonLifecycleOperation,
  status: ProjectComposeServiceStatus,
): ProjectComposeServiceStatus {
  if (
    (operation === "stop" || operation === "restart") &&
    status === "stopping"
  ) {
    return "stopped";
  }

  return status;
}

function listKnownProjectServices(
  serviceStatuses: ReadonlyMap<string, ProjectComposeServiceStatus>,
  projectName: string,
): string[] {
  const services = new Set<string>();

  for (const key of serviceStatuses.keys()) {
    const [candidateProjectName, service] = key.split("/", 2);
    if (candidateProjectName === projectName && service) {
      services.add(service);
    }
  }

  return [...services];
}

type ComposeHookRunner = (
  project: Pick<DaemonProject, "name" | "workingDir">,
  service: string,
  event: ComposeHookEvent,
) => Promise<void>;

function createComposeHookRunner(
  runProcess: (
    command: import("../cli/runtime/process.ts").ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
  hookErrors: Set<string>,
): ComposeHookRunner {
  return async (project, service, event) => {
    const command = resolveComposeHookCommand({
      event,
      project: project.name,
      service,
    });
    if (!command) {
      return;
    }

    const args = [project.name, service, event]
      .map(quoteShellArgument)
      .join(" ");
    const result = await runProcess({
      command: "sh",
      args: ["-lc", `${command} ${args}`],
      captureOutput: true,
      cwd: project.workingDir,
    });
    if (result.code === 0) {
      hookErrors.delete(formatHookErrorKey(project.name, service, event));
      return;
    }

    const errorKey = formatHookErrorKey(project.name, service, event);
    const message =
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      `hook exited with code ${result.code}`;
    if (hookErrors.has(errorKey)) {
      return;
    }

    hookErrors.add(errorKey);
    console.error(
      `Hook failed for ${project.name}/${service} ${event}: ${message}`,
    );
  };
}

function formatHookErrorKey(
  project: string,
  service: string,
  event: ComposeHookEvent,
): string {
  return `${project}/${service}/${event}`;
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
      formatProjectServiceKey(project.name, health.service),
      health.status,
    );
  }
}

function seedPersistedServiceStatuses(
  serviceStatuses: Map<string, ProjectComposeServiceStatus>,
  projects: readonly DaemonProject[],
  persistedStates: readonly PersistedProjectState[],
): void {
  const projectsById = new Map(
    projects.map((project) => [project.id, project]),
  );
  for (const state of persistedStates) {
    const project = projectsById.get(state.projectId);
    if (!project) {
      continue;
    }

    serviceStatuses.set(
      formatProjectServiceKey(project.name, state.service),
      state.status,
    );
  }
}

function summarizeComposeContainerStatuses(
  containers: readonly ProjectComposeContainer[],
): ServiceStatusSnapshot[] {
  const statuses = new Map<string, ServiceStatusSnapshot>();

  for (const container of containers) {
    if (!container.service) {
      continue;
    }

    const previous = statuses.get(container.service);
    statuses.set(container.service, {
      service: container.service,
      serviceStatus: combineServiceStatuses(
        previous?.serviceStatus ?? "",
        container.serviceStatus,
      ),
      healthStatus: combineHealthStatuses(
        previous?.healthStatus ?? "",
        container.healthStatus,
      ),
    });
  }

  return [...statuses.values()];
}

function combineServiceStatuses(
  current: ProjectComposeServiceStatus | "",
  next: ProjectComposeServiceStatus,
): ProjectComposeServiceStatus {
  const currentRank = rankServiceStatus(current);
  const nextRank = rankServiceStatus(next);

  return nextRank > currentRank ? next : current || next;
}

function rankServiceStatus(status: ProjectComposeServiceStatus | ""): number {
  if (status === "starting") {
    return 4;
  }

  if (status === "stopping") {
    return 3;
  }

  if (status === "started") {
    return 2;
  }

  if (status === "stopped") {
    return 1;
  }

  return 0;
}

function combineHealthStatuses(
  current: ProjectComposeHealthStatus | "",
  next: ProjectComposeHealthStatus | "",
): ProjectComposeHealthStatus | "" {
  const currentRank = rankHealthStatus(current);
  const nextRank = rankHealthStatus(next);

  return nextRank > currentRank ? next : current || next;
}

function rankHealthStatus(status: ProjectComposeHealthStatus | ""): number {
  if (status === "degraded") {
    return 3;
  }

  if (status === "starting") {
    return 2;
  }

  if (status === "healthy") {
    return 1;
  }

  return 0;
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
