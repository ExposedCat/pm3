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
  name: "enable marks a project for startup",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const output = await runCli(["enable", "api"], databasePath);

      const db = await createDatabase(databasePath);
      try {
        const project = await getProjectByName(db, "api");

        assertEquals(output, "Enabled api");
        assertEquals(project?.enabled, 1);
      } finally {
        await closeDatabase(db);
      }
    });
  },
});

Deno.test({
  name: "enable is idempotent",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      await runCli(["enable", "api"], databasePath);
      const output = await runCli(["enable", "api"], databasePath);

      const db = await createDatabase(databasePath);
      try {
        const enabledProjects = await listEnabledProjects(db);

        assertEquals(output, "Enabled api");
        assertEquals(
          enabledProjects.map((project) => project.name),
          ["api"],
        );
      } finally {
        await closeDatabase(db);
      }
    });
  },
});

Deno.test({
  name: "enable --now starts the project after enabling it",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = async (
        command: ProcessCommand,
      ): Promise<ProcessResult> => {
        const db = await createDatabase(databasePath);
        try {
          const project = await getProjectByName(db, "api");

          assertEquals(project?.enabled, 1);
        } finally {
          await closeDatabase(db);
        }

        commands.push(command);
        return { code: 0 };
      };

      const output = await runCli(
        ["enable", "--now", "api"],
        databasePath,
        runProcess,
      );

      assertEquals(output, "Enabled api");
      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(workdir),
        },
      ]);
    });
  },
});

Deno.test({
  name: "enable accepts the short now option",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];

      await runCli(["enable", "-n", "api"], databasePath, (command) => {
        commands.push(command);
        return Promise.resolve({ code: 0 });
      });

      assertEquals(commands.length, 1);
    });
  },
});

Deno.test({
  name: "enabled projects keep list and view output compatible",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);
      await runCli(["enable", "api"], databasePath);

      const listOutput = await runCli(["list"], databasePath);
      const viewOutput = await runCli(["view", "api"], databasePath);

      assertEquals(
        listOutput,
        ["NAME  STATE", "api   \x1b[31mdown\x1b[0m"].join("\n"),
      );
      assertEquals(
        viewOutput,
        ["name: api", "id: 1", `workdir: ${resolve(workdir)}`].join("\n"),
      );
    });
  },
});

Deno.test({
  name: "enable reports missing projects",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath }) => {
      const output = await runCliProcess(["enable", "missing"], databasePath);

      assertEquals(output.code, 1);
      assertEquals(output.stdout, "");
      assertEquals(output.stderr, "Project not found: missing");
    });
  },
});
