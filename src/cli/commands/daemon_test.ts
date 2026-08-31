import { assertEquals, assertThrows } from "@std/assert";
import { parseArgs, runCommand } from "../commands.ts";
import type { ProcessCommand, ProcessResult } from "../runtime/process.ts";

Deno.test("daemon keeps foreground run as the default action", () => {
  const parsed = parseArgs(["daemon"]);
  assertEquals(parsed.command.kind, "daemon");
  if (parsed.command.kind !== "daemon") {
    throw new Error("Expected daemon command");
  }
  assertEquals(parsed.command.action, "run");
});

Deno.test("daemon start and stop control the user service", async () => {
  const commands: ProcessCommand[] = [];
  const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
    commands.push(command);
    return Promise.resolve({ code: 0 });
  };

  await runCommand(parseArgs(["daemon", "start"]), { runProcess });
  await runCommand(parseArgs(["daemon", "stop"]), { runProcess });

  assertEquals(
    commands.map(({ args, command }) => ({ args, command })),
    [
      {
        args: ["--user", "start", "pm3.service"],
        command: "systemctl",
      },
      {
        args: ["--user", "stop", "pm3.service"],
        command: "systemctl",
      },
    ],
  );
});

Deno.test("daemon logs reads the bounded user journal", async () => {
  const commands: ProcessCommand[] = [];
  const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
    commands.push(command);
    return Promise.resolve({ code: 0, stdout: "daemon output" });
  };
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    await runCommand(
      parseArgs(["daemon", "logs", "--since", "1h", "--lines", "120"]),
      { runProcess },
    );
  } finally {
    console.log = originalLog;
  }

  assertEquals(
    commands.map(({ args, command }) => ({ args, command })),
    [
      {
        args: [
          "--user",
          "--unit",
          "pm3.service",
          "--no-pager",
          "--since",
          "-1h",
          "--lines",
          "120",
        ],
        command: "journalctl",
      },
    ],
  );
  assertEquals(output, ["daemon output"]);
});

Deno.test("daemon logs can follow the user journal", async () => {
  const commands: ProcessCommand[] = [];
  const runProcess = (command: ProcessCommand): Promise<ProcessResult> => {
    commands.push(command);
    command.onOutput?.({ stream: "stdout", text: "streamed output" });
    return Promise.resolve({ code: 0 });
  };
  const writes: string[] = [];
  const originalWrite = Deno.stdout.writeSync;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    writes.push(new TextDecoder().decode(data));
    return data.length;
  };

  try {
    await runCommand(
      parseArgs(["daemon", "logs", "--since", "30min", "--follow"]),
      { runProcess },
    );
  } finally {
    Deno.stdout.writeSync = originalWrite;
  }

  assertEquals(
    commands.map(({ args, captureOutput, command }) => ({
      args,
      captureOutput,
      command,
    })),
    [
      {
        args: [
          "--user",
          "--unit",
          "pm3.service",
          "--no-pager",
          "--since",
          "-30min",
          "--follow",
        ],
        captureOutput: false,
        command: "journalctl",
      },
    ],
  );
  assertEquals(writes, ["streamed output"]);
});

Deno.test("daemon rejects unsupported actions and misplaced log options", () => {
  assertThrows(
    () => parseArgs(["daemon", "restart"]),
    Error,
    "Unsupported daemon action: restart",
  );
  assertThrows(
    () => parseArgs(["daemon", "start", "--since", "1h"]),
    Error,
    "Daemon log options require the logs action",
  );
});
