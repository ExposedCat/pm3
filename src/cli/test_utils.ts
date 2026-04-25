import { join } from "@std/path";
import type { ProcessCommand, ProcessResult } from "./command.ts";
import { parseArgs, runCommand } from "./commands.ts";
import { formatCliError } from "./errors.ts";
import { runCliMain } from "./main.ts";

export async function runCli(
  args: string[],
  databasePath?: string,
  runProcess?: (command: ProcessCommand) => Promise<ProcessResult>,
): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;

  console.log = (...data: unknown[]) => {
    lines.push(data.map(String).join(" "));
  };

  try {
    await runCommand(parseArgs(args), { databasePath, runProcess });
    return lines.join("\n");
  } finally {
    console.log = originalLog;
  }
}

export type CliProcessOutput = {
  code: number;
  stdout: string;
  stderr: string;
};

export async function runCliProcess(
  args: string[],
  databasePath?: string,
  runProcess?: (command: ProcessCommand) => Promise<ProcessResult>,
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
    return await withEnv({ PM3_DATABASE_PATH: databasePath }, async () => ({
      code: await runCliMainWithOptions(args, databasePath, runProcess),
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function runCliMainWithOptions(
  args: string[],
  databasePath?: string,
  runProcess?: (command: ProcessCommand) => Promise<ProcessResult>,
): Promise<number> {
  if (!runProcess) {
    return await runCliMain(args);
  }

  try {
    await runCommand(parseArgs(args), { databasePath, runProcess });
    return 0;
  } catch (error) {
    const { message, showUsage } = formatCliError(error);
    console.error(`pm3: ${message}`);
    if (showUsage) {
      console.error("Run `pm3 help` for usage.");
    }
    return 1;
  }
}

export async function withEnv<T>(
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

export async function withTempCli(
  callback: (context: { databasePath: string; root: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "pm3-cli-test-" });

  try {
    await callback({ databasePath: join(root, "pm3.sqlite"), root });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
