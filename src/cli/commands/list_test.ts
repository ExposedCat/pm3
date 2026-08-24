import { assertStringIncludes } from "@std/assert";
import { closeDatabase, createDatabase } from "../../database/database.ts";
import { addProject } from "../../database/projects.ts";
import { parseArgs, runCommand } from "../commands.ts";

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
