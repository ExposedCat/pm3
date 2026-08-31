import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { usageError } from "../errors.ts";
import { requireOptionValue } from "../utils.ts";

type DaemonAction = "logs" | "run" | "start" | "stop";

export type DaemonCommand = CliCommand<"daemon"> & {
  action: DaemonAction;
  follow: boolean;
  lines: number | undefined;
  since: string | undefined;
};

export const daemonCommand = {
  names: ["daemon"],
  args: ["[run|start|stop|logs]"],
  options: [
    "[-s|--since VALUE]",
    "[-l|--lines COUNT]",
    "[-f|--follow]",
  ],
  description: "Run or manage the autostart daemon",
  parse: parseDaemonArgs,
} satisfies CommandDefinition<DaemonCommand>;

function parseDaemonArgs(args: string[]): DaemonCommand {
  let action: DaemonAction = "run";
  let actionSet = false;
  let follow = false;
  let lines: number | undefined;
  let since: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-s" || arg === "--since") {
      since = requireOptionValue(arg, args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "-l" || arg === "--lines") {
      lines = parseLinesValue(arg, requireOptionValue(arg, args[index + 1]));
      index += 1;
      continue;
    }

    if (arg === "-f" || arg === "--follow") {
      follow = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw usageError(`Unknown option for daemon: ${arg}`);
    }

    if (actionSet) {
      throw usageError(`Unexpected argument for daemon: ${arg}`);
    }
    if (!isDaemonAction(arg)) {
      throw usageError(`Unsupported daemon action: ${arg}`);
    }
    action = arg;
    actionSet = true;
  }

  if (
    action !== "logs" && (follow || lines !== undefined || since !== undefined)
  ) {
    throw usageError("Daemon log options require the logs action");
  }

  return {
    action,
    follow,
    kind: "daemon",
    lines,
    since,
    run: (options) =>
      runDaemonCommand({ action, follow, lines, since }, options),
  };
}

function isDaemonAction(value: string): value is DaemonAction {
  return value === "logs" || value === "run" || value === "start" ||
    value === "stop";
}

function parseLinesValue(option: string, value: string): number {
  const lines = Number(value);
  if (!Number.isInteger(lines) || lines < 0) {
    throw usageError(`Invalid value for ${option}: ${value}`);
  }

  return lines;
}

type DaemonRunCommand = Pick<
  DaemonCommand,
  "action" | "follow" | "lines" | "since"
>;

async function runDaemonCommand(
  command: DaemonRunCommand,
  options: RunCommandOptions,
): Promise<void> {
  if (command.action === "run") {
    const { withCliDatabase } = await import("../runtime/database.ts");
    const { runDaemon } = await import("../../runtime/daemon.ts");

    await withCliDatabase(options, async (db) => {
      await runDaemon(db, options);
    });
    return;
  }

  const { runSystemProcess } = await import("../runtime/process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const streamOutput = command.action === "logs" && command.follow;
  const result = await runProcess({
    args: daemonServiceArgs(command),
    captureOutput: !streamOutput,
    command: command.action === "logs" ? "journalctl" : "systemctl",
    cwd: Deno.cwd(),
    onOutput: streamOutput ? writeProcessOutput : undefined,
    signal: options.signal,
    verbose: options.verbose,
  });
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || `exit code ${result.code}`;
    throw new Error(`Failed to ${command.action} PM3 daemon: ${detail}`);
  }
  if (!streamOutput) {
    printProcessOutput(result.stdout, result.stderr);
  }
}

function daemonServiceArgs(command: DaemonRunCommand): string[] {
  if (command.action === "start" || command.action === "stop") {
    return ["--user", command.action, "pm3.service"];
  }

  const args = ["--user", "--unit", "pm3.service", "--no-pager"];
  if (command.since) {
    args.push("--since", normalizeJournalSince(command.since));
  }
  if (command.lines !== undefined) {
    args.push("--lines", String(command.lines));
  }
  if (command.follow) {
    args.push("--follow");
  }
  return args;
}

function normalizeJournalSince(value: string): string {
  return /^\d+(?:ms|s|min|m|h|d|w)$/.test(value) ? `-${value}` : value;
}

function printProcessOutput(
  stdout: string | undefined,
  stderr: string | undefined,
): void {
  if (stdout) {
    console.log(stdout);
  }
  if (stderr) {
    console.error(stderr);
  }
}

function writeProcessOutput(
  chunk: { stream: "stderr" | "stdout"; text: string },
): void {
  const output = new TextEncoder().encode(chunk.text);
  if (chunk.stream === "stderr") {
    Deno.stderr.writeSync(output);
    return;
  }
  Deno.stdout.writeSync(output);
}
