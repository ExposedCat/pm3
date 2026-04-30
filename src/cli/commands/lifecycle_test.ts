import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import type { ProcessCommand, ProcessResult } from "../runtime/process.ts";
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
          args: ["down", "--remove-orphans"],
          cwd: resolve(workdir),
        },
        {
          command: "podman-compose",
          args: ["down", "--remove-orphans"],
          cwd: resolve(workdir),
        },
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
  name: "lifecycle process failures print compose errors",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const output = await runCliProcess(["start", "api"], databasePath, () =>
        Promise.resolve({ code: 1 }),
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

      const output = await runCli(["start", "api"], databasePath, () =>
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
  name: "detached lifecycle commands only change lifecycle output",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);
      await runCli(["create", workdir, "--name", "api"], databasePath);

      const scenarios = [
        {
          args: ["start", "api"],
          detachedArgs: ["start", "--detach", "api"],
          expectedCommands: [["up", "-d"]],
        },
        {
          args: ["stop", "api"],
          detachedArgs: ["stop", "--detach", "api"],
          expectedCommands: [["down", "--remove-orphans"]],
        },
        {
          args: ["restart", "api"],
          detachedArgs: ["restart", "--detach", "api"],
          expectedCommands: [["down", "--remove-orphans"], ["up", "-d"]],
        },
        {
          args: ["start", "--build", "api"],
          detachedArgs: ["start", "--build", "--detach", "api"],
          expectedCommands: [["build"], ["up", "-d", "--force-recreate"]],
        },
        {
          args: ["restart", "--build", "api"],
          detachedArgs: ["restart", "--build", "--detach", "api"],
          expectedCommands: [
            ["down", "--remove-orphans"],
            ["build"],
            ["up", "-d", "--force-recreate"],
          ],
        },
      ] as const;

      for (const scenario of scenarios) {
        const regularCommands: ProcessCommand[] = [];
        const detachedCommands: ProcessCommand[] = [];
        const runRegularProcess = (
          command: ProcessCommand,
        ): Promise<ProcessResult> => {
          regularCommands.push(command);
          return Promise.resolve({
            code: 0,
            stderr: "WARN: image uses latest tag",
          });
        };
        const runDetachedProcess = (
          command: ProcessCommand,
        ): Promise<ProcessResult> => {
          detachedCommands.push(command);
          return Promise.resolve({
            code: 0,
            stderr: "WARN: image uses latest tag",
          });
        };

        const regularOutput = await runCli(
          [...scenario.args],
          databasePath,
          runRegularProcess,
        );
        const detachedOutput = await runCli(
          [...scenario.detachedArgs],
          databasePath,
          runDetachedProcess,
        );

        assertEquals(regularOutput.includes("Finished with 1 warnings"), true);
        assertEquals(detachedOutput, "");
        assertEquals(
          regularCommands.map(({ args, command, cwd }) => ({
            args,
            command,
            cwd,
          })),
          scenario.expectedCommands.map((args) => ({
            command: "podman-compose",
            args,
            cwd: resolve(workdir),
          })),
        );
        assertEquals(
          detachedCommands.map(({ args, command, cwd }) => ({
            args,
            command,
            cwd,
          })),
          regularCommands.map(({ args, command, cwd }) => ({
            args,
            command,
            cwd,
          })),
        );
      }
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
          args: ["down", "--remove-orphans"],
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

Deno.test({
  name: "detached rebuild waits for build before detaching recreated containers",
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

      await runCli(
        ["start", "--build", "--detach", "api"],
        databasePath,
        runProcess,
      );

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
      ]);
    });
  },
});
