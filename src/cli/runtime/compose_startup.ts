import { parse as parseYaml } from "@std/yaml";
import { inputError } from "../errors.ts";
import type { ProjectComposeHealthStatus } from "./compose_events.ts";
import {
  type ComposeConfigDiscovery,
  readComposeConfig,
} from "./compose_files.ts";
import type { ProcessCommand } from "./process.ts";

type ComposeProject = {
  name: string;
  workingDir: string;
};

type ComposeDependencyCondition = "service_started" | "service_healthy";

type ComposeServiceDependency = {
  service: string;
  condition: ComposeDependencyCondition;
};

type ComposeStartupStopWhenUnstartable = "" | "all";
type ComposeStartupMode = "startup" | "watcher";

type ComposeStartupPolicy = {
  mode: ComposeStartupMode;
  requiredServices: readonly string[];
  stopWhenUnstartable: ComposeStartupStopWhenUnstartable;
};

export type ComposeStartupConfig = {
  dependencies: ReadonlyMap<string, readonly ComposeServiceDependency[]>;
  policy: ComposeStartupPolicy;
  services: readonly string[];
};

export type ComposeStartupServiceStatus =
  | "starting"
  | "started"
  | "stopping"
  | "stopped";

export type ComposeStartupServiceState = {
  everStarted: boolean;
  health: ProjectComposeHealthStatus | "";
  status: ComposeStartupServiceStatus;
};

type ComposeStartupClassification =
  | "waiting"
  | "started"
  | "failed"
  | "blocked_terminal";

type ComposeStartupTracker = {
  abortReason(): string;
  recordHealth(service: string, status: ProjectComposeHealthStatus): void;
  recordService(service: string, status: ComposeStartupServiceStatus): void;
};

export async function createComposeStartupTracker(
  project: ComposeProject,
  runProcess: (
    command: ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
): Promise<ComposeStartupTracker | undefined> {
  const config = await readComposeStartupConfig(project, runProcess);
  if (!config) {
    return undefined;
  }
  const state = new Map<string, ComposeStartupServiceState>(
    config.services.map((service) => [
      service,
      createComposeStartupServiceState(),
    ]),
  );

  return {
    abortReason() {
      return evaluateComposeStartupPolicy(config, state);
    },
    recordHealth(service, status) {
      const serviceState = state.get(service);
      if (!serviceState) {
        return;
      }

      serviceState.health = status;
    },
    recordService(service, status) {
      const serviceState = state.get(service);
      if (!serviceState) {
        return;
      }

      if (status === "started") {
        serviceState.everStarted = true;
      }

      serviceState.status = status;
    },
  };
}

export async function readComposeStartupConfig(
  project: ComposeProject,
  runProcess: (
    command: ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
): Promise<ComposeStartupConfig | undefined> {
  const discovery = await readComposeConfig(project, runProcess);
  if (discovery.kind === "missing-compose-file") {
    return undefined;
  }

  if (discovery.kind === "error") {
    throw inputError(
      `Failed to initialize startup policy for ${project.name}: ${discovery.message}`,
    );
  }

  const config = parseComposeStartupConfig(discovery);
  if (
    config.policy.stopWhenUnstartable !== "all" &&
    config.policy.requiredServices.length === 0
  ) {
    return undefined;
  }

  return config;
}

function createComposeStartupServiceState(): ComposeStartupServiceState {
  return {
    everStarted: false,
    health: "",
    status: "starting",
  };
}

function parseComposeStartupConfig(
  discovery: Extract<ComposeConfigDiscovery, { kind: "config" }>,
): ComposeStartupConfig {
  const parsed = parseYaml(discovery.text);
  if (!isRecord(parsed)) {
    throw inputError("Invalid compose config: expected a mapping");
  }

  const servicesNode = getRecord(parsed.services);
  const serviceNames = Object.keys(servicesNode);
  const dependencies = new Map<string, readonly ComposeServiceDependency[]>();

  for (const [service, definition] of Object.entries(servicesNode)) {
    dependencies.set(
      service,
      parseComposeServiceDependencies(getRecord(definition)),
    );
  }

  const policy = parseComposeStartupPolicy(parsed, serviceNames);
  return {
    dependencies,
    policy,
    services: serviceNames,
  };
}

function parseComposeStartupPolicy(
  config: Record<string, unknown>,
  services: readonly string[],
): ComposeStartupPolicy {
  const extension = getRecord(config["x-pm3"]);
  const startup = getRecord(extension.startup);
  const mode = startup.mode === "watcher" ? "watcher" : "startup";
  const stopWhenUnstartable =
    startup.stop_when_unstartable === "all" ? "all" : "";
  const requiredServices = Array.isArray(startup.required_services)
    ? startup.required_services.filter(
        (service): service is string =>
          typeof service === "string" && service.length > 0,
      )
    : [];

  const unknownRequired = requiredServices.filter(
    (service) => !services.includes(service),
  );
  if (unknownRequired.length > 0) {
    throw inputError(
      `Unknown x-pm3.startup.required_services entries: ${unknownRequired.join(
        ", ",
      )}`,
    );
  }

  return {
    mode,
    requiredServices,
    stopWhenUnstartable,
  };
}

export function evaluateComposeStartupPolicy(
  config: ComposeStartupConfig,
  state: ReadonlyMap<string, ComposeStartupServiceState>,
): string {
  const classifications = classifyComposeStartup(config, state);
  const requiredBlocked = config.policy.requiredServices.filter((service) =>
    isTerminalClassification(classifications.get(service) ?? "waiting"),
  );
  if (requiredBlocked.length > 0) {
    return `Required services permanently unstartable: ${requiredBlocked.join(
      ", ",
    )}`;
  }

  if (config.policy.stopWhenUnstartable !== "all") {
    return "";
  }

  const remaining = config.services.filter(
    (service) => (classifications.get(service) ?? "waiting") !== "started",
  );
  if (
    remaining.length > 0 &&
    remaining.every((service) =>
      isTerminalClassification(classifications.get(service) ?? "waiting"),
    )
  ) {
    return `Startup permanently blocked: ${remaining.join(", ")}`;
  }

  return "";
}

function parseComposeServiceDependencies(
  service: Record<string, unknown>,
): readonly ComposeServiceDependency[] {
  const dependsOn = service.depends_on;
  if (Array.isArray(dependsOn)) {
    return dependsOn.flatMap((dependency) =>
      typeof dependency === "string" && dependency.length > 0
        ? [{ service: dependency, condition: "service_started" as const }]
        : [],
    );
  }

  const dependencyMap = getRecord(dependsOn);
  return Object.entries(dependencyMap).flatMap(([dependency, value]) => {
    const condition = parseComposeDependencyCondition(value);
    return condition ? [{ service: dependency, condition }] : [];
  });
}

function parseComposeDependencyCondition(
  value: unknown,
): ComposeDependencyCondition | "" {
  if (typeof value === "string") {
    return value === "service_healthy" || value === "service_started"
      ? value
      : "";
  }

  const definition = getRecord(value);
  const condition = definition.condition;
  return condition === "service_healthy" || condition === "service_started"
    ? condition
    : "";
}

function classifyComposeStartup(
  config: ComposeStartupConfig,
  state: ReadonlyMap<string, ComposeStartupServiceState>,
): Map<string, ComposeStartupClassification> {
  const classifications = new Map<string, ComposeStartupClassification>();

  for (const service of config.services) {
    classifyComposeStartupService(
      config,
      state,
      classifications,
      service,
      new Set<string>(),
    );
  }

  return classifications;
}

function classifyComposeStartupService(
  config: ComposeStartupConfig,
  state: ReadonlyMap<string, ComposeStartupServiceState>,
  classifications: Map<string, ComposeStartupClassification>,
  service: string,
  chain: Set<string>,
): ComposeStartupClassification {
  const cached = classifications.get(service);
  if (cached) {
    return cached;
  }

  const serviceState = state.get(service);
  if (config.policy.mode === "startup" && serviceState?.everStarted) {
    classifications.set(service, "started");
    return "started";
  }

  if (
    serviceState?.status === "stopping" ||
    serviceState?.status === "stopped"
  ) {
    classifications.set(service, "failed");
    return "failed";
  }

  if (chain.has(service)) {
    classifications.set(service, "waiting");
    return "waiting";
  }

  chain.add(service);
  const dependencies = config.dependencies.get(service) ?? [];
  const blocked = dependencies.some((dependency) =>
    isComposeDependencyTerminal(
      config,
      state,
      classifications,
      service,
      dependency,
      chain,
    ),
  );
  chain.delete(service);

  if (blocked) {
    classifications.set(service, "blocked_terminal");
    return "blocked_terminal";
  }

  if (serviceState?.everStarted) {
    classifications.set(service, "started");
    return "started";
  }

  const classification = "waiting";
  classifications.set(service, classification);
  return classification;
}

function isComposeDependencyTerminal(
  config: ComposeStartupConfig,
  state: ReadonlyMap<string, ComposeStartupServiceState>,
  classifications: Map<string, ComposeStartupClassification>,
  consumer: string,
  dependency: ComposeServiceDependency,
  chain: Set<string>,
): boolean {
  const dependencyState = state.get(dependency.service);
  const dependencyClassification = classifyComposeStartupService(
    config,
    state,
    classifications,
    dependency.service,
    chain,
  );

  if (
    dependencyClassification === "failed" ||
    dependencyClassification === "blocked_terminal"
  ) {
    return true;
  }

  if (dependency.condition === "service_started") {
    return (
      (dependencyState?.status === "stopping" ||
        dependencyState?.status === "stopped") &&
      !state.get(consumer)?.everStarted
    );
  }

  return (
    dependencyState?.health === "degraded" ||
    dependencyState?.status === "stopping" ||
    dependencyState?.status === "stopped"
  );
}

function isTerminalClassification(
  classification: ComposeStartupClassification,
): boolean {
  return classification === "failed" || classification === "blocked_terminal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
