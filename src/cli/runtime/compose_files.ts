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

export async function hasComposeFile(workingDir: string): Promise<boolean> {
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

type ComposeProject = {
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

export async function listComposeServices(
  project: ComposeProject,
  runProcess: (
    command: ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
): Promise<ComposeServiceDiscovery> {
  if (!(await hasComposeFile(project.workingDir))) {
    return { kind: "missing-compose-file" };
  }

  const result = await runProcess({
    command: PODMAN_COMPOSE_COMMAND,
    args: ["config", "--services"],
    cwd: project.workingDir,
    captureOutput: true,
  });

  if (result.code !== 0) {
    return {
      kind: "error",
      message:
        result.stderr?.trim() ||
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
  if (!(await hasComposeFile(project.workingDir))) {
    return { kind: "missing-compose-file" };
  }

  const result = await runProcess({
    command: PODMAN_COMPOSE_COMMAND,
    args: ["config"],
    cwd: project.workingDir,
    captureOutput: true,
  });

  if (result.code !== 0) {
    return {
      kind: "error",
      message:
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        `${PODMAN_COMPOSE_COMMAND} config exited with code ${result.code}`,
    };
  }

  return {
    kind: "config",
    text: result.stdout ?? "",
  };
}
