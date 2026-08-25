import { assertEquals } from "@std/assert";
import { closeDatabase, createDatabase } from "../database/database.ts";
import { addProject, listProjects } from "../database/projects.ts";
import { parseArgs, runCommand } from "./commands.ts";

Deno.test("yes is a global option except after the argument separator", () => {
  assertEquals(parseArgs(["--yes", "enable"]).yes, true);
  assertEquals(parseArgs(["enable", "-y"]).yes, true);

  const parsed = parseArgs(["start", "api", "--", "--yes"]);
  assertEquals(parsed.yes, false);
  if (parsed.command.kind !== "start") {
    throw new Error("Expected start command");
  }
  assertEquals(parsed.command.operationArgs, ["--yes"]);
});

Deno.test("commands without a project confirm before targeting all projects", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;

  try {
    const db = await createDatabase(databasePath);
    try {
      await addProject(db, { name: "api", workingDir: directory });
      await addProject(db, { name: "web", workingDir: directory });
    } finally {
      await closeDatabase(db);
    }

    const questions: string[] = [];
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));

    try {
      await runCommand(parseArgs(["enable"]), {
        confirmAllProjects: (question) => {
          questions.push(question);
          return false;
        },
        databasePath,
      });

      assertEquals(questions, [
        "Are you sure to execute 'enable' on 2 projects? [Y/n]",
      ]);
      assertEquals(output, ["Aborted"]);

      const abortedDb = await createDatabase(databasePath);
      try {
        assertEquals(
          (await listProjects(abortedDb)).map((project) => project.enabled),
          [0, 0],
        );
      } finally {
        await closeDatabase(abortedDb);
      }

      await runCommand(parseArgs(["enable", "--yes"]), {
        confirmAllProjects: () => {
          throw new Error("Confirmation must be skipped");
        },
        databasePath,
      });

      await runCommand(parseArgs(["disable", "api"]), {
        confirmAllProjects: () => {
          throw new Error("Named commands must not confirm");
        },
        databasePath,
      });
    } finally {
      console.log = originalLog;
    }

    const verificationDb = await createDatabase(databasePath);
    try {
      assertEquals(
        (await listProjects(verificationDb)).map((project) => project.enabled),
        [0, 1],
      );
    } finally {
      await closeDatabase(verificationDb);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
