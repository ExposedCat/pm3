import type { Project } from "../../database/projects.ts";
import type { ProcessCommand, RunCommandOptions } from "../command.ts";
import { inputError } from "../errors.ts";

const PODMAN_COMPOSE_COMMAND = "podman-compose";
const PODMAN_COMMAND = "podman";
const PODMAN_COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];
const LOADER_FRAMES = ["-", "\\", "|", "/"] as const;
const EVENT_STREAM_STOP_GRACE_MS = 150;

export async function runProjectCompose(
  project: Project,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<void> {
  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const operation = getComposeOperation(args);
  const loader = startLoader(`${operation} ${project.name}`, {
    enabled: !options.verbose,
  });
  const progress = await startComposeProgress(project, operation, options, {
    finishLine: loader.finishLine,
    startLine: loader.startLine,
  });

  const command: ProcessCommand = {
    command: PODMAN_COMPOSE_COMMAND,
    args: progress.captureComposeCommands ? ["--verbose", ...args] : args,
    cwd: project.workingDir,
  };
  if (progress.captureComposeCommands) {
    command.onOutput = ({ text }) => progress.writeComposeOutput(text);
  }
  if (options.verbose) {
    command.verbose = true;
  }

  const result = await (async () => {
    try {
      return await runProcess(command);
    } finally {
      loader.stop();
      await progress.stop();
    }
  })();

  if (result.code !== 0) {
    throw inputError(formatComposeFailure(result));
  }

  const warnings = countWarnings(result);
  if (warnings > 0) {
    console.log(`Finished with ${warnings} warnings`);
  }
}

export async function removeProjectComposeArtifacts(
  project: Project,
  options: RunCommandOptions,
): Promise<void> {
  if (!(await hasComposeFile(project.workingDir))) {
    return;
  }

  await runProjectCompose(
    project,
    ["down", "--volumes", "--rmi", "all", "--remove-orphans"],
    options,
  );
}

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
  project: Project,
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
  stop(): Promise<void>;
  writeComposeOutput(text: string): void;
};

async function startComposeProgress(
  project: Project,
  operation: ComposeOperation,
  options: RunCommandOptions,
  output: ComposeOutput,
): Promise<ComposeProgress> {
  if (options.runProcess || operation === "Building") {
    return {
      captureComposeCommands: false,
      stop: () => Promise.resolve(),
      writeComposeOutput: () => {},
    };
  }

  const services = await listComposeServices(project);
  if (services.length === 0) {
    return {
      captureComposeCommands: false,
      stop: () => Promise.resolve(),
      writeComposeOutput: () => {},
    };
  }

  const finished = new Set<string>();
  const started = new Set<string>();
  const serviceNames = new Set(services);
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
        services,
        finished,
        started,
        service,
        output,
      );
    },
  );
  let composeOutput = "";

  return {
    captureComposeCommands: !options.verbose,
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
          startComposeServiceProgress(
            project.name,
            operation,
            services,
            started,
            service,
            output,
          );
        }
      }
    },
  };
}

async function listComposeServices(project: Project): Promise<string[]> {
  if (!(await hasComposeFile(project.workingDir))) {
    return [];
  }

  const { runSystemProcess } = await import("./process.ts");
  const result = await runSystemProcess({
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

  return services.find((service) => normalized.includes(`_${service}_`)) ?? "";
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
  services: readonly string[],
  started: Set<string>,
  service: string,
  output: ComposeOutput,
): void {
  if (started.has(service)) {
    return;
  }

  started.add(service);
  output.startLine(
    formatComposeProgressLine(projectName, operation, services, service),
  );
}

function finishComposeProgress(
  projectName: string,
  operation: ComposeOperation,
  services: readonly string[],
  finished: Set<string>,
  started: Set<string>,
  service: string,
  output: ComposeOutput,
): void {
  if (finished.has(service)) {
    return;
  }

  const line = formatComposeProgressLine(
    projectName,
    operation,
    services,
    service,
  );
  if (!started.has(service)) {
    started.add(service);
    output.startLine(line);
  }

  finished.add(service);
  output.finishLine(line);
}

function formatComposeProgressLine(
  projectName: string,
  operation: ComposeOperation,
  _services: readonly string[],
  service: string,
): string {
  return `${operation} ${projectName}/${service}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type Loader = {
  finishLine(line: string): void;
  startLine(line: string): void;
  stop(): void;
};

function startLoader(label: string, options: { enabled: boolean }): Loader {
  if (!options.enabled || !isTerminal(Deno.stdout)) {
    return {
      finishLine: () => {},
      startLine: (line) => console.log(line),
      stop: () => {},
    };
  }

  let index = 0;
  let renderedLineCount = 0;
  const lines: { active: boolean; label: string }[] = [];
  const encoder = new TextEncoder();
  const render = () => {
    const frame = LOADER_FRAMES[index % LOADER_FRAMES.length];
    const output: string[] = [];

    if (renderedLineCount > 0) {
      output.push(`\x1b[${renderedLineCount}A`);
    }

    const renderedLines =
      lines.length > 0
        ? lines.map((line) =>
            line.active ? `${frame} ${line.label}...` : `  ${line.label}`,
          )
        : [`${frame} ${label}...`];

    for (const line of renderedLines) {
      output.push(`\r\x1b[K${line}\n`);
    }

    Deno.stdout.writeSync(encoder.encode(output.join("")));
    renderedLineCount = renderedLines.length;
  };
  const timer = setInterval(() => {
    index += 1;
    render();
  }, 100);
  render();

  return {
    finishLine(label: string) {
      const line = lines.find((entry) => entry.label === label);
      if (line) {
        line.active = false;
        render();
      }
    },
    startLine(label: string) {
      if (!lines.some((line) => line.label === label)) {
        lines.push({ active: true, label });
        render();
      }
    },
    stop() {
      clearInterval(timer);
      if (lines.length === 0) {
        Deno.stdout.writeSync(
          encoder.encode(`\x1b[${renderedLineCount}A\r\x1b[K`),
        );
        return;
      }

      for (const line of lines) {
        line.active = false;
      }
      render();
    },
  };
}

type ComposeOutput = {
  finishLine(line: string): void;
  startLine(line: string): void;
};

type TerminalWriter = {
  isTerminal?: () => boolean;
};

function isTerminal(writer: TerminalWriter): boolean {
  return writer.isTerminal?.() ?? false;
}

function formatComposeFailure(result: { stdout?: string; stderr?: string }) {
  return result.stderr || result.stdout || `${PODMAN_COMPOSE_COMMAND} failed`;
}

function countWarnings(result: { stdout?: string; stderr?: string }): number {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /\bwarn(?:ing)?\b/i.test(line)).length;
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
