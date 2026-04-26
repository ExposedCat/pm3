import type { Project } from "../../database/projects.ts";
import type { RunCommandOptions } from "../command.ts";

const PODMAN_COMPOSE_COMMAND = "podman-compose";
const PODMAN_COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

export async function runProjectCompose(
  project: Project,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<void> {
  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const result = await runProcess({
    command: PODMAN_COMPOSE_COMMAND,
    args,
    cwd: project.workingDir,
  });

  if (result.code !== 0) {
    throw new Error(
      `${PODMAN_COMPOSE_COMMAND} exited with code ${result.code}`,
    );
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
    state: container.State ?? "",
    status: container.Status ?? "",
    createdAt: container.Created ?? 0,
    startedAt: container.StartedAt ?? 0,
    exitedAt: container.ExitedAt ?? 0,
    ports: formatPorts(container.Ports),
  }));
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
