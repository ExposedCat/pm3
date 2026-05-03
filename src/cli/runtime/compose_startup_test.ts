import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createComposeStartupTracker } from "./compose_startup.ts";
import type { ProcessCommand } from "./process.ts";

Deno.test({
  name:
    "startup mode ignores dependency degradation after the consumer started",
  async fn() {
    await withTempComposeProject(
      "services:\n  api:\n    depends_on:\n      db:\n        condition: service_healthy\n  db: {}\nx-pm3:\n  startup:\n    required_services:\n      - api\n",
      async (project, runConfigOnly) => {
        const tracker = await createComposeStartupTracker(
          project,
          runConfigOnly,
        );
        if (!tracker) {
          throw new Error("expected startup tracker");
        }

        tracker.recordService("db", "started");
        tracker.recordHealth("db", "healthy");
        tracker.recordService("api", "started");
        tracker.recordHealth("db", "degraded");

        assertEquals(tracker.abortReason(), "");
      },
    );
  },
});

Deno.test({
  name:
    "watcher mode reacts to dependency degradation after the consumer started",
  async fn() {
    await withTempComposeProject(
      "services:\n  api:\n    depends_on:\n      db:\n        condition: service_healthy\n  db: {}\nx-pm3:\n  startup:\n    mode: watcher\n    required_services:\n      - api\n",
      async (project, runConfigOnly) => {
        const tracker = await createComposeStartupTracker(
          project,
          runConfigOnly,
        );
        if (!tracker) {
          throw new Error("expected startup tracker");
        }

        tracker.recordService("db", "started");
        tracker.recordHealth("db", "healthy");
        tracker.recordService("api", "started");
        tracker.recordHealth("db", "degraded");

        assertEquals(
          tracker.abortReason(),
          "Required services permanently unstartable: api",
        );
      },
    );
  },
});

async function withTempComposeProject(
  resolvedConfig: string,
  callback: (
    project: { name: string; workingDir: string },
    runConfigOnly: (
      command: ProcessCommand,
    ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
  ) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "pm3-compose-startup-" });
  const workingDir = join(root, "api");

  try {
    await Deno.mkdir(workingDir);
    await Deno.writeTextFile(
      join(workingDir, "compose.yaml"),
      "services: {}\n",
    );
    await callback({ name: "api", workingDir }, runConfigOnly);
  } finally {
    await Deno.remove(root, { recursive: true });
  }

  function runConfigOnly(
    command: ProcessCommand,
  ): Promise<{ code: number; stdout?: string; stderr?: string }> {
    if (
      command.command === "podman-compose" &&
      command.args.join(" ") === "config"
    ) {
      return Promise.resolve({ code: 0, stdout: resolvedConfig });
    }

    throw new Error(
      `Unexpected command: ${command.command} ${command.args.join(" ")}`,
    );
  }
}
