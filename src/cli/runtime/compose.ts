import type { Project } from "../../database/projects.ts";
import type { RunCommandOptions } from "../command.ts";

const PODMAN_COMPOSE_COMMAND = "podman-compose";

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
