import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import type { ProcessCommand, ProcessResult } from "../command.ts";
import { runCli, runCliProcess, withTempCli } from "../test_utils.ts";
import "../../database/database.ts";

Deno.test({
  name: "remove deletes a stopped project after cleaning podman artifacts",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await Deno.writeTextFile(join(workdir, "compose.yaml"), "services: {}\n");
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        return Promise.resolve({
          code: 0,
          stdout: command.captureOutput
            ? JSON.stringify([{ State: "exited" }])
            : undefined,
        });
      };

      await runCli(["rm", "api"], databasePath, runProcess);
      const output = await runCli(["list"], databasePath);

      assertEquals(output, "NAME  STATE");
      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["ps", "--format", "json"],
          cwd: resolve(workdir),
          captureOutput: true,
        },
        {
          command: "podman-compose",
          args: ["down", "--volumes", "--rmi", "all", "--remove-orphans"],
          cwd: resolve(workdir),
        },
      ]);
    });
  },
});

Deno.test({
  name: "remove refuses a running project without force",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await Deno.writeTextFile(join(workdir, "compose.yaml"), "services: {}\n");
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const output = await runCliProcess(
        ["remove", "api"],
        databasePath,
        (command) => {
          commands.push(command);
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([{ State: "running" }]),
          });
        },
      );

      assertEquals(output.code, 1);
      assertEquals(output.stdout, "");
      assertEquals(output.stderr, 'Failed to remove project: "api" is running');
      assertEquals(
        await runCli(["view", "api"], databasePath),
        ["name: api", "id: 1", `workdir: ${resolve(workdir)}`].join("\n"),
      );
      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["ps", "--format", "json"],
          cwd: resolve(workdir),
          captureOutput: true,
        },
      ]);
    });
  },
});

Deno.test({
  name: "force remove cleans running project artifacts and deletes it",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await Deno.writeTextFile(join(workdir, "compose.yaml"), "services: {}\n");
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        return Promise.resolve({
          code: 0,
          stdout: command.captureOutput
            ? JSON.stringify([{ State: "running" }])
            : undefined,
        });
      };

      await runCli(["remove", "--force", "api"], databasePath, runProcess);
      const output = await runCli(["list"], databasePath);

      assertEquals(output, "NAME  STATE");
      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["ps", "--format", "json"],
          cwd: resolve(workdir),
          captureOutput: true,
        },
        {
          command: "podman-compose",
          args: ["down", "--volumes", "--rmi", "all", "--remove-orphans"],
          cwd: resolve(workdir),
        },
      ]);
    });
  },
});

Deno.test({
  name: "remove rejects detached cleanup",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await Deno.writeTextFile(join(workdir, "compose.yaml"), "services: {}\n");
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const output = await runCliProcess(["rm", "-d", "api"], databasePath);

      assertEquals(output.code, 1);
      assertEquals(output.stdout, "");
      assertEquals(output.stderr, "Unknown option for remove: -d");
    });
  },
});

Deno.test({
  name: "remove keeps the project and prints compose errors when podman cleanup fails",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await Deno.writeTextFile(join(workdir, "compose.yaml"), "services: {}\n");
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const output = await runCliProcess(
        ["rm", "-f", "api"],
        databasePath,
        (command) =>
          Promise.resolve({
            code: command.captureOutput ? 0 : 1,
            stdout: command.captureOutput ? "[]" : undefined,
          }),
      );

      assertEquals(output.code, 1);
      assertEquals(output.stdout, "");
      assertEquals(output.stderr, "podman-compose failed");
      assertEquals(
        await runCli(["view", "api"], databasePath),
        ["name: api", "id: 1", `workdir: ${resolve(workdir)}`].join("\n"),
      );
    });
  },
});
