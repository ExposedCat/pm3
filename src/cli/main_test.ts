import { assertEquals, assertThrows } from "@std/assert";
import { join, resolve } from "@std/path";
import { commandDefinitions, parseArgs, runCommand } from "./commands.ts";
import { formatHelpText } from "./help.ts";
import { runCliMain } from "./main.ts";
import "../database/database.ts";

Deno.test("cli prints help", async () => {
  const expected = formatHelpText(commandDefinitions).trimEnd();

  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const output = await runCli(args);

    assertEquals(output, expected);
  }
});

Deno.test("help rejects extra arguments", () => {
  for (
    const args of [
      ["help", "extra"],
      ["--help", "extra"],
      ["-h", "extra"],
    ]
  ) {
    assertThrows(
      () => parseArgs(args),
      Error,
      "Unexpected argument for help: extra",
    );
  }
});

Deno.test("help text is generated from command metadata", () => {
  const output = formatHelpText(commandDefinitions);

  for (const command of commandDefinitions) {
    const usage = [
      command.names[0],
      ...command.args,
      ...(command.options ?? []),
    ].join(" ");

    assertEquals(output.includes(`  pm3 ${usage}`), true);
    assertEquals(output.includes(command.description), true);
  }
});

Deno.test({
  name: "cli creates a project with an explicit name",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "service");
      await Deno.mkdir(workdir);

      const output = await runCli(
        ["create", workdir, "--name", "api"],
        databasePath,
      );

      assertEquals(
        output,
        [
          "name: api",
          "id: 1",
          `workdir: ${resolve(workdir)}`,
        ].join("\n"),
      );
    });
  },
});

Deno.test({
  name: "cli creates a project named after the workdir by default",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "worker");
      await Deno.mkdir(workdir);

      const output = await runCli(["create", workdir], databasePath);

      assertEquals(
        output,
        [
          "name: worker",
          "id: 1",
          `workdir: ${resolve(workdir)}`,
        ].join("\n"),
      );
    });
  },
});

Deno.test({
  name: "cli lists projects",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiDir = join(root, "api");
      const workerDir = join(root, "worker");
      await Deno.mkdir(apiDir);
      await Deno.mkdir(workerDir);
      await runCli(["create", apiDir, "--name", "api"], databasePath);
      await runCli(["create", workerDir, "--name", "worker"], databasePath);

      const output = await runCli(["list"], databasePath);

      assertEquals(output, ["api\t1", "worker\t2"].join("\n"));
    });
  },
});

Deno.test({
  name: "cli views a project by name",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiDir = join(root, "api");
      const workerDir = join(root, "worker");
      await Deno.mkdir(apiDir);
      await Deno.mkdir(workerDir);
      await runCli(["create", apiDir, "--name", "api"], databasePath);
      await runCli(["create", workerDir, "--name", "worker"], databasePath);

      const output = await runCli(["view", "worker"], databasePath);

      assertEquals(
        output,
        [
          "name: worker",
          "id: 2",
          `workdir: ${resolve(workerDir)}`,
        ].join("\n"),
      );
    });
  },
});

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
        [
          "pm3: Project not found: ghost",
          "Run `pm3 help` for usage.",
        ].join("\n"),
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

async function runCli(
  args: string[],
  databasePath?: string,
): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;

  console.log = (...data: unknown[]) => {
    lines.push(data.map(String).join(" "));
  };

  try {
    await runCommand(parseArgs(args), { databasePath });
    return lines.join("\n");
  } finally {
    console.log = originalLog;
  }
}

type CliProcessOutput = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runCliProcess(
  args: string[],
  databasePath?: string,
): Promise<CliProcessOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...data: unknown[]) => {
    stdout.push(data.map(String).join(" "));
  };
  console.error = (...data: unknown[]) => {
    stderr.push(data.map(String).join(" "));
  };

  try {
    return await withEnv(
      { PM3_DATABASE_PATH: databasePath },
      async () => ({
        code: await runCliMain(args),
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
      }),
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(env).map((name) => [name, Deno.env.get(name)]),
  );

  try {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) {
        Deno.env.delete(name);
      } else {
        Deno.env.set(name, value);
      }
    }

    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        Deno.env.delete(name);
      } else {
        Deno.env.set(name, value);
      }
    }
  }
}

async function withTempCli(
  callback: (context: { databasePath: string; root: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "pm3-cli-test-" });

  try {
    await callback({ databasePath: join(root, "pm3.sqlite"), root });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
