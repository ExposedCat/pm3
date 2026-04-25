import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { runCli, runCliProcess, withEnv, withTempCli } from "./test_utils.ts";
import "../database/database.ts";

Deno.test({
  name: "cli process exits with an error for unknown commands",
  async fn() {
    const output = await runCliProcess(["missing-command"]);

    assertEquals(output.code, 1);
    assertEquals(output.stdout, "");
    assertEquals(
      output.stderr,
      [
        "pm3: Unknown command: missing-command",
        "Run `pm3 help` for usage.",
      ].join("\n"),
    );
  },
});

Deno.test({
  name: "cli process exits with an error for missing arguments",
  async fn() {
    const output = await runCliProcess(["create"]);

    assertEquals(output.code, 1);
    assertEquals(output.stdout, "");
    assertEquals(
      output.stderr,
      ["pm3: Missing workdir.", "Run `pm3 help` for usage."].join("\n"),
    );
  },
});

Deno.test({
  name: "cli process exits with an error for missing projects",
  async fn() {
    await withTempCli(async ({ databasePath }) => {
      const output = await runCliProcess(["view", "ghost"], databasePath);

      assertEquals(output.code, 1);
      assertEquals(output.stdout, "");
      assertEquals(
        output.stderr,
        ["pm3: Project not found: ghost", "Run `pm3 help` for usage."].join(
          "\n",
        ),
      );
    });
  },
});

Deno.test({
  name: "cli process hides internal errors without usage help",
  async fn() {
    await withTempCli(async ({ root }) => {
      const notADirectory = join(root, "not-a-directory");
      await Deno.writeTextFile(notADirectory, "");

      const output = await runCliProcess(
        ["list"],
        join(notADirectory, "pm3.sqlite"),
      );

      assertEquals(output.code, 1);
      assertEquals(output.stdout, "");
      assertEquals(output.stderr, "pm3: Command failed.");
    });
  },
});

Deno.test({
  name: "cli process creates and lists projects with PM3_DATABASE_PATH",
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "api");
      await Deno.mkdir(workdir);

      const createOutput = await runCliProcess(
        ["create", workdir, "--name", "api"],
        databasePath,
      );
      const listOutput = await runCliProcess(["list"], databasePath);

      assertEquals(createOutput.code, 0);
      assertEquals(createOutput.stderr, "");
      assertEquals(
        createOutput.stdout,
        ["name: api", "id: 1", `workdir: ${resolve(workdir)}`].join("\n"),
      );
      assertEquals(listOutput.code, 0);
      assertEquals(listOutput.stderr, "");
      assertEquals(listOutput.stdout, "api\t1");
    });
  },
});

Deno.test({
  name: "cli defaults database path under XDG_DATA_HOME",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ root }) => {
      const xdgDataHome = join(root, "xdg-data");
      const home = join(root, "home");
      const workdir = join(root, "api");
      await Deno.mkdir(home);
      await Deno.mkdir(workdir);

      await withEnv(
        {
          HOME: home,
          PM3_DATABASE_PATH: undefined,
          XDG_DATA_HOME: xdgDataHome,
        },
        async () => {
          const createOutput = await runCli([
            "create",
            workdir,
            "--name",
            "api",
          ]);
          const listOutput = await runCli(["list"]);

          assertEquals(
            createOutput,
            ["name: api", "id: 1", `workdir: ${resolve(workdir)}`].join("\n"),
          );
          assertEquals(listOutput, "api\t1");
        },
      );
      await Deno.stat(join(xdgDataHome, "pm3", "pm3.sqlite"));
    });
  },
});

Deno.test({
  name: "cli defaults database path under HOME when XDG_DATA_HOME is unset",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ root }) => {
      const home = join(root, "home");
      const workdir = join(root, "api");
      await Deno.mkdir(home);
      await Deno.mkdir(workdir);

      await withEnv(
        { HOME: home, PM3_DATABASE_PATH: undefined, XDG_DATA_HOME: undefined },
        async () => {
          const createOutput = await runCli([
            "create",
            workdir,
            "--name",
            "api",
          ]);
          const listOutput = await runCli(["list"]);

          assertEquals(
            createOutput,
            ["name: api", "id: 1", `workdir: ${resolve(workdir)}`].join("\n"),
          );
          assertEquals(listOutput, "api\t1");
        },
      );
      await Deno.stat(join(home, ".local", "share", "pm3", "pm3.sqlite"));
    });
  },
});
