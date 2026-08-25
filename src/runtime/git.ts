import type { RunCommandOptions } from "../cli/commands.ts";
import { inputError } from "../cli/errors.ts";
import { startLoader } from "../cli/output/loader.ts";

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
  const loader = startLoader("Pulling git", { enabled: !options.verbose });
  loader.startLine({ id: "git:pull", text: "Pulling git" });

  try {
    await requireProjectGitRepository(project, options);

    const { runSystemProcess } = await import("../cli/runtime/process.ts");
    const runProcess = options.runProcess ?? runSystemProcess;
    const previousHead = await readGitHead(project, options, runProcess);
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

    const commits = await countPulledGitCommits(
      project,
      previousHead,
      options,
      runProcess,
    );
    loader.finishLine("git:pull", "Synced git");
    writeGitPullResult(loader, formatGitPullSuccess(commits));
  } catch (error) {
    loader.finishLine("git:pull", "Failed to sync git");
    writeGitPullResult(loader, `Failed to pull (${formatError(error)})`);
    throw error;
  } finally {
    loader.stop();
  }
}

type GitRunProcess = (
  command: import("../cli/runtime/process.ts").ProcessCommand,
) => Promise<import("../cli/runtime/process.ts").ProcessResult>;

async function readGitHead(
  project: GitProject,
  options: RunCommandOptions,
  runProcess: GitRunProcess,
): Promise<string | undefined> {
  const result = await runProcess({
    command: "git",
    args: ["rev-parse", "--verify", "HEAD"],
    cwd: project.workingDir,
    captureOutput: true,
    signal: options.signal,
  });

  return result.code === 0 ? result.stdout?.trim() || undefined : undefined;
}

async function countPulledGitCommits(
  project: GitProject,
  previousHead: string | undefined,
  options: RunCommandOptions,
  runProcess: GitRunProcess,
): Promise<number> {
  const result = await runProcess({
    command: "git",
    args: [
      "rev-list",
      "--count",
      previousHead ? `${previousHead}..HEAD` : "HEAD",
    ],
    cwd: project.workingDir,
    captureOutput: true,
    signal: options.signal,
  });
  const output = result.stdout?.trim() ?? "";

  if (result.code !== 0 || !/^\d+$/.test(output)) {
    throw inputError(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `Failed to count pulled git commits for project: ${project.name}`,
    );
  }

  return Number(output);
}

function formatGitPullSuccess(commits: number): string {
  if (commits === 0) {
    return "No changes";
  }

  return `Pulled ${commits} ${commits === 1 ? "commit" : "commits"}`;
}

function writeGitPullResult(
  loader: ReturnType<typeof startLoader>,
  result: string,
): void {
  loader.writeLineAfter("git:pull", { id: "git:pull-result", text: result });
}

function formatError(error: unknown): string {
  const message = error instanceof Error && error.message
    ? error.message
    : "Command failed";
  return message.replace(/\s+/g, " ").trim();
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
