import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { withTargetProjects } from "../commands.ts";
import { inputError } from "../errors.ts";
import { green, red, underline, yellow } from "../output/color.ts";
import { requireNoExtraArgs } from "../utils.ts";
import {
  formatListCell,
  formatProjectState,
  type ProjectListContainer,
} from "./list.ts";

export type ShowCommand = CliCommand<"show"> & {
  name: string | undefined;
};

export const showCommand = {
  names: ["show"],
  args: ["[PROJECT]"],
  options: [],
  description: "Show project details per service",
  parse: parseShowArgs,
} satisfies CommandDefinition<ShowCommand>;

function parseShowArgs(args: string[]): ShowCommand {
  const [nameArg, ...extra] = args;
  requireNoExtraArgs("show", extra);

  return {
    kind: "show",
    name: nameArg,
    run: (options) => runShowProjectCommand(nameArg, options),
  };
}

type ServiceRow = {
  ports: string;
  service: string;
  state: string;
};

async function runShowProjectCommand(
  name: string | undefined,
  options: RunCommandOptions,
): Promise<void> {
  let firstProject = true;
  await withTargetProjects(options, name, async (_db, project) => {
    const { listProjectContainers } = await import("../../runtime/project.ts");
    const { listComposeServices } = await import("../runtime/compose_files.ts");
    const { runSystemProcess } = await import("../runtime/process.ts");

    const containers = await listProjectContainers(project, options);
    const runProcess = options.runProcess ?? runSystemProcess;
    const discovery = await listComposeServices(project, runProcess);
    if (discovery.kind === "error") {
      throw inputError(
        `Failed to list compose services for ${project.name}: ${discovery.message}`,
      );
    }

    const serviceNames = new Set<string>(
      discovery.kind === "services"
        ? discovery.services
        : containers.map((container) => container.service).filter(Boolean),
    );
    const rows = [...serviceNames]
      .sort((left, right) => left.localeCompare(right))
      .map((service) => buildServiceRow(service, containers));
    const projectState = formatProjectState(containers, { detailed: true });

    if (!firstProject) {
      console.log("");
    }
    firstProject = false;

    console.log(
      formatProjectDetails(
        project.name,
        project.workingDir,
        project.enabled,
        projectState,
      ),
    );

    for (const row of rows) {
      console.log("");
      console.log(formatServiceDetails(row));
    }
  });
}

function buildServiceRow(
  service: string,
  containers: readonly ProjectListContainer[],
): ServiceRow {
  const serviceContainers = containers.filter((container) => {
    return container.service === service;
  });
  const state = formatProjectState(serviceContainers, { detailed: true });

  return {
    ports: state.ports,
    service,
    state: state.state,
  };
}

function formatProjectDetails(
  name: string,
  workingDir: string,
  enabled: 0 | 1,
  projectState: ReturnType<typeof formatProjectState>,
): string {
  const startup = enabled === 1 ? "enabled" : "disabled";
  return [
    `${formatStateDot(projectState.state)} ${name} - ${formatProjectStateSummary(
      projectState,
    )}`,
    ...formatDetailLines(
      [
        ["Startup", formatStartupValue(startup)],
        ["Workdir", underline(workingDir)],
      ],
      4,
    ),
  ].join("\n");
}

function formatServiceDetails(row: ServiceRow): string {
  return [
    `${" ".repeat(4)}${formatStateDot(row.state)} ${row.service} - ${formatProjectStateSummary(
      row,
    )}`,
    ...formatDetailLines([["Ports", row.ports || "-"]], 8),
  ].join("\n");
}

function formatDetailLines(
  rows: readonly (readonly [string, string])[],
  indent: number,
): string[] {
  const keyWidth = Math.max(...rows.map(([key]) => key.length));
  const prefix = " ".repeat(indent);

  return rows.map(([key, value]) => {
    return `${prefix}${key.padStart(keyWidth)}: ${value}`;
  });
}

function formatProjectStateSummary(
  projectState:
    | Pick<ServiceRow, "state">
    | ReturnType<typeof formatProjectState>,
): string {
  return `${formatStateValue(projectState.state)}${
    "created" in projectState && projectState.created
      ? ` (${projectState.created})`
      : ""
  }`;
}

function formatStateValue(state: string): string {
  return formatListCell({ header: "STATE", value: state });
}

function formatStartupValue(startup: string): string {
  return formatListCell({ header: "STARTUP", value: startup });
}

function formatStateDot(state: string): string {
  const kind = state.match(/^(down|starting|stopping|up)(?:\s|$)/)?.[1];

  if (kind === "down") {
    return red("●");
  }

  if (kind === "starting" || kind === "stopping") {
    return yellow("●");
  }

  if (kind === "up") {
    return green("●");
  }

  return "●";
}
