import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { closeDatabase, createDatabase } from "../../database/database.ts";
import { addProject, getProjectByName } from "../../database/projects.ts";
import { parseArgs, runCommand } from "../commands.ts";
import type { ProcessCommand } from "../runtime/process.ts";

Deno.test("git parses enable and disable aliases", () => {
  for (const alias of ["on", "y", "yes", "enable"]) {
    const parsed = parseArgs(["git", alias, "api"]);
    if (parsed.command.kind !== "git") {
      throw new Error("Expected git command");
    }

    assertEquals(parsed.command.mode, "on");
    assertEquals(parsed.command.name, "api");
  }

  for (const alias of ["off", "n", "no", "disable"]) {
    const parsed = parseArgs(["git", alias]);
    if (parsed.command.kind !== "git") {
      throw new Error("Expected git command");
    }

    assertEquals(parsed.command.mode, "off");
    assertEquals(parsed.command.name, undefined);
  }
});

Deno.test("git rejects missing, invalid, and extra arguments", () => {
  assertThrows(() => parseArgs(["git"]), Error, "Missing git mode.");
  assertThrows(
    () => parseArgs(["git", "maybe"]),
    Error,
    "Invalid git mode: maybe",
  );
  assertThrows(
    () => parseArgs(["git", "on", "api", "extra"]),
    Error,
    "Unexpected argument for git: extra",
  );
});

Deno.test("enable no longer accepts git options", () => {
  assertThrows(
    () => parseArgs(["enable", "api", "--git"]),
    Error,
    "Unknown option for enable: --git",
  );
  assertThrows(
    () => parseArgs(["enable", "api", "--local"]),
    Error,
    "Unknown option for enable: --local",
  );
});

Deno.test("git validates repositories before enabling and persists the mode", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;

  try {
    const db = await createDatabase(databasePath);
    try {
      await addProject(db, { name: "api", workingDir: directory });
    } finally {
      await closeDatabase(db);
    }

    const processCalls: ProcessCommand[] = [];
    const runProcess = (command: ProcessCommand) => {
      processCalls.push(command);
      return Promise.resolve({ code: 0, stdout: "true" });
    };

    await runCommand(parseArgs(["git", "on", "api"]), {
      databasePath,
      runProcess,
    });
    assertEquals(processCalls.length, 1);
    assertEquals(processCalls[0].command, "git");
    assertEquals(processCalls[0].args, ["rev-parse", "--is-inside-work-tree"]);

    let verificationDb = await createDatabase(databasePath);
    try {
      assertEquals((await getProjectByName(verificationDb, "api"))?.git, 1);
    } finally {
      await closeDatabase(verificationDb);
    }

    processCalls.length = 0;
    await runCommand(parseArgs(["git", "disable", "api"]), {
      databasePath,
      runProcess,
    });
    assertEquals(processCalls, []);

    verificationDb = await createDatabase(databasePath);
    try {
      assertEquals((await getProjectByName(verificationDb, "api"))?.git, 0);
    } finally {
      await closeDatabase(verificationDb);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("git does not persist on when repository validation fails", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;

  try {
    const db = await createDatabase(databasePath);
    try {
      await addProject(db, { name: "api", workingDir: directory });
    } finally {
      await closeDatabase(db);
    }

    await assertRejects(
      () =>
        runCommand(parseArgs(["git", "yes", "api"]), {
          databasePath,
          runProcess: () => Promise.resolve({ code: 1, stdout: "false" }),
        }),
      Error,
      "Project is not a git repository: api",
    );

    const verificationDb = await createDatabase(databasePath);
    try {
      assertEquals((await getProjectByName(verificationDb, "api"))?.git, 0);
    } finally {
      await closeDatabase(verificationDb);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
