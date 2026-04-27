import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import type { ProcessCommand, ProcessResult } from "../command.ts";
import { runCli, runCliProcess, withTempCli } from "../test_utils.ts";
import "../../database/database.ts";

Deno.test({
  name: "lifecycle commands run podman-compose in the project workdir",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        return Promise.resolve({ code: 0 });
      };

      await runCli(["start", "api"], databasePath, runProcess);
      await runCli(["stop", "api"], databasePath, runProcess);
      await runCli(["restart", "api"], databasePath, runProcess);

      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(workdir),
        },
        {
          command: "podman-compose",
          args: ["stop"],
          cwd: resolve(workdir),
        },
        {
          command: "podman-compose",
          args: ["restart"],
          cwd: resolve(workdir),
        },
      ]);
    });
  },
});

Deno.test({
  name: "lifecycle process failures print compose errors",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const output = await runCliProcess(
        ["start", "api"],
        databasePath,
        () => Promise.resolve({ code: 1 }),
      );

      assertEquals(output.code, 1);
      assertEquals(output.stdout, "");
      assertEquals(output.stderr, "podman-compose failed");
    });
  },
});

Deno.test({
  name: "lifecycle commands print pm3 progress and warning totals",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const output = await runCli(
        ["start", "api"],
        databasePath,
        () =>
          Promise.resolve({ code: 0, stderr: "WARN: image uses latest tag" }),
      );

      assertEquals(output, "Finished with 1 warnings");
    });
  },
});

Deno.test({
  name: "verbose lifecycle commands pass through to podman-compose execution",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        return Promise.resolve({ code: 0 });
      };

      await runCli(["start", "api", "--verbose"], databasePath, runProcess);

      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(workdir),
          verbose: true,
        },
      ]);
    });
  },
});

Deno.test({
  name: "detached lifecycle commands run compose silently in the background",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        return Promise.resolve({
          code: 0,
          stderr: "WARN: image uses latest tag",
        });
      };

      const output = await runCli(
        ["start", "--detach", "api"],
        databasePath,
        runProcess,
      );

      assertEquals(output, "");
      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(workdir),
          detached: true,
        },
      ]);
    });
  },
});

Deno.test({
  name: "start and restart can rebuild project containers",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        return Promise.resolve({ code: 0 });
      };

      await runCli(["start", "api", "--build"], databasePath, runProcess);
      await runCli(["restart", "-b", "api"], databasePath, runProcess);

      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["build"],
          cwd: resolve(workdir),
        },
        {
          command: "podman-compose",
          args: ["up", "-d", "--force-recreate"],
          cwd: resolve(workdir),
        },
        {
          command: "podman-compose",
          args: ["build"],
          cwd: resolve(workdir),
        },
        {
          command: "podman-compose",
          args: ["up", "-d", "--force-recreate"],
          cwd: resolve(workdir),
        },
      ]);
    });
  },
});

Deno.test({
  name: "no-cache rebuilds without using the build cache",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        return Promise.resolve({ code: 0 });
      };

      await runCli(["start", "-c", "api"], databasePath, runProcess);

      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["build", "--no-cache"],
          cwd: resolve(workdir),
        },
        {
          command: "podman-compose",
          args: ["up", "-d", "--force-recreate"],
          cwd: resolve(workdir),
        },
      ]);
    });
  },
});
