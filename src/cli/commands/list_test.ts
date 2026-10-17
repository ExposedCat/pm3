import { assertEquals, assertStringIncludes } from "@std/assert";
import { closeDatabase, createDatabase } from "../../database/database.ts";
import { addProject } from "../../database/projects.ts";
import { parseArgs, runCommand } from "../commands.ts";
import { formatProjectState, type ProjectListContainer } from "./list.ts";

Deno.test("list renders a failed project as invalid", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;

  try {
    const db = await createDatabase(databasePath);
    try {
      await addProject(db, {
        composeArgs: ["-f", "compose.yaml"],
        name: "broken",
        workingDir: "/broken",
      });
      await addProject(db, {
        composeArgs: ["-f", "compose.yaml"],
        name: "working",
        workingDir: "/working",
      });
    } finally {
      await closeDatabase(db);
    }

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));

    try {
      await runCommand(parseArgs(["list"]), {
        databasePath,
        runProcess: (command) =>
          Promise.resolve(
            command.cwd === "/broken"
              ? { code: 1, stderr: "missing compose file" }
              : { code: 0, stdout: "[]" },
          ),
      });
    } finally {
      console.log = originalLog;
    }

    assertStringIncludes(output[0], "broken");
    assertStringIncludes(output[0], "invalid");
    assertStringIncludes(output[0], "working");
    assertStringIncludes(output[0], "down");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("list state ignores completed one-shot containers", () => {
  const container = (
    state: string,
    exitCode = 0,
  ): ProjectListContainer => ({
    createdAt: 0,
    exitCode,
    exitedAt: 0,
    ports: "",
    service: state,
    startedAt: 0,
    state,
    status: "",
  });
  const stateOf = (containers: ProjectListContainer[]) =>
    formatProjectState(containers, { detailed: false }).state;

  assertEquals(stateOf([container("running"), container("exited")]), "up");
  assertEquals(
    stateOf([container("running"), container("exited", 1)]),
    "degraded",
  );
  assertEquals(stateOf([container("exited"), container("exited")]), "down");
  assertEquals(
    stateOf([container("running"), container("stopping")]),
    "stopping",
  );
});
