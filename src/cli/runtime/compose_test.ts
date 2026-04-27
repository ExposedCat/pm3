import { assertEquals } from "@std/assert";
import { assert } from "@std/assert/assert";
import { join } from "@std/path";
import { runProjectCompose } from "./compose.ts";
import type { ProcessCommand } from "./process.ts";

Deno.test({
  name: "non-verbose compose output prints notices below the affected progress step",
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
            if (isComposeConfigCommand(command)) {
              return Promise.resolve({ code: 0, stdout: "web\n" });
            }

            command.onOutput?.({
              stream: "stderr",
              text: "podman start pm3_web_1\nWARN: pm3_web_1 image uses latest tag\n",
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
  name: "compose output attributes overlapping service names to the longest match",
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
        "Starting api/web_api",
        "    \x1b[33mWARN: pm3_web_api_1 warning\x1b[0m",
        "Started api/web_api",
      ]);
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
            if (isComposeConfigCommand(command)) {
              return Promise.resolve({ code: 0, stdout: "web\n" });
            }

            command.onOutput?.({
              stream: "stderr",
              text: "podman start pm3_web_1\nWARN: pm3_web_1 image uses a very long latest tag\n",
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
      for (const [args, status, expected] of [
        [["stop"], "stop", ["Stopping api/web", "Stopped api/web"]],
        [["restart"], "start", ["Restarting api/web", "Restarted api/web"]],
        [["down"], "remove", ["Removing api/web", "Removed api/web"]],
      ] as const) {
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

function composeEvent(status: string, service: string): string {
  return JSON.stringify({
    Status: status,
    Attributes: { "com.docker.compose.service": service },
  });
}

function getPodmanCommand(status: string): string {
  if (status === "remove") {
    return "rm";
  }

  return status;
}
