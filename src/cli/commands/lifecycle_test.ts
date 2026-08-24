import { assertEquals, assertThrows } from "@std/assert";
import { closeDatabase, createDatabase } from "../../database/database.ts";
import { addProject } from "../../database/projects.ts";
import { parseArgs, runCommand } from "../commands.ts";
import type { ProcessCommand } from "../runtime/process.ts";

Deno.test("start and stop parse compose operation arguments after the separator", () => {
  const start = parseArgs([
    "--verbose",
    "start",
    "api",
    "--",
    "--profile",
    "workers",
    "--verbose",
  ]);
  if (start.command.kind !== "start") {
    throw new Error("Expected start command");
  }

  assertEquals(start.verbose, true);
  assertEquals(start.command.operationArgs, [
    "--profile",
    "workers",
    "--verbose",
  ]);

  const stop = parseArgs(["stop", "api", "--", "--timeout", "30"]);
  if (stop.command.kind !== "stop") {
    throw new Error("Expected stop command");
  }

  assertEquals(stop.command.operationArgs, ["--timeout", "30"]);
});

Deno.test("restart does not accept compose operation arguments", () => {
  assertThrows(
    () => parseArgs(["restart", "api", "--", "--timeout", "30"]),
    Error,
    "Unknown option for restart: --",
  );
});

Deno.test("start and stop pass operation arguments to compose up and down", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;

  try {
    const db = await createDatabase(databasePath);
    try {
      await addProject(db, {
        composeArgs: ["-f", "compose.yaml"],
        name: "api",
        workingDir: directory,
      });
    } finally {
      await closeDatabase(db);
    }

    const processCalls: ProcessCommand[] = [];
    const options = {
      databasePath,
      runProcess: (command: ProcessCommand) => {
        processCalls.push(command);
        return Promise.resolve({ code: 0, stdout: "" });
      },
    };

    await runCommand(
      parseArgs(["start", "api", "--build", "--", "--scale", "worker=2"]),
      options,
    );
    assertEquals(
      processCalls.find((call) => call.args.includes("build"))?.args,
      ["-f", "compose.yaml", "build"],
    );
    assertEquals(processCalls.find((call) => call.args.includes("up"))?.args, [
      "-f",
      "compose.yaml",
      "up",
      "-d",
      "--force-recreate",
      "--scale",
      "worker=2",
    ]);

    processCalls.length = 0;
    await runCommand(
      parseArgs(["stop", "api", "--", "--timeout", "30"]),
      options,
    );
    assertEquals(
      processCalls.find((call) => call.args.includes("down"))?.args,
      ["-f", "compose.yaml", "down", "--remove-orphans", "--timeout", "30"],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("detached lifecycle preserves compose operation arguments", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;

  try {
    const db = await createDatabase(databasePath);
    try {
      await addProject(db, { name: "api", workingDir: directory });
    } finally {
      await closeDatabase(db);
    }

    const launches: string[][] = [];
    await runCommand(
      parseArgs(["start", "api", "--detach", "--", "--scale", "worker=2"]),
      {
        databasePath,
        launchDetachedLifecycle: (launch) => {
          launches.push([...launch.args]);
          return Promise.resolve();
        },
      },
    );

    assertEquals(launches, [["start", "api", "--", "--scale", "worker=2"]]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
