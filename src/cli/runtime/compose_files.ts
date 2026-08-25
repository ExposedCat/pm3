import type { ProcessCommand } from "./process.ts";

export const PODMAN_COMPOSE_COMMAND = "podman-compose";
export const PODMAN_COMMAND = "podman";

const PODMAN_COMPOSE_FILES = [
  "podman-compose.yaml",
  "podman-compose.yml",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

type ComposeProject = {
  composeArgs?: readonly string[];
  workingDir: string;
};

export type ComposeServiceDiscovery =
  | { kind: "missing-compose-file" }
  | { kind: "services"; services: string[] }
  | { kind: "error"; message: string };

export type ComposeConfigDiscovery =
  | { kind: "missing-compose-file" }
  | { kind: "config"; text: string }
  | { kind: "error"; message: string };

export async function hasComposeFile(
  project: ComposeProject,
): Promise<boolean> {
  if (project.composeArgs?.length) {
    return true;
  }

  return (await resolveComposeFile(project)) !== undefined;
}

export function createPodmanComposeArgs(
  project: ComposeProject,
  args: readonly string[],
): string[] {
  return [...(project.composeArgs ?? []), ...args];
}

export async function listComposeServices(
  project: ComposeProject,
  runProcess: (
    command: ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
): Promise<ComposeServiceDiscovery> {
  if (!(await hasComposeFile(project))) {
    return { kind: "missing-compose-file" };
  }

  const result = await runProcess({
    command: PODMAN_COMPOSE_COMMAND,
    args: createPodmanComposeArgs(project, ["config", "--services"]),
    cwd: project.workingDir,
    captureOutput: true,
  });

  if (result.code !== 0) {
    return {
      kind: "error",
      message: result.stderr?.trim() ||
        result.stdout?.trim() ||
        `${PODMAN_COMPOSE_COMMAND} config --services exited with code ${result.code}`,
    };
  }

  return {
    kind: "services",
    services: (result.stdout ?? "")
      .split("\n")
      .map((service) => service.trim())
      .filter(Boolean),
  };
}

export async function readComposeConfig(
  project: ComposeProject,
  runProcess: (
    command: ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
): Promise<ComposeConfigDiscovery> {
  if (!(await hasComposeFile(project))) {
    return { kind: "missing-compose-file" };
  }

  const result = await runProcess({
    command: PODMAN_COMPOSE_COMMAND,
    args: createPodmanComposeArgs(project, ["config"]),
    cwd: project.workingDir,
    captureOutput: true,
  });

  if (result.code !== 0) {
    return {
      kind: "error",
      message: result.stderr?.trim() ||
        result.stdout?.trim() ||
        `${PODMAN_COMPOSE_COMMAND} config exited with code ${result.code}`,
    };
  }

  return {
    kind: "config",
    text: result.stdout ?? "",
  };
}

async function resolveComposeFile(
  project: ComposeProject,
): Promise<string | undefined> {
  for (const fileName of PODMAN_COMPOSE_FILES) {
    const path = `${project.workingDir}/${fileName}`;
    if (await isFile(path)) {
      return path;
    }
  }

  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }

    throw error;
  }
}
