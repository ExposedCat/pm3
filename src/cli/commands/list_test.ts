import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import type { ProcessCommand, ProcessResult } from "../command.ts";
import { runCli, withTempCli } from "../test_utils.ts";
import "../../database/database.ts";

Deno.test({
  name: "list prints projects ordered by name",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiDir = join(root, "api");
      const workerDir = join(root, "worker");
      await Deno.mkdir(apiDir);
      await Deno.mkdir(workerDir);
      await runCli(["create", workerDir, "--name", "worker"], databasePath);
      await runCli(["create", apiDir, "--name", "api"], databasePath);

      const output = await runCli(["list"], databasePath);

      assertEquals(
        output,
        [
          "NAME    STATE",
          "api     \x1b[31mdown\x1b[0m",
          "worker  \x1b[31mdown\x1b[0m",
        ].join("\n"),
      );
    });
  },
});

Deno.test({
  name: "list reads compose status and prints project state",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiDir = join(root, "api");
      await Deno.mkdir(apiDir);
      await Deno.writeTextFile(join(apiDir, "compose.yaml"), "services: {}\n");
      await runCli(["create", apiDir, "--name", "api"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([
            {
              State: "running",
              Status: "Up 14 hours",
              Created: currentTimestampSeconds() - 24 * 60 * 60,
              StartedAt: currentTimestampSeconds() - 14 * 60 * 60,
              Ports: [
                {
                  host_ip: "",
                  container_port: 3000,
                  host_port: 3101,
                  range: 1,
                  protocol: "tcp",
                },
              ],
            },
          ]),
        });
      };

      const output = await runCli(["list"], databasePath, runProcess);

      assertEquals(
        output,
        ["NAME  STATE", "api   \x1b[32mup\x1b[0m"].join("\n"),
      );
      assertEquals(commands, [
        {
          command: "podman-compose",
          args: ["ps", "--format", "json"],
          cwd: resolve(apiDir),
          captureOutput: true,
        },
      ]);
    });
  },
});

Deno.test({
  name: "list prints pending when compose containers have mixed states",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiDir = join(root, "api");
      await Deno.mkdir(apiDir);
      await Deno.writeTextFile(join(apiDir, "compose.yaml"), "services: {}\n");
      await runCli(["create", apiDir, "--name", "api"], databasePath);

      const output = await runCli(
        ["list"],
        databasePath,
        () =>
          Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              { State: "running", Status: "Up 1 minute" },
              { State: "exited", Status: "Exited (0) 1 minute ago" },
            ]),
          }),
      );

      assertEquals(
        output,
        ["NAME  STATE", "api   \x1b[33mpending\x1b[0m"].join("\n"),
      );
    });
  },
});

Deno.test({
  name: "detailed list omits duration for pending projects",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiDir = join(root, "api");
      await Deno.mkdir(apiDir);
      await Deno.writeTextFile(join(apiDir, "compose.yaml"), "services: {}\n");
      await runCli(["create", apiDir, "--name", "api"], databasePath);
      const now = currentTimestampSeconds();

      const output = await runCli(
        ["list", "--detailed"],
        databasePath,
        () =>
          Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              {
                State: "running",
                Status: "Up 1 minute",
                Created: now - 60 * 60,
                StartedAt: now - 60,
              },
              {
                State: "exited",
                Status: "Exited (0) 30 minutes ago",
                Created: now - 60 * 60,
                ExitedAt: now - 30 * 60,
              },
            ]),
          }),
      );

      assertEquals(
        output,
        [
          "NAME  STATE    CREATED  PORTS",
          "api   \x1b[33mpending\x1b[0m  1h",
        ].join("\n"),
      );
    });
  },
});

Deno.test({
  name: "detailed list prints created and ports reported by podman",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiDir = join(root, "api");
      await Deno.mkdir(apiDir);
      await Deno.writeTextFile(join(apiDir, "compose.yaml"), "services: {}\n");
      await runCli(["create", apiDir, "--name", "api"], databasePath);
      const now = currentTimestampSeconds();

      const output = await runCli(
        ["list", "--detailed"],
        databasePath,
        () =>
          Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              {
                State: "running",
                Status: "Up 2 days 3 minutes",
                Created: now - (3 * 24 * 60 * 60 + 4 * 60 * 60),
                StartedAt: now - (2 * 24 * 60 * 60 + 3 * 60),
                Ports: [
                  {
                    host_ip: "",
                    container_port: 3000,
                    host_port: 3101,
                    range: 1,
                    protocol: "tcp",
                  },
                ],
              },
              {
                State: "running",
                Status: "Up 2 days 3 minutes",
                Created: now - (3 * 24 * 60 * 60 + 4 * 60 * 60),
                StartedAt: now - (2 * 24 * 60 * 60 + 3 * 60),
                Ports: [
                  {
                    host_ip: "",
                    container_port: 3000,
                    host_port: 3102,
                    range: 1,
                    protocol: "tcp",
                  },
                ],
              },
            ]),
          }),
      );

      assertEquals(
        output,
        [
          "NAME  STATE       CREATED  PORTS",
          "api   \x1b[32mup (2d 3m)\x1b[0m  3d 4h    0.0.0.0:3101->3000/tcp; 0.0.0.0:3102->3000/tcp",
        ].join("\n"),
      );
    });
  },
});

Deno.test({
  name: "detailed list accepts short option",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath }) => {
      const output = await runCli(["list", "-d"], databasePath);

      assertEquals(output, "NAME  STATE  CREATED  PORTS");
    });
  },
});

function currentTimestampSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
