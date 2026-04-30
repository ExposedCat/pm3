import { assertEquals, assertRejects } from "@std/assert";
import { join, resolve } from "@std/path";
import { commandDefinitions } from "../cli/commands.ts";
import { formatHelpText } from "../cli/help.ts";
import type {
  LineStreamCommand,
  ProcessCommand,
  ProcessResult,
} from "../cli/runtime/process.ts";
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
        },
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(zetaWorkdir),
        },
      ]);
    });
  },
});

Deno.test({
  name: "daemon starts only enabled down projects on startup",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      const workerWorkdir = join(root, "worker");
      await Deno.mkdir(apiWorkdir);
      await Deno.mkdir(workerWorkdir);
      await Deno.writeTextFile(
        join(apiWorkdir, "compose.yaml"),
        "services: {}\n",
      );
      await Deno.writeTextFile(
        join(workerWorkdir, "compose.yaml"),
        "services: {}\n",
      );
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(["create", workerWorkdir, "--name", "worker"], databasePath);
      await runCli(["enable", "api"], databasePath);
      await runCli(["enable", "worker"], databasePath);

      const commands: ProcessCommand[] = [];
      const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
        commands.push(command);
        if (command.args[0] === "ps") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              {
                State:
                  command.cwd === resolve(apiWorkdir) ? "running" : "exited",
              },
            ]),
          });
        }

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
          args: ["ps", "--format", "json"],
          cwd: resolve(apiWorkdir),
          captureOutput: true,
        },
        {
          command: "podman-compose",
          args: ["ps", "--format", "json"],
          cwd: resolve(workerWorkdir),
          captureOutput: true,
        },
        {
          command: "podman-compose",
          args: ["up", "-d"],
          cwd: resolve(workerWorkdir),
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
        },
      ]);
    });
  },
});

Deno.test({
  name: "daemon logs compose health changes while starting enabled projects",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      const disabledWorkdir = join(root, "disabled");
      await Deno.mkdir(apiWorkdir);
      await Deno.mkdir(disabledWorkdir);
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(
        ["create", disabledWorkdir, "--name", "disabled"],
        databasePath,
      );
      await runCli(["enable", "api"], databasePath);

      let emitEvent: ((line: string) => void) | undefined;
      let stopped = false;
      const lineStreamCommands: LineStreamCommand[] = [];
      const lines = await captureConsoleLog(async () => {
        await withDaemonDatabase(databasePath, async (db) => {
          await runDaemon(
            db,
            {
              databasePath,
              runLineStream: (command, onLine) => {
                lineStreamCommands.push(command);
                emitEvent = onLine;
                return Promise.resolve({
                  stop() {
                    stopped = true;
                    return Promise.resolve();
                  },
                });
              },
              runProcess: () => {
                emitEvent?.(healthEvent("starting", "api", apiWorkdir));
                emitEvent?.(healthEvent("healthy", "api", apiWorkdir));
                emitEvent?.(healthEvent("unhealthy", "api", apiWorkdir));
                emitEvent?.(healthEvent("healthy", "worker", disabledWorkdir));
                return Promise.resolve({ code: 0 });
              },
            },
            { wait: () => Promise.resolve() },
          );
        });
      });

      assertEquals(lineStreamCommands, [
        {
          command: "podman",
          args: [
            "events",
            "--format",
            "json",
            "--filter",
            "type=container",
            "--since",
            lineStreamCommands[0]?.args[6] ?? "",
          ],
        },
      ]);
      assertEquals(lines, [
        "Starting PM3 Daemon...",
        "api/api pending",
        "api/api healthy",
        "api/api degraded",
        "disabled/worker healthy",
      ]);
      assertEquals(stopped, true);
    });
  },
});

Deno.test({
  name: "daemon logs compose health from startup progress",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      await Deno.mkdir(apiWorkdir);
      await Deno.writeTextFile(
        join(apiWorkdir, "compose.yaml"),
        "services: {}\n",
      );
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(["enable", "api"], databasePath);

      let startupEvents: ((line: string) => void) | undefined;
      const lines = await captureConsoleLog(async () => {
        await withDaemonDatabase(databasePath, async (db) => {
          await runDaemon(
            db,
            {
              databasePath,
              runLineStream: (command, onLine) => {
                if (
                  command.args.includes(
                    `label=com.docker.compose.project.working_dir=${apiWorkdir}`,
                  )
                ) {
                  startupEvents = onLine;
                }

                return Promise.resolve({ stop: () => Promise.resolve() });
              },
              runProcess: (command) => {
                if (command.args[0] === "ps") {
                  return Promise.resolve({ code: 0, stdout: "[]" });
                }

                if (command.args[0] === "config") {
                  return Promise.resolve({ code: 0, stdout: "web\n" });
                }

                startupEvents?.(composeEvent("start", "web"));
                startupEvents?.(healthEvent("healthy", "web", apiWorkdir));
                return Promise.resolve({ code: 0 });
              },
            },
            { wait: () => Promise.resolve() },
          );
        });
      });

      assertEquals(lines, ["Starting PM3 Daemon...", "api/web healthy"]);
    });
  },
});

Deno.test({
  name: "daemon does not log unchanged compose health after restart",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      await Deno.mkdir(apiWorkdir);
      await Deno.writeTextFile(
        join(apiWorkdir, "compose.yaml"),
        "services: {}\n",
      );
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(["enable", "api"], databasePath);

      let emitEvent: ((line: string) => void) | undefined;
      const lines = await captureConsoleLog(async () => {
        await withDaemonDatabase(databasePath, async (db) => {
          await runDaemon(
            db,
            {
              databasePath,
              runLineStream: (_command, onLine) => {
                emitEvent = onLine;
                return Promise.resolve({ stop: () => Promise.resolve() });
              },
              runProcess: (command) => {
                if (command.args[0] === "ps") {
                  return Promise.resolve({
                    code: 0,
                    stdout: JSON.stringify([
                      {
                        Labels: {
                          "com.docker.compose.service": "web",
                        },
                        Status: "Up 1 minute (healthy)",
                      },
                    ]),
                  });
                }

                return Promise.resolve({ code: 0 });
              },
            },
            {
              wait() {
                emitEvent?.(healthEvent("healthy", "web", apiWorkdir));
                emitEvent?.(healthEvent("unhealthy", "web", apiWorkdir));
                return Promise.resolve();
              },
            },
          );
        });
      });

      assertEquals(lines, ["Starting PM3 Daemon...", "api/web degraded"]);
    });
  },
});

Deno.test({
  name: "daemon periodically logs changed compose health",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      await Deno.mkdir(apiWorkdir);
      await Deno.writeTextFile(
        join(apiWorkdir, "compose.yaml"),
        "services: {}\n",
      );
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(["enable", "api"], databasePath);

      let psCalls = 0;
      const lines = await captureConsoleLog(async () => {
        await withDaemonDatabase(databasePath, async (db) => {
          await runDaemon(
            db,
            {
              databasePath,
              runProcess: (command) => {
                if (command.args[0] !== "ps") {
                  return Promise.resolve({ code: 0 });
                }

                psCalls += 1;
                return Promise.resolve({
                  code: 0,
                  stdout: JSON.stringify([
                    {
                      Labels: {
                        "com.docker.compose.service": "web",
                      },
                      State: "running",
                      Status:
                        psCalls === 1
                          ? "Up 1 minute (healthy)"
                          : "Up 1 minute (unhealthy)",
                    },
                  ]),
                });
              },
            },
            {
              reconcileIntervalMs: 1,
              async wait() {
                await delay(20);
              },
            },
          );
        });
      });

      assertEquals(lines, ["Starting PM3 Daemon...", "api/web degraded"]);
    });
  },
});

Deno.test({
  name: "daemon periodically logs newly discovered compose health",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      await Deno.mkdir(apiWorkdir);
      await Deno.writeTextFile(
        join(apiWorkdir, "compose.yaml"),
        "services: {}\n",
      );
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(["enable", "api"], databasePath);

      let psCalls = 0;
      const lines = await captureConsoleLog(async () => {
        await withDaemonDatabase(databasePath, async (db) => {
          await runDaemon(
            db,
            {
              databasePath,
              runProcess: (command) => {
                if (command.args[0] !== "ps") {
                  return Promise.resolve({ code: 0 });
                }

                psCalls += 1;
                return Promise.resolve({
                  code: 0,
                  stdout:
                    psCalls === 1
                      ? "[]"
                      : JSON.stringify([
                          {
                            Labels: {
                              "com.docker.compose.service": "web",
                            },
                            State: "running",
                            Status: "Up 1 minute (healthy)",
                          },
                        ]),
                });
              },
            },
            {
              reconcileIntervalMs: 1,
              async wait() {
                await delay(20);
              },
            },
          );
        });
      });

      assertEquals(lines, ["Starting PM3 Daemon...", "api/web healthy"]);
    });
  },
});

Deno.test({
  name: "daemon periodically logs unchanged health for replaced containers",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiWorkdir = join(root, "api");
      await Deno.mkdir(apiWorkdir);
      await Deno.writeTextFile(
        join(apiWorkdir, "compose.yaml"),
        "services: {}\n",
      );
      await runCli(["create", apiWorkdir, "--name", "api"], databasePath);
      await runCli(["enable", "api"], databasePath);

      let psCalls = 0;
      const lines = await captureConsoleLog(async () => {
        await withDaemonDatabase(databasePath, async (db) => {
          await runDaemon(
            db,
            {
              databasePath,
              runProcess: (command) => {
                if (command.args[0] !== "ps") {
                  return Promise.resolve({ code: 0 });
                }

                psCalls += 1;
                return Promise.resolve({
                  code: 0,
                  stdout: JSON.stringify([
                    {
                      Id: psCalls === 1 ? "old-container" : "new-container",
                      Labels: {
                        "com.docker.compose.service": "web",
                      },
                      State: "running",
                      Status: "Up 1 minute (healthy)",
                    },
                  ]),
                });
              },
            },
            {
              reconcileIntervalMs: 1,
              async wait() {
                await delay(20);
              },
            },
          );
        });
      });

      assertEquals(lines, ["Starting PM3 Daemon...", "api/web healthy"]);
    });
  },
});

Deno.test({
  name: "daemon watches projects created after startup without starting them",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workerWorkdir = join(root, "worker");
      await Deno.mkdir(workerWorkdir);

      let emitEvent: ((line: string) => void) | undefined;
      const commands: ProcessCommand[] = [];
      const lines = await captureConsoleLog(async () => {
        await withDaemonDatabase(databasePath, async (db) => {
          await runDaemon(
            db,
            {
              databasePath,
              runLineStream: (_command, onLine) => {
                emitEvent = onLine;
                return Promise.resolve({ stop: () => Promise.resolve() });
              },
              runProcess: (command) => {
                commands.push(command);
                return Promise.resolve({ code: 0 });
              },
            },
            {
              reconcileIntervalMs: 1,
              async wait() {
                await runCli(
                  ["create", workerWorkdir, "--name", "worker"],
                  databasePath,
                );
                await delay(20);
                emitEvent?.(healthEvent("healthy", "api", workerWorkdir));
              },
            },
          );
        });
      });

      assertEquals(commands, []);
      assertEquals(lines, ["Starting PM3 Daemon...", "worker/api healthy"]);
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

async function captureConsoleLog(
  callback: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;

  console.log = (...data: unknown[]) => {
    lines.push(data.map(String).join(" "));
  };

  try {
    await callback();
    return lines;
  } finally {
    console.log = originalLog;
  }
}

function healthEvent(
  healthStatus: string,
  service: string,
  workingDir: string,
): string {
  return JSON.stringify({
    health_status: healthStatus,
    Attributes: {
      "com.docker.compose.project.working_dir": workingDir,
      "com.docker.compose.service": service,
    },
  });
}

function composeEvent(status: string, service: string): string {
  return JSON.stringify({
    Status: status,
    Attributes: { "com.docker.compose.service": service },
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
