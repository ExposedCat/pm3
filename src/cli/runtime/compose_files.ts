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

export async function listComposeServices(
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
