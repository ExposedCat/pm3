import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { withNamedProject } from "../commands.ts";
import { usageError } from "../errors.ts";
import { requireArgument, requireOptionValue } from "../utils.ts";

export type LogsCommand = CliCommand<"logs"> & {
  name: string;
  services: string[];
  since: string | undefined;
  lines: number | undefined;
  raw: boolean;
  once: boolean;
};

export const logsCommand = {
  names: ["logs"],
  args: ["NAME", "[SERVICES...]"],
  options: [
    "[-s|--since VALUE]",
    "[-l|--lines COUNT]",
    "[-r|--raw]",
    "[-o|--once]",
  ],
  description: "Show project logs",
  parse: parseLogsArgs,
} satisfies CommandDefinition<LogsCommand>;

function parseLogsArgs(args: string[]): LogsCommand {
  let name: string | undefined;
  const services: string[] = [];
  let since: string | undefined;
  let lines: number | undefined;
  let raw = false;
  let once = false;

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

    if (arg === "-r" || arg === "--raw") {
      raw = true;
      continue;
    }

    if (arg === "-o" || arg === "--once") {
      once = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw usageError(`Unknown option for logs: ${arg}`);
    }

    if (!name) {
      name = arg;
      continue;
    }

    services.push(arg);
  }

  const parsedName = requireArgument("project name", name);

  return {
    kind: "logs",
    name: parsedName,
    services,
    since,
    lines,
    raw,
    once,
    run: (options) =>
      runLogsCommand(
        {
          name: parsedName,
          services,
          since,
          lines,
          raw,
          once,
        },
        options,
      ),
  };
}

function parseLinesValue(option: string, value: string): number {
  const lines = Number(value);
  if (!Number.isInteger(lines) || lines < 0) {
    throw usageError(`Invalid value for ${option}: ${value}`);
  }

  return lines;
}

type LogsRunCommand = Pick<
  LogsCommand,
  "lines" | "name" | "once" | "raw" | "services" | "since"
>;

async function runLogsCommand(
  command: LogsRunCommand,
  options: RunCommandOptions,
): Promise<void> {
  const { streamProjectLogs } = await import("../../runtime/project.ts");

  await withNamedProject(options, command.name, async (_db, project) => {
    await streamProjectLogs(project, command, options);
  });
}
