import type { RunCommandOptions } from "../commands.ts";
import { inputError } from "../errors.ts";
import { yellow } from "../output/color.ts";
import { startLoader } from "../output/loader.ts";
import type { ProcessCommand } from "./process.ts";

const PODMAN_COMPOSE_COMMAND = "podman-compose";
const PODMAN_COMMAND = "podman";
const PODMAN_COMPOSE_FILES = [
  "podman-compose.yaml",
  "podman-compose.yml",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];
const EVENT_STREAM_STOP_GRACE_MS = 150;

type ComposeProject = {
  name: string;
  workingDir: string;
};

export async function runProjectCompose(
  project: ComposeProject,
  args: readonly string[],
  options: RunCommandOptions,
  runOptions: ProjectComposeRunOptions = {},
): Promise<void> {
  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const operation = getComposeOperation(args);
  const loader = startLoader(`${operation} ${project.name}`, {
    enabled: !options.verbose && !runOptions.detached,
  });
  let progress = createEmptyComposeProgress();

  const result = await (async () => {
    try {
      progress = runOptions.detached
        ? createEmptyComposeProgress()
        : await startComposeProgress(project, operation, options, {
            finishLine: loader.finishLine,
            writeLineAfter: loader.writeLineAfter,
            startLine: loader.startLine,
          });

      const command: ProcessCommand = {
        command: PODMAN_COMPOSE_COMMAND,
        args: progress.captureComposeCommands ? ["--verbose", ...args] : args,
        cwd: project.workingDir,
      };
      if (runOptions.detached) {
        command.detached = true;
      }
      if (progress.captureComposeCommands) {
        command.onOutput = ({ text }) => progress.writeComposeOutput(text);
      }
      if (options.verbose) {
        command.verbose = true;
      }

      return await runProcess(command);
    } finally {
      loader.stop();
      await progress.stop();
    }
  })();

  if (result.code !== 0) {
    throw inputError(formatComposeFailure(result));
  }

  if (runOptions.detached) {
    return;
  }

  const warnings = countWarnings(result);
  if (warnings > progress.shownNoticeCount()) {
    console.log(`Finished with ${warnings} warnings`);
  }
}

export async function removeProjectComposeArtifacts(
  project: ComposeProject,
  options: RunCommandOptions,
  runOptions: ProjectComposeRunOptions = {},
): Promise<void> {
  if (!(await hasComposeFile(project.workingDir))) {
    return;
  }

  await runProjectCompose(
    project,
    ["down", "--volumes", "--rmi", "all", "--remove-orphans"],
    options,
    runOptions,
  );
}

export type ProjectComposeRunOptions = {
  detached?: boolean;
};

export type ProjectComposeContainer = {
  service: string;
  state: string;
  status: string;
  createdAt: number;
  startedAt: number;
  exitedAt: number;
  ports: string;
};

export async function listProjectComposeContainers(
  project: ComposeProject,
  options: RunCommandOptions,
): Promise<ProjectComposeContainer[]> {
  if (!(await hasComposeFile(project.workingDir))) {
    return [];
  }

  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const result = await runProcess({
    command: PODMAN_COMPOSE_COMMAND,
    args: ["ps", "--format", "json"],
    cwd: project.workingDir,
    captureOutput: true,
  });

  if (result.code !== 0) {
    throw new Error(
      `${PODMAN_COMPOSE_COMMAND} exited with code ${result.code}`,
    );
  }

  return parseComposeContainerJson(result.stdout ?? "");
}

function getComposeOperation(args: readonly string[]): string {
  if (args.includes("build")) {
    return "Building";
  }

  if (args.includes("down")) {
    return "Removing";
  }

  if (args.includes("stop")) {
    return "Stopping";
  }

  if (args.includes("restart")) {
    return "Restarting";
  }

  return "Starting";
}

type ComposeOperation = ReturnType<typeof getComposeOperation>;

type ComposeProgress = {
  captureComposeCommands: boolean;
  shownNoticeCount(): number;
  stop(): Promise<void>;
  writeComposeOutput(text: string): void;
};

function createEmptyComposeProgress(): ComposeProgress {
  return {
    captureComposeCommands: false,
    shownNoticeCount: () => 0,
    stop: () => Promise.resolve(),
    writeComposeOutput: () => {},
  };
}

async function startComposeProgress(
  project: ComposeProject,
  operation: ComposeOperation,
  options: RunCommandOptions,
  output: ComposeOutput,
): Promise<ComposeProgress> {
  if (
    operation === "Building" ||
    (options.runProcess && !options.runLineStream)
  ) {
    return createEmptyComposeProgress();
  }

  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const services = await listComposeServices(project, runProcess);
  if (services.length === 0) {
    return createEmptyComposeProgress();
  }

  const finished = new Set<string>();
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
      if (!isComposeServiceEventComplete(operation, event)) {
        return;
      }

      const service = getComposeEventService(event);
      if (!service || !serviceNames.has(service) || finished.has(service)) {
        return;
      }

      finishComposeProgress(
        project.name,
        operation,
        finished,
        started,
        service,
        output,
      );
    },
  );
  let composeOutput = "";
  let shownNoticeCount = 0;
  let lastCommandService = "";

  return {
    captureComposeCommands: !options.verbose,
    shownNoticeCount: () => shownNoticeCount,
    async stop() {
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

        const noticeService =
          getComposeNoticeService(services, line) || lastCommandService;
        if (noticeService && isComposeNoticeLine(line)) {
          const parentLine = formatComposeProgressLine(
            project.name,
            finished.has(noticeService)
              ? getFinishedComposeOperation(operation)
              : operation,
            noticeService,
          );
          startComposeServiceProgress(
            project.name,
            operation,
            started,
            noticeService,
            output,
          );
          output.writeLineAfter(parentLine, formatComposeNoticeLine(line));
          shownNoticeCount += 1;
        }
      }
    },
  };
}

async function listComposeServices(
  project: ComposeProject,
  runProcess: (
    command: ProcessCommand,
  ) => Promise<{ code: number; stdout?: string }>,
): Promise<string[]> {
  if (!(await hasComposeFile(project.workingDir))) {
    return [];
  }

  const result = await runProcess({
    command: PODMAN_COMPOSE_COMMAND,
    args: ["config", "--services"],
    cwd: project.workingDir,
    captureOutput: true,
  });

  if (result.code !== 0) {
    return [];
  }

  return (result.stdout ?? "")
    .split("\n")
    .map((service) => service.trim())
    .filter(Boolean);
}

function parsePodmanEvent(line: string): PodmanEvent | undefined {
  try {
    return JSON.parse(line) as PodmanEvent;
  } catch {
    return undefined;
  }
}

type PodmanEvent = {
  Status?: string;
  health_status?: string;
  Attributes?: Record<string, string>;
};

function getComposeEventService(event: PodmanEvent | undefined): string {
  return (
    event?.Attributes?.["io.podman.compose.service"] ??
    event?.Attributes?.["com.docker.compose.service"] ??
    ""
  );
}

function isComposeServiceEventComplete(
  operation: ComposeOperation,
  event: PodmanEvent | undefined,
): boolean {
  const status = event?.Status;

  if (operation === "Removing") {
    return status === "remove";
  }

  if (operation === "Stopping") {
    return status === "stop" || status === "died";
  }

  return status === "start";
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
  if (operation === "Starting" || operation === "Restarting") {
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
  output.startLine(formatComposeProgressLine(projectName, operation, service));
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
    output.startLine(line);
  }

  finished.add(service);
  output.finishLine(line, finishedLine);
}

function formatComposeProgressLine(
  projectName: string,
  operation: string,
  service: string,
): string {
  return `${operation} ${projectName}/${service}`;
}

function getFinishedComposeOperation(operation: ComposeOperation): string {
  if (operation === "Starting") {
    return "Started";
  }

  if (operation === "Stopping") {
    return "Stopped";
  }

  if (operation === "Restarting") {
    return "Restarted";
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

function isComposeNoticeLine(line: string): boolean {
  return /\b(?:err(?:or)?|warn(?:ing)?)\b/i.test(line);
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
  finishLine(line: string, finishedLine: string): void;
  startLine(line: string): void;
  writeLineAfter(parentLine: string, line: string): void;
};

function formatComposeFailure(result: { stdout?: string; stderr?: string }) {
  return result.stderr || result.stdout || `${PODMAN_COMPOSE_COMMAND} failed`;
}

function countWarnings(result: { stdout?: string; stderr?: string }): number {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /\bwarn(?:ing)?\b/i.test(line)).length;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function hasComposeFile(workingDir: string): Promise<boolean> {
  for (const fileName of PODMAN_COMPOSE_FILES) {
    try {
      const stat = await Deno.stat(`${workingDir}/${fileName}`);
      if (stat.isFile) {
        return true;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  return false;
}

type PodmanComposeContainer = {
  Labels?: Record<string, string>;
  State?: string;
  Status?: string;
  Created?: number;
  StartedAt?: number;
  ExitedAt?: number;
  Ports?: string | readonly PodmanComposePort[] | null;
};

type PodmanComposePort = {
  host_ip?: string;
  container_port?: number;
  host_port?: number;
  range?: number;
  protocol?: string;
};

function parseComposeContainerJson(output: string): ProjectComposeContainer[] {
  if (!output) {
    return [];
  }

  const containers = JSON.parse(output) as PodmanComposeContainer[];

  return containers.map((container) => ({
    service: getComposeContainerService(container),
    state: container.State ?? "",
    status: container.Status ?? "",
    createdAt: container.Created ?? 0,
    startedAt: container.StartedAt ?? 0,
    exitedAt: container.ExitedAt ?? 0,
    ports: formatPorts(container.Ports),
  }));
}

function getComposeContainerService(container: PodmanComposeContainer): string {
  return (
    container.Labels?.["io.podman.compose.service"] ??
    container.Labels?.["com.docker.compose.service"] ??
    ""
  );
}

function formatPorts(ports: PodmanComposeContainer["Ports"]): string {
  if (!ports) {
    return "";
  }

  if (typeof ports === "string") {
    return ports;
  }

  return ports.map(formatPort).join(", ");
}

function formatPort(port: PodmanComposePort): string {
  const protocol = port.protocol ?? "tcp";
  const containerPort = formatPortRange(port.container_port, port.range);

  if (!port.host_port) {
    return `${containerPort}/${protocol}`;
  }

  const hostIp = port.host_ip || "0.0.0.0";
  const hostPort = formatPortRange(port.host_port, port.range);

  return `${hostIp}:${hostPort}->${containerPort}/${protocol}`;
}

function formatPortRange(
  start: number | undefined,
  range: number | undefined,
): string {
  if (!start) {
    return "";
  }

  if (!range || range === 1) {
    return String(start);
  }

  return `${start}-${start + range - 1}`;
}
