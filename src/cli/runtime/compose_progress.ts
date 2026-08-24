import { parse as parseYaml } from "@std/yaml";
import type { RunCommandOptions } from "../commands.ts";
import { inputError } from "../errors.ts";
import { green, red, yellow } from "../output/color.ts";
import type { LoaderLine } from "../output/loader.ts";
import {
  getComposeEventService,
  getComposeHealthStatus,
  getComposeServiceStatus,
  type PodmanEvent,
  parsePodmanEvent,
} from "./compose_events.ts";
import {
  createPodmanComposeArgs,
  listComposeServices,
  PODMAN_COMMAND,
  PODMAN_COMPOSE_COMMAND,
  readComposeConfig,
} from "./compose_files.ts";
import { parseComposeContainerJson } from "./compose_ps.ts";

const EVENT_STREAM_STOP_GRACE_MS = 150;
const HEALTH_SETTLE_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_INTERVAL_MS = 30_000;
const DEFAULT_HEALTH_RETRIES = 3;
const DEFAULT_HEALTH_START_PERIOD_MS = 0;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const INFINITE_RETRY_ATTEMPTS = 3;
const HEALTH_STATUS_POLL_INTERVAL_MS = 1_000;

type ComposeProject = {
  composeArgs?: readonly string[];
  name: string;
  workingDir: string;
};

export function getComposeOperation(args: readonly string[]): string {
  if (args.includes("build")) {
    return "Building";
  }

  if (isComposeStopOperation(args)) {
    return "Stopping";
  }

  if (args.includes("down")) {
    return "Removing";
  }

  if (args.includes("stop")) {
    return "Stopping";
  }

  return "Starting";
}

type ComposeOperation = ReturnType<typeof getComposeOperation>;

type ComposeProgressHealthStatus =
  | "starting"
  | "healthy"
  | "degraded"
  | "timed_out";

type ComposeHealthWaitPolicy = {
  waitMs: number;
};

export type ComposeProgress = {
  captureComposeCommands: boolean;
  unhealthyServices(): readonly string[];
  shownNoticeCount(): number;
  stop(): Promise<void>;
  writeComposeOutput(text: string): void;
};

export function createEmptyComposeProgress(): ComposeProgress {
  return {
    captureComposeCommands: false,
    unhealthyServices: () => [],
    shownNoticeCount: () => 0,
    stop: () => Promise.resolve(),
    writeComposeOutput: () => {},
  };
}

export async function startComposeProgress(
  project: ComposeProject,
  operation: ComposeOperation,
  options: RunCommandOptions,
  output: ComposeOutput,
  progressOptions: ComposeProgressOptions = {},
): Promise<ComposeProgress> {
  if (
    operation === "Building" ||
    (options.runProcess && !options.runLineStream)
  ) {
    return createEmptyComposeProgress();
  }

  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const serviceDiscovery = await listComposeServices(project, runProcess);
  if (serviceDiscovery.kind === "missing-compose-file") {
    return createEmptyComposeProgress();
  }

  if (serviceDiscovery.kind === "error") {
    if (shouldTrackComposeHealth(operation)) {
      throw inputError(
        `Failed to initialize compose health tracking for ${project.name}: ${serviceDiscovery.message}`,
      );
    }

    return createEmptyComposeProgress();
  }

  const services = serviceDiscovery.services;
  if (services.length === 0) {
    return createEmptyComposeProgress();
  }

  const finished = new Set<string>();
  const healthStarted = new Set<string>();
  const healthLines = new Map<string, string>();
  const healthStatuses = new Map<string, ComposeProgressHealthStatus>();
  const healthWaitPolicies = shouldTrackComposeHealth(operation)
    ? await readComposeHealthWaitPolicies(project, runProcess)
    : new Map<string, ComposeHealthWaitPolicy>();
  const healthStartedAt = new Map<string, number>();
  const unhealthy = new Set<string>();
  let pendingHealthSettlement:
    | { promise: Promise<void>; resolve: () => void }
    | undefined;
  const refreshSettledHealthPromise = () => {
    if (![...healthStatuses.values()].some((status) => status === "starting")) {
      pendingHealthSettlement?.resolve();
      pendingHealthSettlement = undefined;
      return;
    }

    if (!pendingHealthSettlement) {
      let resolveSettlement = () => {};
      const promise = new Promise<void>((resolve) => {
        resolveSettlement = resolve;
      });
      pendingHealthSettlement = { promise, resolve: resolveSettlement };
    }
  };
  const started = new Set<string>();
  const serviceNames = new Set(services);
  for (const service of services) {
    startComposeServiceProgress(
      project.name,
      operation,
      started,
      service,
      output,
    );
  }

  const { runSystemLineStream } = await import("./process.ts");
  const runLineStream = options.runLineStream ?? runSystemLineStream;
  const stream = await runLineStream(
    {
      command: PODMAN_COMMAND,
      args: [
        "events",
        "--format",
        "json",
        "--filter",
        "type=container",
        "--filter",
        `label=com.docker.compose.project.working_dir=${project.workingDir}`,
        "--since",
        new Date().toISOString(),
      ],
    },
    (line) => {
      const event = parsePodmanEvent(line);
      const service = getComposeEventService(event);
      if (!service || !serviceNames.has(service)) {
        return;
      }

      if (isComposeServiceEventComplete(operation, event)) {
        finishComposeProgress(
          project.name,
          operation,
          finished,
          started,
          service,
          output,
        );
        if (
          shouldTrackComposeHealth(operation) &&
          healthWaitPolicies.has(service)
        ) {
          ensureComposeHealthProgress(
            project.name,
            healthStarted,
            healthLines,
            healthStatuses,
            healthStartedAt,
            service,
            output,
          );
          refreshSettledHealthPromise();
        }
      }

      const serviceStatus = getComposeServiceStatus(event);
      if (serviceStatus) {
        progressOptions.onServiceChange?.(service, serviceStatus);
      }

      const healthStatus = shouldTrackComposeHealth(operation)
        ? getComposeHealthStatus(event)
        : "";
      if (!healthStatus) {
        return;
      }

      if (!finished.has(service)) {
        return;
      }

      const changed = updateComposeHealthProgress(
        project.name,
        getFinishedComposeOperation(operation),
        healthStarted,
        healthLines,
        healthStatuses,
        healthStartedAt,
        unhealthy,
        service,
        healthStatus,
        output,
      );
      if (!changed) {
        return;
      }

      refreshSettledHealthPromise();

      progressOptions.onHealthChange?.(service, healthStatus);
      if (healthStatus === "degraded") {
        progressOptions.onUnhealthy?.(service);
      }
    },
  );
  let composeOutput = "";
  let shownNoticeCount = 0;
  let lastCommandService = "";

  return {
    captureComposeCommands: !options.verbose,
    unhealthyServices: () => [...unhealthy],
    shownNoticeCount: () => shownNoticeCount,
    async stop() {
      if (shouldTrackComposeHealth(operation)) {
        await seedComposeHealthProgressAtStop(
          project,
          runProcess,
          healthStarted,
          healthLines,
          healthStatuses,
          healthStartedAt,
          healthWaitPolicies,
          output,
        );
        await settleComposeHealthProgress(
          project,
          runProcess,
          project.name,
          healthLines,
          healthStatuses,
          healthStartedAt,
          healthWaitPolicies,
          output,
          refreshSettledHealthPromise,
        );
        finalizePendingComposeHealthAsTimedOut(
          project.name,
          healthLines,
          healthStatuses,
          output,
        );
      }
      await delay(EVENT_STREAM_STOP_GRACE_MS);
      await stream.stop();
    },
    writeComposeOutput(text: string) {
      if (options.verbose) {
        return;
      }

      composeOutput += text;
      const lines = composeOutput.split(/\r?\n/);
      composeOutput = lines.pop() ?? "";

      for (const line of lines) {
        const service = getComposeCommandService(operation, services, line);
        if (service) {
          lastCommandService = service;
          startComposeServiceProgress(
            project.name,
            operation,
            started,
            service,
            output,
          );
        }

        if (!isComposeNoticeLine(line)) {
          continue;
        }

        const formattedNotice = formatComposeNoticeLine(line);
        const noticeService =
          getComposeNoticeService(services, line) || lastCommandService;
        if (noticeService) {
          startComposeServiceProgress(
            project.name,
            operation,
            started,
            noticeService,
            output,
          );
          output.writeLineAfter(
            formatComposeProgressLineId(project.name, noticeService),
            createLoaderLine(
              formattedNotice,
              `notice:${project.name}/${noticeService}:${shownNoticeCount}`,
            ),
          );
        } else {
          output.writeLine(
            createLoaderLine(formattedNotice, `notice:${shownNoticeCount}`),
          );
        }

        shownNoticeCount += 1;
      }
    },
  };
}

async function seedComposeHealthProgressAtStop(
  project: ComposeProject,
  runProcess: (
    command: import("./process.ts").ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
  started: Set<string>,
  lines: Map<string, string>,
  statuses: Map<string, ComposeProgressHealthStatus>,
  startedAt: Map<string, number>,
  waitPolicies: ReadonlyMap<string, ComposeHealthWaitPolicy>,
  output: ComposeOutput,
): Promise<void> {
  const currentStatuses = await readCurrentComposeHealthStatuses(
    project,
    runProcess,
  );

  for (const service of waitPolicies.keys()) {
    const currentStatus = currentStatuses.get(service);
    if (currentStatus === "healthy" || currentStatus === "degraded") {
      if (statuses.get(service) === "starting") {
        statuses.set(service, currentStatus);
        startedAt.delete(service);
        const finishedLine = formatComposeHealthFinishedLine(currentStatus);
        output.finishLine(
          formatComposeHealthLineId(project.name, service),
          finishedLine,
        );
        lines.set(service, finishedLine);
      }
      continue;
    }

    if (!statuses.has(service)) {
      ensureComposeHealthProgress(
        project.name,
        started,
        lines,
        statuses,
        startedAt,
        service,
        output,
      );
    }
  }
}

type ComposeProgressOptions = {
  onHealthChange?: (
    service: string,
    status: "starting" | "healthy" | "degraded",
  ) => void;
  onServiceChange?: (
    service: string,
    status: "starting" | "started" | "stopping" | "stopped",
  ) => void;
  onUnhealthy?: (service: string) => void;
};

function isComposeServiceEventComplete(
  operation: ComposeOperation,
  event: PodmanEvent | undefined,
): boolean {
  const status = event?.Status;

  if (operation === "Removing") {
    return status === "remove";
  }

  if (operation === "Stopping") {
    return status === "stop" || status === "died" || status === "remove";
  }

  return status === "start";
}

function isComposeStopOperation(args: readonly string[]): boolean {
  return (
    args[0] === "down" &&
    args.includes("--remove-orphans") &&
    !args.includes("--volumes") &&
    !args.includes("--rmi")
  );
}

function shouldTrackComposeHealth(operation: ComposeOperation): boolean {
  return operation === "Starting";
}

function getComposeCommandService(
  operation: ComposeOperation,
  services: readonly string[],
  line: string,
): string {
  const normalized = line.trim();
  const commands = getPodmanCommandsForOperation(operation);

  if (!commands.some((command) => normalized.includes(`podman ${command} `))) {
    return "";
  }

  return findServiceInComposeLine(services, normalized);
}

function getPodmanCommandsForOperation(
  operation: ComposeOperation,
): readonly string[] {
  if (operation === "Starting") {
    return ["start"];
  }

  if (operation === "Stopping") {
    return ["stop"];
  }

  if (operation === "Removing") {
    return ["stop", "rm"];
  }

  return [];
}

function startComposeServiceProgress(
  projectName: string,
  operation: ComposeOperation,
  started: Set<string>,
  service: string,
  output: ComposeOutput,
): void {
  if (started.has(service)) {
    return;
  }

  started.add(service);
  output.startLine(createComposeProgressLine(projectName, operation, service));
}

function finishComposeProgress(
  projectName: string,
  operation: ComposeOperation,
  finished: Set<string>,
  started: Set<string>,
  service: string,
  output: ComposeOutput,
): void {
  if (finished.has(service)) {
    return;
  }

  const line = formatComposeProgressLine(projectName, operation, service);
  const finishedLine = formatComposeProgressLine(
    projectName,
    getFinishedComposeOperation(operation),
    service,
  );
  if (!started.has(service)) {
    started.add(service);
    output.startLine(
      createLoaderLine(line, formatComposeProgressLineId(projectName, service)),
    );
  }

  finished.add(service);
  output.finishLine(
    formatComposeProgressLineId(projectName, service),
    finishedLine,
  );
}

function updateComposeHealthProgress(
  projectName: string,
  _parentOperation: string,
  started: Set<string>,
  lines: Map<string, string>,
  statuses: Map<string, ComposeProgressHealthStatus>,
  startedAt: Map<string, number>,
  unhealthy: Set<string>,
  service: string,
  status: "starting" | "healthy" | "degraded",
  output: ComposeOutput,
): boolean {
  const previousStatus = statuses.get(service);
  if (previousStatus && previousStatus !== "starting") {
    return false;
  }

  if (previousStatus === status) {
    return false;
  }

  statuses.set(service, status);
  const lineId = formatComposeHealthLineId(projectName, service);
  const line = lines.get(service) ?? formatComposeHealthPendingLine();
  if (!started.has(service)) {
    started.add(service);
    output.startLineAfter(
      formatComposeProgressLineId(projectName, service),
      createLoaderLine(line, lineId),
    );
    lines.set(service, line);
  }

  if (status === "starting") {
    startedAt.set(service, startedAt.get(service) ?? Date.now());
    return true;
  }

  startedAt.delete(service);
  const finishedLine = formatComposeHealthFinishedLine(status);
  output.finishLine(lineId, finishedLine);
  lines.set(service, finishedLine);

  if (status === "degraded") {
    unhealthy.add(service);
    return true;
  }

  unhealthy.delete(service);
  return true;
}

function ensureComposeHealthProgress(
  projectName: string,
  _started: Set<string>,
  lines: Map<string, string>,
  statuses: Map<string, ComposeProgressHealthStatus>,
  startedAt: Map<string, number>,
  service: string,
  output: ComposeOutput,
): void {
  if (statuses.has(service)) {
    return;
  }

  statuses.set(service, "starting");
  startedAt.set(service, Date.now());
  const line = formatComposeHealthPendingLine();
  output.startLineAfter(
    formatComposeProgressLineId(projectName, service),
    createLoaderLine(line, formatComposeHealthLineId(projectName, service)),
  );
  lines.set(service, line);
}

function formatComposeProgressLine(
  projectName: string,
  operation: string,
  service: string,
): string {
  return `${operation} ${projectName}/${service}`;
}

function createComposeProgressLine(
  projectName: string,
  operation: string,
  service: string,
): LoaderLine {
  const text = formatComposeProgressLine(projectName, operation, service);
  return createLoaderLine(
    text,
    formatComposeProgressLineId(projectName, service),
  );
}

function formatComposeProgressLineId(
  projectName: string,
  service: string,
): string {
  return `progress:${projectName}/${service}`;
}

function formatComposeHealthLineId(
  projectName: string,
  service: string,
): string {
  return `health:${projectName}/${service}`;
}

function formatComposeHealthPendingLine(): string {
  return yellow("Checking health");
}

function formatComposeHealthFinishedLine(
  status: ComposeProgressHealthStatus,
): string {
  if (status === "healthy") {
    return green("Healthy");
  }

  if (status === "degraded") {
    return red("Unhealthy");
  }

  if (status === "timed_out") {
    return yellow("Healthcheck timeout");
  }

  return formatComposeHealthPendingLine();
}

function getFinishedComposeOperation(operation: ComposeOperation): string {
  if (operation === "Starting") {
    return "Started";
  }

  if (operation === "Stopping") {
    return "Stopped";
  }

  if (operation === "Removing") {
    return "Removed";
  }

  return operation;
}

function getComposeNoticeService(
  services: readonly string[],
  line: string,
): string {
  return findServiceInComposeLine(services, line);
}

function findServiceInComposeLine(
  services: readonly string[],
  line: string,
): string {
  return (
    [...services]
      .sort((left, right) => right.length - left.length)
      .find((service) => line.includes(`_${service}_`)) ?? ""
  );
}

export function isComposeNoticeLine(line: string): boolean {
  const level = parseComposeLogLevel(line);
  if (level) {
    return /^(?:err(?:or)?|warn(?:ing)?|critical|fatal|panic)$/.test(level);
  }

  return /\b(?:err(?:or)?|warn(?:ing)?)\b/i.test(line);
}

function parseComposeLogLevel(line: string): string | undefined {
  const loggerPrefix =
    /^\s*(trace|debug|info|warn(?:ing)?|err(?:or)?|critical|fatal|panic):/i.exec(
      line,
    );
  if (loggerPrefix) {
    return loggerPrefix[1].toLowerCase();
  }

  const logfmtLevel = /\blevel=["']?([a-z]+)(?:["']|\b)/i.exec(line);
  return logfmtLevel?.[1].toLowerCase();
}

function formatComposeNoticeLine(line: string): string {
  return yellow(formatComposeNoticeText(line));
}

function formatComposeNoticeText(line: string): string {
  return parsePodmanLogMessage(line) ?? line.trim();
}

function parsePodmanLogMessage(line: string): string | undefined {
  if (!/\blevel=warn(?:ing)?\b/i.test(line)) {
    return undefined;
  }

  const match = /\bmsg="((?:\\.|[^"\\])*)"/.exec(line);
  return match ? unescapeLogfmtQuotedValue(match[1]) : undefined;
}

function unescapeLogfmtQuotedValue(value: string): string {
  return value.replace(/\\(["\\nrt])/g, (_match, escaped: string) => {
    if (escaped === "n") {
      return "\n";
    }

    if (escaped === "r") {
      return "\r";
    }

    if (escaped === "t") {
      return "\t";
    }

    return escaped;
  });
}

type ComposeOutput = {
  finishLine(lineId: string, finishedLine: string): void;
  startLineAfter(parentLineId: string, line: LoaderLine): void;
  startLine(line: LoaderLine): void;
  writeLine(line: LoaderLine): void;
  writeLineAfter(parentLineId: string, line: LoaderLine): void;
};

function createLoaderLine(text: string, id = text): LoaderLine {
  return {
    id,
    text,
  };
}

async function settleComposeHealthProgress(
  project: ComposeProject,
  runProcess: (
    command: import("./process.ts").ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
  projectName: string,
  lines: Map<string, string>,
  statuses: Map<string, ComposeProgressHealthStatus>,
  startedAt: Map<string, number>,
  waitPolicies: ReadonlyMap<string, ComposeHealthWaitPolicy>,
  output: ComposeOutput,
  refreshSettledHealthPromise: () => void,
): Promise<void> {
  while (true) {
    await reconcileComposeHealthProgress(
      project,
      runProcess,
      projectName,
      lines,
      statuses,
      startedAt,
      output,
    );
    finalizeExpiredComposeHealth(
      projectName,
      lines,
      statuses,
      startedAt,
      waitPolicies,
      output,
      Date.now(),
    );
    refreshSettledHealthPromise();

    const nextDeadline = getNextComposeHealthDeadline(
      statuses,
      startedAt,
      waitPolicies,
    );
    if (nextDeadline === undefined) {
      return;
    }

    await delay(
      Math.max(
        0,
        Math.min(HEALTH_STATUS_POLL_INTERVAL_MS, nextDeadline - Date.now()),
      ),
    );
  }
}

async function reconcileComposeHealthProgress(
  project: ComposeProject,
  runProcess: (
    command: import("./process.ts").ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
  projectName: string,
  lines: Map<string, string>,
  statuses: Map<string, ComposeProgressHealthStatus>,
  startedAt: Map<string, number>,
  output: ComposeOutput,
): Promise<void> {
  const currentStatuses = await readCurrentComposeHealthStatuses(
    project,
    runProcess,
  );

  for (const [service, status] of currentStatuses) {
    if (statuses.get(service) !== "starting") {
      continue;
    }

    if (status !== "healthy" && status !== "degraded") {
      continue;
    }

    statuses.set(service, status);
    startedAt.delete(service);
    const finishedLine = formatComposeHealthFinishedLine(status);
    output.finishLine(
      formatComposeHealthLineId(projectName, service),
      finishedLine,
    );
    lines.set(service, finishedLine);
  }
}

function finalizeExpiredComposeHealth(
  projectName: string,
  lines: Map<string, string>,
  statuses: Map<string, ComposeProgressHealthStatus>,
  startedAt: ReadonlyMap<string, number>,
  waitPolicies: ReadonlyMap<string, ComposeHealthWaitPolicy>,
  output: ComposeOutput,
  now: number,
): void {
  for (const [service, status] of statuses) {
    if (status !== "starting") {
      continue;
    }

    const startedAtMs = startedAt.get(service);
    const waitMs =
      waitPolicies.get(service)?.waitMs ?? HEALTH_SETTLE_TIMEOUT_MS;
    if (startedAtMs === undefined || startedAtMs + waitMs > now) {
      continue;
    }

    statuses.set(service, "timed_out");
    const finishedLine = formatComposeHealthFinishedLine("timed_out");
    output.finishLine(
      formatComposeHealthLineId(projectName, service),
      finishedLine,
    );
    lines.set(service, finishedLine);
  }
}

function finalizePendingComposeHealthAsTimedOut(
  projectName: string,
  lines: Map<string, string>,
  statuses: Map<string, ComposeProgressHealthStatus>,
  output: ComposeOutput,
): void {
  for (const [service, status] of statuses) {
    if (status !== "starting") {
      continue;
    }

    statuses.set(service, "timed_out");
    const finishedLine = formatComposeHealthFinishedLine("timed_out");
    output.finishLine(
      formatComposeHealthLineId(projectName, service),
      finishedLine,
    );
    lines.set(service, finishedLine);
  }
}

function getNextComposeHealthDeadline(
  statuses: ReadonlyMap<string, ComposeProgressHealthStatus>,
  startedAt: ReadonlyMap<string, number>,
  waitPolicies: ReadonlyMap<string, ComposeHealthWaitPolicy>,
): number | undefined {
  let nextDeadline: number | undefined;

  for (const [service, status] of statuses) {
    if (status !== "starting") {
      continue;
    }

    const startedAtMs = startedAt.get(service);
    const waitMs =
      waitPolicies.get(service)?.waitMs ?? HEALTH_SETTLE_TIMEOUT_MS;
    const deadline = (startedAtMs ?? Date.now()) + waitMs;
    nextDeadline =
      nextDeadline === undefined ? deadline : Math.min(nextDeadline, deadline);
  }

  return nextDeadline;
}

async function readComposeHealthWaitPolicies(
  project: ComposeProject,
  runProcess: (
    command: import("./process.ts").ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
): Promise<Map<string, ComposeHealthWaitPolicy>> {
  const discovery = await readComposeConfig(project, runProcess);
  if (discovery.kind !== "config") {
    return new Map();
  }

  const parsed = parseYaml(discovery.text);
  if (!isRecord(parsed)) {
    return new Map();
  }

  const services = getRecord(parsed.services);
  return new Map(
    Object.entries(services).flatMap(([service, config]) => {
      const policy = parseComposeHealthWaitPolicy(getRecord(config));
      return policy ? [[service, policy] as const] : [];
    }),
  );
}

async function readCurrentComposeHealthStatuses(
  project: ComposeProject,
  runProcess: (
    command: import("./process.ts").ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
): Promise<Map<string, "starting" | "healthy" | "degraded">> {
  const result = await runProcess({
    command: PODMAN_COMPOSE_COMMAND,
    args: createPodmanComposeArgs(project, ["ps", "--format", "json"]),
    cwd: project.workingDir,
    captureOutput: true,
  });

  if (result.code !== 0) {
    return new Map();
  }

  return new Map(
    parseComposeContainerJson(result.stdout ?? "")
      .filter(
        (
          container,
        ): container is typeof container & {
          healthStatus: "starting" | "healthy" | "degraded";
        } => Boolean(container.service && container.healthStatus),
      )
      .map((container) => [container.service, container.healthStatus] as const),
  );
}

function parseComposeHealthWaitPolicy(
  serviceConfig: Record<string, unknown>,
): ComposeHealthWaitPolicy | undefined {
  const healthcheck = getRecord(serviceConfig.healthcheck);
  if (Object.keys(healthcheck).length === 0) {
    return undefined;
  }

  const retries = parseComposeHealthRetries(healthcheck.retries);
  const attempts = retries === "infinite" ? INFINITE_RETRY_ATTEMPTS : retries;
  const intervalMs = parseComposeHealthDuration(
    healthcheck.interval,
    DEFAULT_HEALTH_INTERVAL_MS,
  );
  const timeoutMs = parseComposeHealthDuration(
    healthcheck.timeout,
    DEFAULT_HEALTH_TIMEOUT_MS,
  );
  const startPeriodMs = parseComposeHealthDuration(
    healthcheck.start_period,
    DEFAULT_HEALTH_START_PERIOD_MS,
  );

  return {
    waitMs: startPeriodMs + attempts * Math.max(intervalMs, timeoutMs),
  };
}

function parseComposeHealthRetries(value: unknown): number | "infinite" {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value <= 0 ? "infinite" : Math.floor(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const retries = Number(value.trim());
    return retries <= 0 ? "infinite" : retries;
  }

  return DEFAULT_HEALTH_RETRIES;
}

function parseComposeHealthDuration(
  value: unknown,
  fallbackMs: number,
): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value !== "string") {
    return fallbackMs;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "disable") {
    return fallbackMs;
  }

  const pattern = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  let total = 0;
  let consumed = 0;

  for (const match of normalized.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * getComposeDurationUnitMs(unit);
    consumed += match[0].length;
  }

  return consumed === normalized.length && total >= 0
    ? Math.ceil(total)
    : fallbackMs;
}

function getComposeDurationUnitMs(unit: string): number {
  if (unit === "h") {
    return 3_600_000;
  }

  if (unit === "m") {
    return 60_000;
  }

  if (unit === "s") {
    return 1_000;
  }

  if (unit === "ms") {
    return 1;
  }

  if (unit === "us" || unit === "µs") {
    return 0.001;
  }

  return 0.000001;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
