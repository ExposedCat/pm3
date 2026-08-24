import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { green, orange, red, yellow } from "../output/color.ts";
import { formatTable } from "../output/table.ts";
import { requireNoExtraArgs } from "../utils.ts";

export type ListCommand = CliCommand<"list"> & {
  detailed: boolean;
};

export type ProjectListContainer = {
  createdAt: number;
  exitedAt: number;
  ports: string;
  service: string;
  startedAt: number;
  state: string;
  status: string;
};

export const listCommand = {
  names: ["list"],
  args: [],
  options: ["[-d|--detailed]"],
  description: "List projects.",
  parse: parseListArgs,
} satisfies CommandDefinition<ListCommand>;

function parseListArgs(args: string[]): ListCommand {
  const rest: string[] = [];
  let detailed = false;

  for (const arg of args) {
    if (arg === "-d" || arg === "--detailed") {
      detailed = true;
    } else {
      rest.push(arg);
    }
  }

  requireNoExtraArgs("list", rest);

  return {
    kind: "list",
    detailed,
    run: (options) => runListCommand(options, { detailed }),
  };
}

type ListOptions = {
  detailed: boolean;
};

type ProjectListRow = {
  name: string;
  state: string;
  startup: string;
  created: string;
  ports: string;
};

type ProjectListProject = {
  enabled: 0 | 1;
  name: string;
  workingDir: string;
};

async function runListCommand(
  options: RunCommandOptions,
  listOptions: ListOptions,
): Promise<void> {
  const { listProjects } = await import("../../database/projects.ts");
  const { withCliDatabase } = await import("../runtime/database.ts");
  const { listProjectContainers } = await import("../../runtime/project.ts");

  await withCliDatabase(options, async (db) => {
    const projects = await listProjects(db);
    const rows = await Promise.all(
      projects.map((project) =>
        buildProjectListRow(
          project,
          listOptions,
          options,
          listProjectContainers,
        ),
      ),
    );

    printRows(rows, listOptions);
  });
}

async function buildProjectListRow(
  project: ProjectListProject,
  listOptions: ListOptions,
  options: RunCommandOptions,
  listProjectContainers: (
    project: ProjectListProject,
    options: RunCommandOptions,
  ) => Promise<ProjectListContainer[]>,
): Promise<ProjectListRow> {
  const containers = await listProjectContainers(project, options);

  return {
    name: project.name,
    startup: project.enabled === 1 ? "enabled" : "disabled",
    ...formatProjectState(containers, listOptions),
  };
}

export function formatProjectState(
  containers: readonly ProjectListContainer[],
  options: ListOptions,
): Omit<ProjectListRow, "name" | "startup"> {
  const state = getProjectState(containers);
  const duration = options.detailed
    ? getProjectStateDuration(containers, state)
    : "";

  return {
    state: duration ? `${state} (${duration})` : state,
    created: getProjectCreatedTime(containers),
    ports: uniqueJoined(containers.map((container) => container.ports)),
  };
}

function getProjectState(
  containers: readonly Pick<ProjectListContainer, "state">[],
): "down" | "starting" | "stopping" | "up" {
  if (containers.length === 0) {
    return "down";
  }

  const states = containers.map((container) => container.state.toLowerCase());
  if (states.every((state) => state === "running")) {
    return "up";
  }

  if (
    states.every(
      (state) =>
        state === "created" || state === "exited" || state === "stopped",
    )
  ) {
    return "down";
  }

  if (states.some((state) => state === "created")) {
    return "starting";
  }

  return "stopping";
}

function getProjectStateDuration(
  containers: readonly Pick<
    ProjectListContainer,
    "exitedAt" | "startedAt" | "status"
  >[],
  state: "down" | "starting" | "stopping" | "up",
): string {
  if (state === "starting" || state === "stopping") {
    return "";
  }

  const timestamps = containers
    .map((container) =>
      state === "up" ? container.startedAt : container.exitedAt,
    )
    .filter(isValidUnixTimestamp);

  if (timestamps.length > 0) {
    return formatRelativeTimestamp(Math.min(...timestamps));
  }

  return compactDuration(
    parseStatusDuration(containers[0]?.status ?? "", state),
  );
}

function parseStatusDuration(status: string, state: string): string {
  if (state === "up") {
    return status.match(/^Up\s+(.+?)(?:\s+\(|$)/)?.[1] ?? "";
  }

  if (state === "down") {
    return status.match(/^Exited\s+\([^)]+\)\s+(.+?)(?:\s+\(|$)/)?.[1] ?? "";
  }

  return "";
}

function getProjectCreatedTime(
  containers: readonly Pick<ProjectListContainer, "createdAt" | "status">[],
): string {
  const timestamps = containers
    .map((container) => container.createdAt)
    .filter(isValidUnixTimestamp);

  if (timestamps.length > 0) {
    return formatRelativeTimestamp(Math.min(...timestamps));
  }

  return compactDuration(parseCreatedDuration(containers[0]?.status ?? ""));
}

function parseCreatedDuration(status: string): string {
  return status.match(/\b(\d+\s+\w+\s+ago)\b/)?.[1] ?? "";
}

function formatRelativeTimestamp(timestampSeconds: number): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor(Date.now() / 1000) - timestampSeconds,
  );

  return formatDuration(elapsedSeconds);
}

function formatDuration(totalSeconds: number): string {
  const units = [
    { suffix: "d", seconds: 60 * 60 * 24 },
    { suffix: "h", seconds: 60 * 60 },
    { suffix: "m", seconds: 60 },
  ] as const;
  const parts: string[] = [];
  let remaining = totalSeconds;

  for (const unit of units) {
    const value = Math.floor(remaining / unit.seconds);
    if (value > 0) {
      parts.push(`${value}${unit.suffix}`);
      remaining -= value * unit.seconds;
    }

    if (parts.length === 2) {
      break;
    }
  }

  return parts.join(" ") || "<1m";
}

function isValidUnixTimestamp(timestampSeconds: number): boolean {
  return Number.isFinite(timestampSeconds) && timestampSeconds > 0;
}

function compactDuration(duration: string): string {
  const match = duration.match(
    /(?:(\d+)\s+days?)?\s*(?:(\d+)\s+hours?)?\s*(?:(\d+)\s+minutes?)?/,
  );
  if (!match) {
    return duration.replace(/\s+ago$/, "");
  }

  const [, days, hours, minutes] = match;
  const totalSeconds =
    Number(days ?? 0) * 24 * 60 * 60 +
    Number(hours ?? 0) * 60 * 60 +
    Number(minutes ?? 0) * 60;

  return totalSeconds > 0 ? formatDuration(totalSeconds) : duration;
}

function uniqueJoined(values: readonly string[]): string {
  return [...new Set(values.filter(Boolean))].join("; ");
}

function printRows(
  rows: readonly ProjectListRow[],
  options: ListOptions,
): void {
  if (options.detailed) {
    console.log(
      formatTable(
        [
          ["NAME", "STATE", "STARTUP", "CREATED", "PORTS"],
          ...rows.map((row) => [
            row.name,
            row.state,
            row.startup,
            row.created,
            row.ports,
          ]),
        ],
        { formatCell: formatListCell },
      ),
    );
    return;
  }

  console.log(
    formatTable(
      [["NAME", "STATE"], ...rows.map((row) => [row.name, row.state])],
      { formatCell: formatListCell },
    ),
  );
}

export function formatListCell(cell: {
  header: string | undefined;
  value: string;
}): string {
  if (cell.header === "STARTUP") {
    return formatStartupCell(cell.value);
  }

  if (cell.header !== "STATE") {
    return cell.value;
  }

  const match = cell.value.match(/^(.+?)(\s*)$/);
  const content = match?.[1] ?? cell.value;
  const padding = match?.[2] ?? "";
  const state = content.match(
    /^(down|invalid|starting|stopping|up)(?:\s|$)/,
  )?.[1];

  if (state === "down") {
    return `${orange(content)}${padding}`;
  }

  if (state === "invalid") {
    return `${red(content)}${padding}`;
  }

  if (state === "starting" || state === "stopping") {
    return `${yellow(content)}${padding}`;
  }

  if (state === "up") {
    return `${green(content)}${padding}`;
  }

  return cell.value;
}

function formatStartupCell(value: string): string {
  const match = value.match(/^(.+?)(\s*)$/);
  const content = match?.[1] ?? value;
  const padding = match?.[2] ?? "";

  if (content === "enabled") {
    return `${green(content)}${padding}`;
  }

  if (content === "disabled") {
    return `${red(content)}${padding}`;
  }

  return value;
}
