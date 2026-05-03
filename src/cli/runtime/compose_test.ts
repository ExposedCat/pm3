import { assertEquals, assertRejects } from "@std/assert";
import { assert } from "@std/assert/assert";
import { join } from "@std/path";
import { runProjectCompose } from "./compose.ts";
import type { ProcessCommand } from "./process.ts";

Deno.test({
  name:
    "non-verbose compose output prints notices below the affected progress step",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;
      const lines = await captureConsoleLog(async () => {
        await runProjectCompose(project, ["up", "-d"], {
          runLineStream: (_command, onLine) => {
            emitEvent = onLine;
            return Promise.resolve({ stop: () => Promise.resolve() });
          },
          runProcess: (command) => {
            if (isComposeResolvedConfigCommand(command)) {
              return Promise.resolve({
                code: 0,
                stdout: "services:\n  web: {}\n",
              });
            }
            if (isComposeConfigCommand(command)) {
              return Promise.resolve({ code: 0, stdout: "web\n" });
            }

            command.onOutput?.({
              stream: "stderr",
              text:
                "podman start pm3_web_1\nWARN: pm3_web_1 image uses latest tag\n",
            });
            emitEvent?.(composeEvent("start", "web"));
            return Promise.resolve({
              code: 0,
              stderr: "WARN: pm3_web_1 image uses latest tag",
            });
          },
        });
      });

      assertEquals(lines, [
        "Starting api/web",
        "    \x1b[33mWARN: pm3_web_1 image uses latest tag\x1b[0m",
        "Started api/web",
      ]);
    });
  },
});

Deno.test({
  name:
    "compose output attributes overlapping service names to the longest match",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;
      const lines = await captureConsoleLog(async () => {
        await runProjectCompose(project, ["up", "-d"], {
          runLineStream: (_command, onLine) => {
            emitEvent = onLine;
            return Promise.resolve({ stop: () => Promise.resolve() });
          },
          runProcess: (command) => {
            if (isComposeResolvedConfigCommand(command)) {
              return Promise.resolve({
                code: 0,
                stdout: "services:\n  web: {}\n  web_api: {}\n",
              });
            }
            if (isComposeConfigCommand(command)) {
              return Promise.resolve({ code: 0, stdout: "web\nweb_api\n" });
            }

            command.onOutput?.({
              stream: "stderr",
              text: "podman start pm3_web_api_1\nWARN: pm3_web_api_1 warning\n",
            });
            emitEvent?.(composeEvent("start", "web_api"));
            return Promise.resolve({
              code: 0,
              stderr: "WARN: pm3_web_api_1 warning",
            });
          },
        });
      });

      assertEquals(lines, [
        "Starting api/web",
        "Starting api/web_api",
        "    \x1b[33mWARN: pm3_web_api_1 warning\x1b[0m",
        "Started api/web_api",
      ]);
    });
  },
});

Deno.test({
  name: "compose progress starts every discovered service",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      const lines = await captureConsoleLog(async () => {
        await runProjectCompose(project, ["up", "-d"], {
          runLineStream: () =>
            Promise.resolve({ stop: () => Promise.resolve() }),
          runProcess: (command) => {
            if (isComposeResolvedConfigCommand(command)) {
              return Promise.resolve({
                code: 0,
                stdout: "services:\n  web: {}\n  worker: {}\n",
              });
            }
            if (isComposeConfigCommand(command)) {
              return Promise.resolve({
                code: 0,
                stdout: "web\nworker\n",
              });
            }

            return Promise.resolve({ code: 0 });
          },
        });
      });

      assertEquals(lines, ["Starting api/web", "Starting api/worker"]);
    });
  },
});

Deno.test({
  name: "non-verbose compose output prints podman logfmt warning messages",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;
      const warning =
        'time="2026-04-27T12:00:00Z" level=warning msg="StopSignal SIGTERM failed to stop container pm3_web_1"';
      const lines = await captureConsoleLog(async () => {
        await runProjectCompose(project, ["stop"], {
          runLineStream: (_command, onLine) => {
            emitEvent = onLine;
            return Promise.resolve({ stop: () => Promise.resolve() });
          },
          runProcess: (command) => {
            if (isComposeResolvedConfigCommand(command)) {
              return Promise.resolve({
                code: 0,
                stdout: "services:\n  web: {}\n",
              });
            }
            if (isComposeConfigCommand(command)) {
              return Promise.resolve({ code: 0, stdout: "web\n" });
            }

            command.onOutput?.({
              stream: "stderr",
              text: `podman stop pm3_web_1\n${warning}\n`,
            });
            emitEvent?.(composeEvent("stop", "web"));
            return Promise.resolve({ code: 0, stderr: warning });
          },
        });
      });

      assertEquals(lines, [
        "Stopping api/web",
        "    \x1b[33mStopSignal SIGTERM failed to stop container pm3_web_1\x1b[0m",
        "Stopped api/web",
      ]);
    });
  },
});

Deno.test({
  name: "terminal compose progress redraws wrapped warning lines in place",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;
      const output = await captureTerminalOutput(20, async () => {
        await runProjectCompose(project, ["up", "-d"], {
          runLineStream: (_command, onLine) => {
            emitEvent = onLine;
            return Promise.resolve({ stop: () => Promise.resolve() });
          },
          runProcess: (command) => {
            if (isComposeResolvedConfigCommand(command)) {
              return Promise.resolve({
                code: 0,
                stdout: "services:\n  web: {}\n",
              });
            }
            if (isComposeConfigCommand(command)) {
              return Promise.resolve({ code: 0, stdout: "web\n" });
            }

            command.onOutput?.({
              stream: "stderr",
              text:
                "podman start pm3_web_1\nWARN: pm3_web_1 image uses a very long latest tag\n",
            });
            emitEvent?.(composeEvent("start", "web"));
            return Promise.resolve({
              code: 0,
              stderr: "WARN: pm3_web_1 image uses a very long latest tag",
            });
          },
        });
      });

      assert(
        output.includes("\x1b[5A\r\x1b[J"),
        "expected the redraw to move over the wrapped progress and warning rows",
      );
    });
  },
});

Deno.test({
  name: "completed compose progress uses final tense",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      for (
        const [args, status, expected] of [
          [["stop"], "stop", ["Stopping api/web", "Stopped api/web"]],
          [["down"], "remove", ["Removing api/web", "Removed api/web"]],
        ] as const
      ) {
        let emitEvent: ((line: string) => void) | undefined;
        const lines = await captureConsoleLog(async () => {
          await runProjectCompose(project, args, {
            runLineStream: (_command, onLine) => {
              emitEvent = onLine;
              return Promise.resolve({ stop: () => Promise.resolve() });
            },
            runProcess: (command) => {
              if (isComposeConfigCommand(command)) {
                return Promise.resolve({ code: 0, stdout: "web\n" });
              }

              command.onOutput?.({
                stream: "stderr",
                text: `podman ${getPodmanCommand(status)} pm3_web_1\n`,
              });
              emitEvent?.(composeEvent(status, "web"));
              return Promise.resolve({ code: 0 });
            },
          });
        });

        assertEquals(lines, [...expected]);
      }
    });
  },
});

Deno.test({
  name: "compose progress checks service health after container start",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;
      const lines = await captureConsoleLog(async () => {
        await runProjectCompose(project, ["up", "-d"], {
          runLineStream: (_command, onLine) => {
            emitEvent = onLine;
            return Promise.resolve({ stop: () => Promise.resolve() });
          },
          runProcess: (command) => {
            if (isComposeResolvedConfigCommand(command)) {
              return Promise.resolve({
                code: 0,
                stdout: "services:\n  web: {}\n",
              });
            }
            if (isComposeConfigCommand(command)) {
              return Promise.resolve({ code: 0, stdout: "web\n" });
            }

            emitEvent?.(composeEvent("start", "web"));
            emitEvent?.(healthEvent("starting", "web"));
            emitEvent?.(healthEvent("healthy", "web"));
            return Promise.resolve({ code: 0 });
          },
        });
      });

      assertEquals(lines, [
        "Starting api/web",
        "Started api/web",
        "    \x1b[33mChecking health\x1b[0m...",
        "    \x1b[32mHealthy\x1b[0m",
      ]);
    });
  },
});

Deno.test({
  name: "compose start fails after final unhealthy health status",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;
      let aborted = false;
      const commands: ProcessCommand[] = [];
      const lines = await captureConsoleLog(async () => {
        await assertRejects(
          () =>
            runProjectCompose(project, ["up", "-d"], {
              runLineStream: (_command, onLine) => {
                emitEvent = onLine;
                return Promise.resolve({ stop: () => Promise.resolve() });
              },
              runProcess: (command) => {
                commands.push(command);
                if (isComposeResolvedConfigCommand(command)) {
                  return Promise.resolve({
                    code: 0,
                    stdout: "services:\n  web: {}\n",
                  });
                }
                if (isComposeConfigCommand(command)) {
                  return Promise.resolve({ code: 0, stdout: "web\n" });
                }
                if (
                  command.args[0] === "--verbose" &&
                  command.args[1] === "down" &&
                  command.args[2] === "--remove-orphans"
                ) {
                  emitEvent?.(composeEvent("remove", "web"));
                  return Promise.resolve({ code: 0 });
                }

                command.signal?.addEventListener("abort", () => {
                  aborted = true;
                });
                emitEvent?.(composeEvent("start", "web"));
                emitEvent?.(healthEvent("starting", "web"));
                emitEvent?.(healthEvent("unhealthy", "web"));
                return Promise.resolve({ code: 0 });
              },
            }),
          Error,
          "Unhealthy services: api/web",
        );
      });

      assertEquals(aborted, true);
      assertEquals(
        commands.map(({ args, command }) => ({ args, command })),
        [
          { command: "podman-compose", args: ["config"] },
          { command: "podman-compose", args: ["config", "--services"] },
          { command: "podman-compose", args: ["--verbose", "up", "-d"] },
          { command: "podman-compose", args: ["config", "--services"] },
          {
            command: "podman-compose",
            args: ["--verbose", "down", "--remove-orphans"],
          },
        ],
      );
      assertEquals(lines, [
        "Starting api/web",
        "Started api/web",
        "    \x1b[33mChecking health\x1b[0m...",
        "    \x1b[31mUnhealthy\x1b[0m",
        "Stopping api/web",
        "Stopped api/web",
      ]);
    });
  },
});

Deno.test({
  name:
    "compose start fails when a required service becomes permanently blocked by deps",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;
      let aborted = false;
      const commands: ProcessCommand[] = [];

      await assertRejects(
        () =>
          runProjectCompose(project, ["up", "-d"], {
            runLineStream: (_command, onLine) => {
              emitEvent = onLine;
              return Promise.resolve({ stop: () => Promise.resolve() });
            },
            runProcess: (command) => {
              commands.push(command);
              if (isComposeResolvedConfigCommand(command)) {
                return Promise.resolve({
                  code: 0,
                  stdout:
                    "services:\n  api:\n    depends_on:\n      db:\n        condition: service_healthy\n  db: {}\nx-pm3:\n  startup:\n    required_services:\n      - api\n",
                });
              }
              if (isComposeConfigCommand(command)) {
                return Promise.resolve({ code: 0, stdout: "api\ndb\n" });
              }
              if (isComposeDownCommand(command)) {
                emitEvent?.(composeEvent("remove", "db"));
                return Promise.resolve({ code: 0 });
              }

              command.signal?.addEventListener("abort", () => {
                aborted = true;
              });
              emitEvent?.(composeEvent("start", "db"));
              emitEvent?.(healthEvent("starting", "db"));
              emitEvent?.(healthEvent("unhealthy", "db"));
              return Promise.resolve({ code: 0 });
            },
          }),
        Error,
        "Required services permanently unstartable: api",
      );

      assertEquals(aborted, true);
      assertEquals(
        commands.map(({ args, command }) => ({ args, command })),
        [
          { command: "podman-compose", args: ["config"] },
          { command: "podman-compose", args: ["config", "--services"] },
          { command: "podman-compose", args: ["--verbose", "up", "-d"] },
          { command: "podman-compose", args: ["config", "--services"] },
          {
            command: "podman-compose",
            args: ["--verbose", "down", "--remove-orphans"],
          },
        ],
      );
    });
  },
});

Deno.test({
  name:
    "compose start returns without cleanup when unhealthy services are not fatal under startup policy",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;
      const commands: ProcessCommand[] = [];
      const lines = await captureConsoleLog(async () => {
        await runProjectCompose(project, ["up", "-d"], {
          runLineStream: (_command, onLine) => {
            emitEvent = onLine;
            return Promise.resolve({ stop: () => Promise.resolve() });
          },
          runProcess: (command) => {
            commands.push(command);
            if (isComposeResolvedConfigCommand(command)) {
              return Promise.resolve({
                code: 0,
                stdout:
                  "services:\n  api:\n    depends_on:\n      db:\n        condition: service_healthy\n  prebuilt: {}\n  db: {}\nx-pm3:\n  startup:\n    mode: watcher\n    required_services:\n      - prebuilt\n",
              });
            }
            if (isComposeConfigCommand(command)) {
              return Promise.resolve({
                code: 0,
                stdout: "api\nprebuilt\ndb\n",
              });
            }

            emitEvent?.(composeEvent("start", "prebuilt"));
            emitEvent?.(composeEvent("start", "db"));
            emitEvent?.(healthEvent("unhealthy", "db"));
            return Promise.resolve({ code: 130 });
          },
        });
      });

      assertEquals(
        commands.map(({ args, command }) => ({ args, command })),
        [
          { command: "podman-compose", args: ["config"] },
          { command: "podman-compose", args: ["config", "--services"] },
          { command: "podman-compose", args: ["--verbose", "up", "-d"] },
        ],
      );
      assertEquals(lines, [
        "Starting api/api",
        "Starting api/prebuilt",
        "Starting api/db",
        "Started api/prebuilt",
        "Started api/db",
        "    \x1b[33mChecking health\x1b[0m...",
        "    \x1b[31mUnhealthy\x1b[0m",
      ]);
    });
  },
});

Deno.test({
  name:
    "compose start fails when all remaining services are permanently blocked",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;

      await assertRejects(
        () =>
          runProjectCompose(project, ["up", "-d"], {
            runLineStream: (_command, onLine) => {
              emitEvent = onLine;
              return Promise.resolve({ stop: () => Promise.resolve() });
            },
            runProcess: (command) => {
              if (isComposeResolvedConfigCommand(command)) {
                return Promise.resolve({
                  code: 0,
                  stdout:
                    "services:\n  api:\n    depends_on:\n      db:\n        condition: service_healthy\n  worker:\n    depends_on:\n      db:\n        condition: service_healthy\n  db: {}\nx-pm3:\n  startup:\n    stop_when_unstartable: all\n",
                });
              }
              if (isComposeConfigCommand(command)) {
                return Promise.resolve({
                  code: 0,
                  stdout: "api\nworker\ndb\n",
                });
              }
              if (isComposeDownCommand(command)) {
                emitEvent?.(composeEvent("remove", "db"));
                return Promise.resolve({ code: 0 });
              }

              emitEvent?.(composeEvent("start", "db"));
              emitEvent?.(healthEvent("unhealthy", "db"));
              return Promise.resolve({ code: 0 });
            },
          }),
        Error,
        "Startup permanently blocked: api, worker",
      );
    });
  },
});

Deno.test({
  name:
    "compose start fails when a service_started dependency exits before the consumer starts",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;

      await assertRejects(
        () =>
          runProjectCompose(project, ["up", "-d"], {
            runLineStream: (_command, onLine) => {
              emitEvent = onLine;
              return Promise.resolve({ stop: () => Promise.resolve() });
            },
            runProcess: (command) => {
              if (isComposeResolvedConfigCommand(command)) {
                return Promise.resolve({
                  code: 0,
                  stdout:
                    "services:\n  api:\n    depends_on:\n      db:\n        condition: service_started\n  db: {}\nx-pm3:\n  startup:\n    required_services:\n      - api\n",
                });
              }
              if (isComposeConfigCommand(command)) {
                return Promise.resolve({ code: 0, stdout: "api\ndb\n" });
              }
              if (isComposeDownCommand(command)) {
                emitEvent?.(composeEvent("remove", "db"));
                return Promise.resolve({ code: 0 });
              }

              emitEvent?.(composeEvent("start", "db"));
              emitEvent?.(composeEvent("stop", "db"));
              return Promise.resolve({ code: 0 });
            },
          }),
        Error,
        "Required services permanently unstartable: api",
      );
    });
  },
});

Deno.test({
  name: "detached compose start keeps unhealthy cleanup flow silent",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      let emitEvent: ((line: string) => void) | undefined;
      let aborted = false;
      const commands: ProcessCommand[] = [];
      const lines = await captureConsoleLog(async () => {
        await assertRejects(
          () =>
            runProjectCompose(
              project,
              ["up", "-d"],
              {
                runLineStream: (_command, onLine) => {
                  emitEvent = onLine;
                  return Promise.resolve({ stop: () => Promise.resolve() });
                },
                runProcess: (command) => {
                  commands.push(command);
                  if (isComposeResolvedConfigCommand(command)) {
                    return Promise.resolve({
                      code: 0,
                      stdout: "services:\n  web: {}\n",
                    });
                  }
                  if (isComposeConfigCommand(command)) {
                    return Promise.resolve({ code: 0, stdout: "web\n" });
                  }
                  if (
                    command.args[0] === "--verbose" &&
                    command.args[1] === "down" &&
                    command.args[2] === "--remove-orphans"
                  ) {
                    emitEvent?.(composeEvent("remove", "web"));
                    return Promise.resolve({ code: 0 });
                  }

                  command.signal?.addEventListener("abort", () => {
                    aborted = true;
                  });
                  emitEvent?.(composeEvent("start", "web"));
                  emitEvent?.(healthEvent("starting", "web"));
                  emitEvent?.(healthEvent("unhealthy", "web"));
                  return Promise.resolve({ code: 0 });
                },
              },
              { detached: true },
            ),
          Error,
          "Unhealthy services: api/web",
        );
      });

      assertEquals(aborted, true);
      assertEquals(
        commands.map(({ args, command, detached }) => ({
          args,
          command,
          detached,
        })),
        [
          {
            command: "podman-compose",
            args: ["config"],
            detached: undefined,
          },
          {
            command: "podman-compose",
            args: ["config", "--services"],
            detached: undefined,
          },
          {
            command: "podman-compose",
            args: ["--verbose", "up", "-d"],
            detached: true,
          },
          {
            command: "podman-compose",
            args: ["config", "--services"],
            detached: undefined,
          },
          {
            command: "podman-compose",
            args: ["--verbose", "down", "--remove-orphans"],
            detached: true,
          },
        ],
      );
      assertEquals(lines, []);
    });
  },
});

Deno.test({
  name: "compose start returns without cleanup after detach signal",
  sanitizeResources: false,
  async fn() {
    await withTempComposeProject(async ({ project }) => {
      const detachController = new AbortController();
      let emitEvent: ((line: string) => void) | undefined;
      const commands: ProcessCommand[] = [];

      await runProjectCompose(project, ["up", "-d"], {
        detachSignal: detachController.signal,
        runLineStream: (_command, onLine) => {
          emitEvent = onLine;
          return Promise.resolve({ stop: () => Promise.resolve() });
        },
        runProcess: (command) => {
          commands.push(command);
          if (isComposeResolvedConfigCommand(command)) {
            return Promise.resolve({
              code: 0,
              stdout: "services:\n  web: {}\n",
            });
          }
          if (isComposeConfigCommand(command)) {
            return Promise.resolve({ code: 0, stdout: "web\n" });
          }

          emitEvent?.(composeEvent("start", "web"));
          detachController.abort();
          return Promise.resolve({ code: 0, detached: true });
        },
      });

      assertEquals(commands.length, 3);
      assertEquals(commands[2]?.detachSignal, detachController.signal);
    });
  },
});

type TempComposeProject = {
  project: { id: number; name: string; workingDir: string };
};

async function withTempComposeProject(
  callback: (context: TempComposeProject) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "pm3-compose-test-" });
  const workingDir = join(root, "api");

  try {
    await Deno.mkdir(workingDir);
    await Deno.writeTextFile(
      join(workingDir, "compose.yaml"),
      "services: {}\n",
    );
    await callback({
      project: { id: 1, name: "api", workingDir },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
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

async function captureTerminalOutput(
  columns: number,
  callback: () => Promise<void>,
): Promise<string> {
  const chunks: string[] = [];
  const originalStdout = Deno.stdout;
  const originalConsoleSize = Deno.consoleSize;
  const decoder = new TextDecoder();

  Object.defineProperty(Deno, "stdout", {
    configurable: true,
    value: {
      isTerminal: () => true,
      writeSync: (data: Uint8Array) => {
        chunks.push(decoder.decode(data));
        return data.byteLength;
      },
    },
  });
  Object.defineProperty(Deno, "consoleSize", {
    configurable: true,
    value: () => ({ columns, rows: 24 }),
  });

  try {
    await callback();
    return chunks.join("");
  } finally {
    Object.defineProperty(Deno, "stdout", {
      configurable: true,
      value: originalStdout,
    });
    Object.defineProperty(Deno, "consoleSize", {
      configurable: true,
      value: originalConsoleSize,
    });
  }
}

function isComposeConfigCommand(command: ProcessCommand): boolean {
  return (
    command.command === "podman-compose" &&
    command.args.join(" ") === "config --services"
  );
}

function isComposeResolvedConfigCommand(command: ProcessCommand): boolean {
  return command.command === "podman-compose" &&
    command.args.join(" ") === "config";
}

function isComposeDownCommand(command: ProcessCommand): boolean {
  return command.command === "podman-compose" &&
    command.args.join(" ") === "--verbose down --remove-orphans";
}

function composeEvent(status: string, service: string): string {
  return JSON.stringify({
    Status: status,
    Attributes: { "com.docker.compose.service": service },
  });
}

function healthEvent(status: string, service: string): string {
  return JSON.stringify({
    health_status: status,
    Attributes: { "com.docker.compose.service": service },
  });
}

function getPodmanCommand(status: string): string {
  if (status === "remove") {
    return "rm";
  }

  return status;
}
