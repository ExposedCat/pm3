import { assertEquals, assertRejects } from "@std/assert";
import { join, resolve } from "@std/path";
import { commandDefinitions } from "../cli/commands.ts";
import { formatHelpText } from "../cli/help.ts";
import type { ProcessCommand, ProcessResult } from "../cli/runtime/process.ts";
import { runCli, withTempCli } from "../cli/test_utils.ts";
import {
  closeDatabase,
  createDatabase,
  type PM3Database,
} from "../database/database.ts";
import { runDaemon } from "./daemon.ts";
import "../database/database.ts";

Deno.test({
  name: "daemon starts enabled projects on startup in deterministic order",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const zetaWorkdir = join(root, "zeta");
      const alphaWorkdir = join(root, "alpha");
      await Deno.mkdir(zetaWorkdir);
      await Deno.mkdir(alphaWorkdir);
      await runCli(["create", zetaWorkdir, "--name", "zeta"], databasePath);
      await runCli(["create", alphaWorkdir, "--name", "alpha"], databasePath);
      await runCli(["enable", "zeta"], databasePath);
      await runCli(["enable", "alpha"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        return Promise.resolve({ code: 0 });
      };

      await withDaemonDatabase(databasePath, async (db) => {
        await runDaemon(
          db,
          { databasePath, runProcess },
          { wait: () => Promise.resolve() },
        );
      });

      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(alphaWorkdir),
          detached: true,
        },
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(zetaWorkdir),
          detached: true,
        },
      ]);
    });
  },
});

Deno.test({
  name: "daemon propagates compose startup failures",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      const workerWorkdir = join(root, "worker");
      await Deno.mkdir(apiWorkdir);
      await Deno.mkdir(workerWorkdir);
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(["create", workerWorkdir, "--name", "worker"], databasePath);
      await runCli(["enable", "api"], databasePath);
      await runCli(["enable", "worker"], databasePath);

      const commands: ProcessCommand[] = [];
      await withDaemonDatabase(databasePath, async (db) => {
        await assertRejects(
          () =>
            runDaemon(db, {
              databasePath,
              runProcess: (command) => {
                commands.push(command);
                return Promise.resolve({
                  code: 1,
                  stderr: "compose exploded",
                });
              },
            }),
          Error,
          "compose exploded",
        );
      });

      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(apiWorkdir),
          detached: true,
        },
      ]);
    });
  },
});

Deno.test({
  name: "daemon remains alive after startup until stopped",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      await Deno.mkdir(apiWorkdir);
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(["enable", "api"], databasePath);

      const controller = new AbortController();
      const commands: ProcessCommand[] = [];
      let waiting = false;

      await withDaemonDatabase(databasePath, async (db) => {
        await runDaemon(
          db,
          {
            databasePath,
            runProcess: (command) => {
              commands.push(command);
              return Promise.resolve({ code: 0 });
            },
          },
          {
            signal: controller.signal,
            wait() {
              waiting = true;
              controller.abort();
              return Promise.resolve();
            },
          },
        );
      });

      assertEquals(waiting, true);
      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(apiWorkdir),
          detached: true,
        },
      ]);
    });
  },
});

Deno.test({
  name: "daemon exits immediately when stopped before wait",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      await Deno.mkdir(apiWorkdir);
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(["enable", "api"], databasePath);

      const controller = new AbortController();
      controller.abort();
      const commands: ProcessCommand[] = [];

      await withDaemonDatabase(databasePath, async (db) => {
        await runDaemon(
          db,
          {
            databasePath,
            runProcess: (command) => {
              commands.push(command);
              return Promise.resolve({ code: 0 });
            },
          },
          { signal: controller.signal },
        );
      });

      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(apiWorkdir),
          detached: true,
        },
      ]);
    });
  },
});

Deno.test({
  name: "daemon skips disabled projects",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      const workerWorkdir = join(root, "worker");
      await Deno.mkdir(apiWorkdir);
      await Deno.mkdir(workerWorkdir);
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(["create", workerWorkdir, "--name", "worker"], databasePath);
      await runCli(["enable", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        return Promise.resolve({ code: 0 });
      };

      await withDaemonDatabase(databasePath, async (db) => {
        await runDaemon(
          db,
          { databasePath, runProcess },
          { wait: () => Promise.resolve() },
        );
      });

      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(apiWorkdir),
          detached: true,
        },
      ]);
    });
  },
});

Deno.test("daemon is exposed in generated help", () => {
  const output = formatHelpText(commandDefinitions);

  assertEquals(output.includes("pm3 daemon [-v|--verbose]"), true);
  assertEquals(output.includes("Run daemon for enabled projects"), true);
});

async function withDaemonDatabase(
  databasePath: string,
  callback: (db: PM3Database) => Promise<void>,
): Promise<void> {
  const db = await createDatabase(databasePath);

  try {
    await callback(db);
  } finally {
    await closeDatabase(db);
  }
}
