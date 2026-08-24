import { assertEquals, assertRejects } from "@std/assert";
import { closeDatabase, createDatabase } from "../../database/database.ts";
import { addProject, getProjectByName } from "../../database/projects.ts";
import { parseArgs, runCommand } from "../commands.ts";
import type { ProcessCommand } from "../runtime/process.ts";

Deno.test("remove reports an invalid cwd and force removes best effort", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;
  const workingDir = `${directory}/missing`;

  try {
    const db = await createDatabase(databasePath);
    try {
      await addProject(db, {
        composeArgs: ["-f", "compose.yaml"],
        name: "safe",
        workingDir,
      });
    } finally {
      await closeDatabase(db);
    }

    const processCalls: ProcessCommand[] = [];
    const options = {
      databasePath,
      runProcess: (command: ProcessCommand) => {
        processCalls.push(command);
        return Promise.reject(new Error("Podman cleanup failed"));
      },
      verbose: true,
    };

    await assertRejects(
      () => runCommand(parseArgs(["rm", "safe"]), options),
      Error,
      `Project safe has invalid cwd '${workingDir}'\n` +
        "Retry with `--force` to remove as is",
    );
    assertEquals(processCalls, []);

    await runCommand(parseArgs(["rm", "safe", "--force"]), options);
    assertEquals(processCalls.length, 1);
    assertEquals(processCalls[0].args, [
      "-f",
      "compose.yaml",
      "down",
      "--volumes",
      "--rmi",
      "all",
      "--remove-orphans",
    ]);

    const verificationDb = await createDatabase(databasePath);
    try {
      assertEquals(await getProjectByName(verificationDb, "safe"), undefined);
    } finally {
      await closeDatabase(verificationDb);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
