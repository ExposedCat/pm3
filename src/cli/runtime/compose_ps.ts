export type ProjectComposeContainer = {
  service: string;
  state: string;
  status: string;
  createdAt: number;
  startedAt: number;
  exitedAt: number;
  ports: string;
};

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

export function parseComposeContainerJson(
  output: string,
): ProjectComposeContainer[] {
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
