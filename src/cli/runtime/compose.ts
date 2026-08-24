import type { RunCommandOptions } from "../commands.ts";
import { inputError } from "../errors.ts";
import { blue, cyan, green, magenta, red, yellow } from "../output/color.ts";
import { startLoader } from "../output/loader.ts";
import {
  getComposeEventService,
  getComposeEventWorkingDir,
  getComposeHealthStatus,
  getComposeServiceStatus,
  type ProjectComposeHealthChange,
  type ProjectComposeHealthStatus,
  type ProjectComposeServiceChange,
  type ProjectComposeServiceStatus,
  parsePodmanEvent,
} from "./compose_events.ts";
import {
  createPodmanComposeArgs,
  hasComposeFile,
  PODMAN_COMMAND,
  PODMAN_COMPOSE_COMMAND,
} from "./compose_files.ts";
import {
  type ComposeProgress,
  createEmptyComposeProgress,
  getComposeOperation,
  startComposeProgress,
} from "./compose_progress.ts";
import {
  type ProjectComposeContainer,
  parseComposeContainerJson,
} from "./compose_ps.ts";
import { createComposeStartupTracker } from "./compose_startup.ts";
import type { ProcessCommand, ProcessResult } from "./process.ts";

export type {
  ProjectComposeContainer,
  ProjectComposeHealthChange,
  ProjectComposeHealthStatus,
  ProjectComposeServiceChange,
  ProjectComposeServiceStatus,
};

type ProjectComposeStatusEvent = {
  containerId: string;
  healthStatus: ProjectComposeHealthStatus | "";
  project: string;
  service: string;
  serviceStatus: ProjectComposeServiceStatus | "";
};

export const STOP_COMPOSE_ARGS = ["down", "--remove-orphans"] as const;

type ComposeProject = {
  composeFile?: string | null;
  name: string;
  workingDir: string;
};

export async function runProjectCompose(
  project: ComposeProject,
  args: readonly string[],
  options: RunCommandOptions,
  runOptions: ProjectComposeRunOptions = {},
): Promise<void> {
  const operation = getComposeOperation(args);
  const trackHealth = runOptions.trackHealth ?? true;
  const startupAbortController = new AbortController();
  const canAbortUnhealthy =
    trackHealth &&
    isHealthTrackedOperation(operation) &&
    (!options.runProcess || options.runLineStream);
  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const startupTracker = canAbortUnhealthy
    ? await createComposeStartupTracker(project, runProcess)
    : undefined;
  const failOnUnhealthy = canAbortUnhealthy && !startupTracker;
  const healthAbortController = canAbortUnhealthy
    ? new AbortController()
    : undefined;
  const result = await runComposeCommand(project, operation, args, options, {
    detached: runOptions.detached,
    detachSignal: isHealthTrackedOperation(operation)
      ? options.detachSignal
      : undefined,
    onHealthChange: (change) => {
      runOptions.onHealthChange?.(change);
      startupTracker?.recordHealth(change.service, change.status);
      if (startupTracker?.abortReason()) {
        startupAbortController.abort();
      }
    },
    onServiceChange: startupTracker
      ? (change) => {
          startupTracker.recordService(change.service, change.status);
          if (startupTracker.abortReason()) {
            startupAbortController.abort();
          }
        }
      : undefined,
    onUnhealthy: canAbortUnhealthy
      ? () => healthAbortController?.abort()
      : undefined,
    signal: canAbortUnhealthy
      ? combineAbortSignals(
          options.signal,
          healthAbortController?.signal,
          startupAbortController.signal,
        )
      : options.signal,
    trackHealth,
  });

  if (result.process.detached) {
    return;
  }

  if (result.process.code !== 0) {
    const startupAbortReason = startupTracker?.abortReason() ?? "";
    if (startupAbortReason) {
      await stopStartedComposeServices(project, options, {
        detached: runOptions.detached,
      });
      throw inputError(startupAbortReason);
    }

    const unhealthyServices = result.progress.unhealthyServices();
    if (failOnUnhealthy && unhealthyServices.length > 0) {
      await stopStartedComposeServices(project, options, {
        detached: runOptions.detached,
      });
      throw inputError(
        formatUnhealthyServices(project.name, unhealthyServices),
      );
    }
    if (unhealthyServices.length > 0) {
      return;
    }

    if (options.signal?.aborted && isHealthTrackedOperation(operation)) {
      await stopStartedComposeServices(project, options, {
        detached: runOptions.detached,
      });
    }

    throw inputError(formatComposeFailure(result.process));
  }

  const startupAbortReason = startupTracker?.abortReason() ?? "";
  if (startupAbortReason) {
    await stopStartedComposeServices(project, options, {
      detached: runOptions.detached,
    });
    throw inputError(startupAbortReason);
  }

  const unhealthyServices = result.progress.unhealthyServices();
  if (failOnUnhealthy && unhealthyServices.length > 0) {
    await stopStartedComposeServices(project, options, {
      detached: runOptions.detached,
    });
    throw inputError(formatUnhealthyServices(project.name, unhealthyServices));
  }

  const warnings = countWarnings(result.process);
  if (!runOptions.detached && warnings > result.progress.shownNoticeCount()) {
    console.log(`Finished with ${warnings} warnings`);
  }
}

export async function removeProjectComposeArtifacts(
  project: ComposeProject,
  options: RunCommandOptions,
  runOptions: ProjectComposeRunOptions = {},
): Promise<void> {
  if (!(await hasComposeFile(project))) {
    return;
  }

  await runProjectCompose(
    project,
    ["down", "--volumes", "--rmi", "all", "--remove-orphans"],
    options,
    runOptions,
  );
}

export async function streamProjectComposeLogs(
  project: ComposeProject,
  logsOptions: ProjectComposeLogsOptions,
  options: RunCommandOptions,
): Promise<void> {
  const serviceTargets = await resolveProjectLogTargets(
    project,
    logsOptions,
    options,
  );
  if (serviceTargets.length === 0) {
    throw inputError(
      `No compose containers found for project: ${project.name}`,
    );
  }
  const targetColors = createTargetColors(serviceTargets);

  if (logsOptions.once) {
    await printProjectLogsOnce(
      project,
      serviceTargets,
      logsOptions,
      options,
      targetColors,
    );
    return;
  }

  await followProjectLogs(project, serviceTargets, logsOptions, options);
}

export type ProjectComposeRunOptions = {
  detached?: boolean;
  onHealthChange?: (change: ProjectComposeHealthChange) => void;
  trackHealth?: boolean;
};

export type ProjectComposeLogsOptions = {
  services: readonly string[];
  since: string | undefined;
  lines: number | undefined;
  raw: boolean;
  once: boolean;
};

type ComposeLogTarget = {
  service: string;
  containerIds: string[];
};

type ComposeLogQueryOptions = ProjectComposeLogsOptions & {
  until?: string;
};

type ComposeLogRenderer = {
  write(service: string, line: string): void;
  finish(): Promise<void>;
};

async function resolveProjectLogTargets(
  project: ComposeProject,
  logsOptions: ProjectComposeLogsOptions,
  options: RunCommandOptions,
): Promise<ComposeLogTarget[]> {
  if (!(await hasComposeFile(project))) {
    throw inputError(`Compose file not found for project: ${project.name}`);
  }

  const containers = await listProjectComposeContainers(project, options);
  const containersByService = new Map<string, string[]>();

  for (const container of containers) {
    if (!container.service || !container.id) {
      continue;
    }

    const serviceContainers = containersByService.get(container.service) ?? [];
    serviceContainers.push(container.id);
    containersByService.set(container.service, serviceContainers);
  }

  const targetServices =
    logsOptions.services.length > 0
      ? logsOptions.services
      : [...containersByService.keys()];

  const missingServices = targetServices.filter(
    (service) => (containersByService.get(service) ?? []).length === 0,
  );
  if (missingServices.length > 0) {
    throw inputError(
      `No compose containers found for service: ${missingServices[0]}`,
    );
  }

  return targetServices.map((service) => ({
    service,
    containerIds: containersByService.get(service) ?? [],
  }));
}

async function printProjectLogsOnce(
  project: ComposeProject,
  targets: readonly ComposeLogTarget[],
  logsOptions: ComposeLogQueryOptions,
  options: RunCommandOptions,
  targetColors: ReadonlyMap<string, (value: string) => string>,
): Promise<void> {
  const linesByService = new Map<string, string[]>();

  await Promise.all(
    targets.map(async (target) => {
      linesByService.set(
        target.service,
        await collectTargetLogs(project, target, logsOptions, options),
      );
    }),
  );

  if (logsOptions.raw) {
    for (const target of targets) {
      const lines = linesByService.get(target.service) ?? [];
      for (const line of lines) {
        printRawLogLine(targets, targetColors, target.service, line);
      }
    }
    return;
  }

  printColumnHeader(targets, targetColors);
  const maxLines = Math.max(
    0,
    ...targets.map(
      (target) => (linesByService.get(target.service) ?? []).length,
    ),
  );
  for (let index = 0; index < maxLines; index += 1) {
    printColumnRow(
      targets,
      targets.map(
        (target) => (linesByService.get(target.service) ?? [])[index] ?? "",
      ),
    );
  }
}

async function followProjectLogs(
  project: ComposeProject,
  targets: readonly ComposeLogTarget[],
  logsOptions: ProjectComposeLogsOptions,
  options: RunCommandOptions,
): Promise<void> {
  const checkpoint = shouldPreloadLogHistory(logsOptions)
    ? new Date().toISOString()
    : undefined;
  const targetColors = createTargetColors(targets);

  if (checkpoint) {
    await printProjectLogsOnce(
      project,
      targets,
      createHistoricalLogsOptions(logsOptions, checkpoint),
      options,
      targetColors,
    );
  }

  const renderer = logsOptions.raw
    ? createRawLogRenderer(targets, targetColors)
    : createColumnLogRenderer(targets, targetColors, {
        printHeader: !checkpoint,
      });
  const followLogOptions = checkpoint
    ? createFollowLogsOptions(logsOptions, checkpoint)
    : logsOptions;

  const streams = targets.map((target) =>
    runLogStream(project, target, followLogOptions, options, (line) =>
      renderer.write(target.service, line),
    ),
  );

  try {
    await Promise.race([
      Promise.all(streams.map((stream) => stream.done)),
      waitForAbort(options.signal),
    ]);
  } finally {
    await Promise.all(streams.map((stream) => stream.stop()));
    await renderer.finish();
  }
}

async function collectTargetLogs(
  project: ComposeProject,
  target: ComposeLogTarget,
  logsOptions: ComposeLogQueryOptions,
  options: RunCommandOptions,
): Promise<string[]> {
  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const result = await runProcess({
    command: PODMAN_COMMAND,
    args: createPodmanLogsArgs(target, logsOptions, { follow: false }),
    cwd: project.workingDir,
    captureOutput: true,
    signal: options.signal,
  });

  if (result.code !== 0 && !options.signal?.aborted) {
    throw inputError(formatComposeFailure(result));
  }

  return sliceLogLinesFromEnd(
    splitOutputLines(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
    logsOptions.lines,
  );
}

function createRawLogRenderer(
  targets: readonly ComposeLogTarget[],
  targetColors: ReadonlyMap<string, (value: string) => string>,
): ComposeLogRenderer {
  const showPrefix = targets.length > 1;
  let output = Promise.resolve();

  return {
    write(service, line) {
      output = output.then(() => {
        printRawLogLine(targets, targetColors, service, line, showPrefix);
      });
    },
    finish() {
      return output;
    },
  };
}

function createColumnLogRenderer(
  targets: readonly ComposeLogTarget[],
  targetColors: ReadonlyMap<string, (value: string) => string>,
  renderOptions: { printHeader?: boolean } = {},
): ComposeLogRenderer {
  if (renderOptions.printHeader ?? true) {
    printColumnHeader(targets, targetColors);
  }
  let output = Promise.resolve();

  return {
    write(service, line) {
      output = output.then(() => {
        printColumnRow(
          targets,
          targets.map((target) => (target.service === service ? line : "")),
        );
      });
    },
    finish() {
      return output;
    },
  };
}

function printRawLogLine(
  targets: readonly ComposeLogTarget[],
  targetColors: ReadonlyMap<string, (value: string) => string>,
  service: string,
  line: string,
  showPrefix = targets.length > 1,
): void {
  const colorize = targetColors.get(service) ?? ((value: string) => value);
  console.log(showPrefix ? `${colorize(service)} | ${line}` : colorize(line));
}

function printColumnHeader(
  targets: readonly ComposeLogTarget[],
  targetColors: ReadonlyMap<string, (value: string) => string>,
): void {
  printColumnRow(
    targets,
    targets.map((target) =>
      (targetColors.get(target.service) ?? ((value: string) => value))(
        target.service,
      ),
    ),
  );
  printColumnRow(
    targets,
    targets.map(() => ""),
  );
}

function printColumnRow(
  targets: readonly ComposeLogTarget[],
  values: readonly string[],
): void {
  const widths = getLogColumnWidths(targets.length);
  const cells = values.map((value, index) =>
    fitColumnText(value, widths[index]),
  );
  console.log(cells.join(" | "));
}

function getLogColumnWidths(columnCount: number): number[] {
  const totalWidth = getConsoleWidth();
  const separatorWidth = Math.max(0, (columnCount - 1) * 3);
  const baseWidth = Math.max(
    12,
    Math.floor((totalWidth - separatorWidth) / Math.max(1, columnCount)),
  );

  return Array.from({ length: columnCount }, () => baseWidth);
}

function getConsoleWidth(): number {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return 120;
  }
}

function fitColumnText(value: string, width: number): string {
  const normalized = value.replaceAll("\t", " ").replaceAll("\r", "");
  const visibleLength = getVisibleTextLength(normalized);

  if (visibleLength <= width) {
    return `${normalized}${" ".repeat(width - visibleLength)}`;
  }

  if (width <= 3) {
    return truncateVisibleText(normalized, width);
  }

  return `${truncateVisibleText(normalized, width - 3)}...`;
}

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");
const ANSI_ESCAPE_PREFIX_PATTERN = new RegExp(`^${ANSI_ESCAPE}\\[[0-9;]*m`);

function getVisibleTextLength(value: string): number {
  return value.replaceAll(ANSI_ESCAPE_PATTERN, "").length;
}

function truncateVisibleText(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  let output = "";
  let visibleLength = 0;
  let index = 0;
  let usedAnsi = false;

  while (index < value.length && visibleLength < width) {
    const sequence = value.slice(index).match(ANSI_ESCAPE_PREFIX_PATTERN);
    if (sequence) {
      output += sequence[0];
      index += sequence[0].length;
      usedAnsi = true;
      continue;
    }

    output += value[index];
    index += 1;
    visibleLength += 1;
  }

  if (usedAnsi && !output.endsWith("\x1b[0m")) {
    output += "\x1b[0m";
  }

  return output;
}

function splitOutputLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.replaceAll("\r", ""))
    .filter((line) => line.length > 0);
}

function sliceLogLinesFromEnd(
  lines: readonly string[],
  count: number | undefined,
): string[] {
  if (count === undefined || lines.length <= count) {
    return [...lines];
  }

  return [...lines.slice(-count)];
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return await new Promise(() => {});
  }

  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

type LogStream = {
  done: Promise<void>;
  stop(): Promise<void>;
};

function runLogStream(
  project: ComposeProject,
  target: ComposeLogTarget,
  logsOptions: ProjectComposeLogsOptions,
  options: RunCommandOptions,
  onLine: (line: string) => void,
): LogStream {
  const process = new Deno.Command(PODMAN_COMMAND, {
    args: createPodmanLogsArgs(target, logsOptions, { follow: true }),
    cwd: project.workingDir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const child = process.spawn();
  let exited = false;
  const stop = async () => {
    if (!exited) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already be gone.
      }
    }

    await Promise.allSettled([status, stdoutDone, stderrDone]);
  };
  const abort = () => {
    void stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  const status = child.status.then((result) => {
    exited = true;
    if (result.code !== 0 && !options.signal?.aborted) {
      throw inputError(
        `${PODMAN_COMMAND} logs exited with code ${result.code}`,
      );
    }
  });
  const stdoutDone = readLogLines(child.stdout, onLine);
  const stderrDone = readLogLines(child.stderr, onLine);
  const done = Promise.all([status, stdoutDone, stderrDone])
    .then(() => {})
    .finally(() => {
      options.signal?.removeEventListener("abort", abort);
    });

  return {
    done,
    async stop() {
      await stop();
    },
  };
}

function createPodmanLogsArgs(
  target: ComposeLogTarget,
  logsOptions: ComposeLogQueryOptions,
  mode: { follow: boolean },
): string[] {
  const args = ["logs"];
  const since = getLogsSinceArgument(logsOptions);

  if (mode.follow) {
    args.push("--follow");
  }

  if (since) {
    args.push("--since", since);
  }

  if (logsOptions.until) {
    args.push("--until", logsOptions.until);
  }

  if (logsOptions.lines !== undefined) {
    args.push("--tail", String(logsOptions.lines));
  }

  if (target.containerIds.length > 1) {
    args.push("--names");
  }

  args.push(...target.containerIds);
  return args;
}

function getLogsSinceArgument(
  logsOptions: ComposeLogQueryOptions,
): string | undefined {
  if (logsOptions.since === "start") {
    return undefined;
  }

  if (logsOptions.since) {
    return logsOptions.since;
  }

  if (logsOptions.lines !== undefined) {
    return undefined;
  }

  return new Date().toISOString();
}

function shouldPreloadLogHistory(
  logsOptions: ProjectComposeLogsOptions,
): boolean {
  return logsOptions.lines !== undefined || logsOptions.since !== undefined;
}

function createHistoricalLogsOptions(
  logsOptions: ProjectComposeLogsOptions,
  until: string,
): ComposeLogQueryOptions {
  return {
    ...logsOptions,
    once: true,
    until,
  };
}

function createFollowLogsOptions(
  logsOptions: ProjectComposeLogsOptions,
  since: string,
): ComposeLogQueryOptions {
  return {
    ...logsOptions,
    since,
    lines: undefined,
  };
}

function createTargetColors(
  targets: readonly ComposeLogTarget[],
): ReadonlyMap<string, (value: string) => string> {
  const palette = [cyan, green, yellow, blue, magenta, red];

  return new Map(
    targets.map((target, index) => [
      target.service,
      palette[index % palette.length] ?? ((value: string) => value),
    ]),
  );
}

async function readLogLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      buffer = flushBufferedLines(buffer, onLine);
    }

    buffer += decoder.decode();
    if (buffer) {
      onLine(buffer.replaceAll("\r", ""));
    }
  } finally {
    reader.releaseLock();
  }
}

function flushBufferedLines(
  buffer: string,
  onLine: (line: string) => void,
): string {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";

  for (const line of lines) {
    onLine(line.replaceAll("\r", ""));
  }

  return remainder;
}

export async function listProjectComposeContainers(
  project: ComposeProject,
  options: RunCommandOptions,
): Promise<ProjectComposeContainer[]> {
  if (!(await hasComposeFile(project))) {
    return [];
  }

  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const result = await runProcess({
    command: PODMAN_COMPOSE_COMMAND,
    args: createPodmanComposeArgs(project, ["ps", "--format", "json"]),
    cwd: project.workingDir,
    captureOutput: true,
  });

  if (result.code !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `${PODMAN_COMPOSE_COMMAND} ps exited with code ${result.code}`,
    );
  }

  return parseComposeContainerJson(result.stdout ?? "");
}

export async function watchProjectComposeStatusChanges(
  getProjects: () => readonly ComposeProject[],
  options: RunCommandOptions,
  onChange: (change: ProjectComposeStatusEvent) => void,
): Promise<{ stop(): Promise<void> }> {
  if (options.runProcess && !options.runLineStream) {
    return { stop: () => Promise.resolve() };
  }

  const { runSystemLineStream } = await import("./process.ts");
  const runLineStream = options.runLineStream ?? runSystemLineStream;

  return await runLineStream(
    {
      command: PODMAN_COMMAND,
      args: [
        "events",
        "--format",
        "json",
        "--filter",
        "type=container",
        "--since",
        new Date().toISOString(),
      ],
    },
    (line) => {
      const event = parsePodmanEvent(line);
      const healthStatus = getComposeHealthStatus(event);
      const serviceStatus = getComposeServiceStatus(event);
      if (!healthStatus && !serviceStatus) {
        return;
      }

      const workingDir = getComposeEventWorkingDir(event);
      const project = workingDir
        ? findComposeProject(getProjects(), workingDir)
        : "";
      const service = getComposeEventService(event);
      if (!project || !service) {
        return;
      }

      onChange({
        healthStatus,
        project: project.name,
        service,
        serviceStatus,
        containerId: event?.ID ?? "",
      });
    },
  );
}

function findComposeProject(
  projects: readonly ComposeProject[],
  workingDir: string,
): ComposeProject | undefined {
  return projects.find((project) => project.workingDir === workingDir);
}

function formatComposeFailure(result: { stdout?: string; stderr?: string }) {
  return result.stderr || result.stdout || `${PODMAN_COMPOSE_COMMAND} failed`;
}

function isHealthTrackedOperation(operation: string): boolean {
  return operation === "Starting";
}

function createSilentComposeOutput() {
  return {
    finishLine: () => {},
    startLineAfter: () => {},
    startLine: () => {},
    writeLine: () => {},
    writeLineAfter: () => {},
  };
}

function combineAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const activeSignals = signals.filter((signal) => signal !== undefined);
  if (activeSignals.length === 0) {
    return undefined;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      break;
    }

    signal.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener(
      "abort",
      () => signal.removeEventListener("abort", abort),
      { once: true },
    );
  }

  return controller.signal;
}

async function stopStartedComposeServices(
  project: ComposeProject,
  options: RunCommandOptions,
  runOptions: ProjectComposeRunOptions = {},
): Promise<void> {
  const result = await runComposeCommand(
    project,
    getComposeOperation(STOP_COMPOSE_ARGS),
    STOP_COMPOSE_ARGS,
    {
      ...options,
      detachSignal: undefined,
      signal: undefined,
    },
    {
      detached: runOptions.detached,
    },
  );

  if (result.process.code !== 0) {
    throw inputError(formatComposeFailure(result.process));
  }
}

function formatUnhealthyServices(
  projectName: string,
  services: readonly string[],
): string {
  return `Unhealthy services: ${services
    .map((service) => `${projectName}/${service}`)
    .join(", ")}`;
}

function countWarnings(result: { stdout?: string; stderr?: string }): number {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /\bwarn(?:ing)?\b/i.test(line)).length;
}

type ComposeCommandRunOptions = {
  detached?: boolean;
  detachSignal?: AbortSignal;
  onHealthChange?: (change: ProjectComposeHealthChange) => void;
  onServiceChange?: (change: ProjectComposeServiceChange) => void;
  onUnhealthy?: (service: string) => void;
  signal?: AbortSignal;
  trackHealth?: boolean;
};

type ComposeCommandRunResult = {
  process: ProcessResult;
  progress: ComposeProgress;
};

async function runComposeCommand(
  project: ComposeProject,
  operation: string,
  args: readonly string[],
  options: RunCommandOptions,
  runOptions: ComposeCommandRunOptions = {},
): Promise<ComposeCommandRunResult> {
  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const loader = startLoader(`${operation} ${project.name}`, {
    enabled: !options.verbose && !runOptions.detached,
  });
  const output = runOptions.detached
    ? createSilentComposeOutput()
    : {
        finishLine: loader.finishLine,
        startLineAfter: loader.startLineAfter,
        startLine: loader.startLine,
        writeLine: loader.writeLine,
        writeLineAfter: loader.writeLineAfter,
      };
  let progress = createEmptyComposeProgress();

  try {
    if (runOptions.trackHealth ?? true) {
      progress = await startComposeProgress(
        project,
        operation,
        options,
        output,
        {
          onHealthChange: (service, status) =>
            runOptions.onHealthChange?.({
              project: project.name,
              service,
              status,
            }),
          onServiceChange: (service, status) =>
            runOptions.onServiceChange?.({
              project: project.name,
              service,
              status,
            }),
          onUnhealthy: runOptions.onUnhealthy,
        },
      );
    }

    const command: ProcessCommand = {
      command: PODMAN_COMPOSE_COMMAND,
      args: progress.captureComposeCommands
        ? ["--verbose", ...createPodmanComposeArgs(project, args)]
        : createPodmanComposeArgs(project, args),
      cwd: project.workingDir,
      detached: runOptions.detached,
    };
    if (runOptions.signal) {
      command.signal = runOptions.signal;
    }
    if (runOptions.detachSignal) {
      command.detachSignal = runOptions.detachSignal;
    }
    if (progress.captureComposeCommands) {
      command.onOutput = ({ text }) => progress.writeComposeOutput(text);
    }
    if (options.verbose) {
      command.verbose = true;
    }

    return {
      process: await runProcess(command),
      progress,
    };
  } finally {
    try {
      await progress.stop();
    } finally {
      loader.stop();
    }
  }
}
