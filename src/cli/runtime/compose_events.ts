export type ProjectComposeHealthStatus = "pending" | "healthy" | "degraded";
export type ProjectComposeServiceStatus = "pending" | "started" | "stopped";

export type ProjectComposeHealthChange = {
  project: string;
  service: string;
  status: ProjectComposeHealthStatus;
};

export type ProjectComposeServiceChange = {
  project: string;
  service: string;
  status: ProjectComposeServiceStatus;
};

export type PodmanEvent = {
  ID?: string;
  Status?: string;
  health_status?: string;
  Attributes?: Record<string, string>;
};

export function parsePodmanEvent(line: string): PodmanEvent | undefined {
  try {
    return JSON.parse(line) as PodmanEvent;
  } catch {
    return undefined;
  }
}

export function getComposeEventService(event: PodmanEvent | undefined): string {
  return (
    event?.Attributes?.["io.podman.compose.service"] ??
      event?.Attributes?.["com.docker.compose.service"] ??
      ""
  );
}

export function getComposeEventWorkingDir(
  event: PodmanEvent | undefined,
): string {
  return (
    event?.Attributes?.["io.podman.compose.project.working_dir"] ??
      event?.Attributes?.["com.docker.compose.project.working_dir"] ??
      ""
  );
}

export function getComposeHealthStatus(
  event: PodmanEvent | undefined,
): ProjectComposeHealthStatus | "" {
  const status = event?.health_status ?? parseHealthStatusEvent(event?.Status);

  if (status === "starting") {
    return "pending";
  }

  if (status === "healthy") {
    return "healthy";
  }

  if (status === "unhealthy") {
    return "degraded";
  }

  return "";
}

export function getComposeServiceStatus(
  event: PodmanEvent | undefined,
): ProjectComposeServiceStatus | "" {
  const status = event?.Status?.toLowerCase();

  if (status === "start") {
    return "started";
  }

  if (
    status === "create" ||
    status === "init" ||
    status === "restart"
  ) {
    return "pending";
  }

  if (status === "stop" || status === "died" || status === "remove") {
    return "stopped";
  }

  return "";
}

function parseHealthStatusEvent(status: string | undefined): string {
  return status?.match(/^health_status:?\s+(.+)$/)?.[1] ?? "";
}
