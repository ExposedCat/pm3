import type { RunCommandOptions } from "../cli/commands.ts";
import { inputError } from "../cli/errors.ts";

type GitProject = {
  name: string;
  workingDir: string;
};

export async function requireProjectGitRepository(
  project: GitProject,
  options: RunCommandOptions,
): Promise<void> {
  const { runSystemProcess } = await import("../cli/runtime/process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const result = await runProcess({
    command: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    cwd: project.workingDir,
    captureOutput: true,
    signal: options.signal,
  });

  if (result.code !== 0 || result.stdout?.trim() !== "true") {
    throw inputError(`Project is not a git repository: ${project.name}`);
  }
}

export async function pullProjectGit(
  project: GitProject,
  options: RunCommandOptions,
): Promise<void> {
  await requireProjectGitRepository(project, options);

  const { runSystemProcess } = await import("../cli/runtime/process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const result = await runProcess({
    command: "git",
    args: ["pull", "--ff-only"],
    cwd: project.workingDir,
    captureOutput: !options.verbose,
    signal: options.signal,
    verbose: options.verbose,
  });

  if (result.code !== 0) {
    throw inputError(formatGitPullFailure(project, result));
  }
}

function formatGitPullFailure(
  project: GitProject,
  result: { stderr?: string; stdout?: string },
): string {
  return (
    result.stderr ||
    result.stdout ||
    `Failed to pull git for project: ${project.name}`
  );
}
