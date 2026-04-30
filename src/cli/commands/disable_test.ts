import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { closeDatabase, createDatabase } from "../../database/database.ts";
import {
  getProjectByName,
  listEnabledProjects,
} from "../../database/projects.ts";
import type { ProcessCommand, ProcessResult } from "../runtime/process.ts";
import { runCli, runCliProcess, withTempCli } from "../test_utils.ts";

Deno.test({
  name: "disable removes a project from startup",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);
      await runCli(["enable", "api"], databasePath);

      const output = await runCli(["disable", "api"], databasePath);

      const db = await createDatabase(databasePath);
      try {
        const project = await getProjectByName(db, "api");

        assertEquals(output, "Disabled api");
        assertEquals(project?.enabled, 0);
      } finally {
        await closeDatabase(db);
      }
    });
  },
});

Deno.test({
  name: "disable is idempotent",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      await runCli(["disable", "api"], databasePath);
      const output = await runCli(["disable", "api"], databasePath);

      const db = await createDatabase(databasePath);
      try {
        const enabledProjects = await listEnabledProjects(db);

        assertEquals(output, "Disabled api");
        assertEquals(enabledProjects, []);
      } finally {
        await closeDatabase(db);
      }
    });
  },
});

Deno.test({
  name: "disable --now stops the project after disabling it",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);
      await runCli(["enable", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = async (
        command: ProcessCommand,
      ): Promise<ProcessResult> => {
        const db = await createDatabase(databasePath);
        try {
          const project = await getProjectByName(db, "api");

          assertEquals(project?.enabled, 0);
        } finally {
          await closeDatabase(db);
        }

        commands.push(command);
        return { code: 0 };
      };

      const output = await runCli(
        ["disable", "--now", "api"],
        databasePath,
        runProcess,
      );

      assertEquals(output, "Disabled api");
      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["down", "--remove-orphans"],
          cwd: resolve(workdir),
        },
      ]);
    });
  },
});

Deno.test({
  name: "disable accepts the short now option",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];

      await runCli(["disable", "-n", "api"], databasePath, (command) => {
        commands.push(command);
        return Promise.resolve({ code: 0 });
      });

      assertEquals(commands.length, 1);
    });
  },
});

Deno.test({
  name: "disable reports missing projects",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath }) => {
      const output = await runCliProcess(["disable", "missing"], databasePath);

      assertEquals(output.code, 1);
      assertEquals(output.stdout, "");
      assertEquals(output.stderr, "Project not found: missing");
    });
  },
});
