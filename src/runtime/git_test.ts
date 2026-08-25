import { assertEquals, assertRejects } from "@std/assert";
import type { ProcessCommand, ProcessResult } from "../cli/runtime/process.ts";
import { pullProjectGit } from "./git.ts";

Deno.test("git pull reports its commit result", async (test) => {
  for (const result of [
    { commits: 0, message: "No changes" },
    { commits: 1, message: "Pulled 1 commit" },
    { commits: 3, message: "Pulled 3 commits" },
  ]) {
    await test.step(result.message, async () => {
      const processCalls: ProcessCommand[] = [];
      const output = await captureConsoleLog(() =>
        pullProjectGit(
          { name: "api", workingDir: "/project" },
          {
            runProcess: (command) => {
              processCalls.push(command);
              return Promise.resolve(createGitResult(command, result.commits));
            },
          },
        ),
      );

      assertEquals(output, [
        "Pulling git",
        "Synced git",
        `    ${result.message}`,
      ]);
      assertEquals(
        processCalls.map((command) => command.args),
        [
          ["rev-parse", "--is-inside-work-tree"],
          ["rev-parse", "--verify", "HEAD"],
          ["pull", "--ff-only"],
          ["rev-list", "--count", "abc123..HEAD"],
        ],
      );
    });
  }
});

Deno.test("git pull reports a concise failure", async () => {
  const output = await captureConsoleLog(() =>
    assertRejects(
      () =>
        pullProjectGit(
          { name: "api", workingDir: "/project" },
          {
            runProcess: (command) =>
              Promise.resolve(
                command.args[0] === "pull"
                  ? {
                      code: 1,
                      stderr:
                        "fatal: cannot fast-forward\nhint: reconcile branches",
                    }
                  : createGitResult(command, 0),
              ),
          },
        ),
      Error,
      "fatal: cannot fast-forward",
    ),
  );

  assertEquals(output, [
    "Pulling git",
    "Failed to sync git",
    "    Failed to pull (fatal: cannot fast-forward hint: reconcile branches)",
  ]);
});

function createGitResult(
  command: ProcessCommand,
  commits: number,
): ProcessResult {
  if (command.args[0] === "rev-parse") {
    return {
      code: 0,
      stdout: command.args.includes("--is-inside-work-tree")
        ? "true"
        : "abc123",
    };
  }

  if (command.args[0] === "rev-list") {
    return { code: 0, stdout: String(commits) };
  }

  return { code: 0 };
}

async function captureConsoleLog(
  action: () => Promise<unknown>,
): Promise<string[]> {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));

  try {
    await action();
    return output;
  } finally {
    console.log = originalLog;
  }
}
