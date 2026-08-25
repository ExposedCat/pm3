import type {
  CliCommand,
  CommandDefinition,
  RunCommandOptions,
} from "../commands.ts";
import { withTargetProjectList } from "../commands.ts";
import { green, orange, red, underline, yellow } from "../output/color.ts";
import { startLoader } from "../output/loader.ts";
import { requireNoExtraArgs } from "../utils.ts";
import {
  formatListCell,
  formatProjectState,
  type ProjectListContainer,
} from "./list.ts";

export type ViewCommand = CliCommand<"view"> & {
  name: string | undefined;
};

export const viewCommand = {
  names: ["view"],
  args: ["[PROJECT]"],
  options: [],
  description: "View project details per service",
  parse: parseViewArgs,
} satisfies CommandDefinition<ViewCommand>;

function parseViewArgs(args: string[]): ViewCommand {
  const [nameArg, ...extra] = args;
  requireNoExtraArgs("view", extra);

  return {
    kind: "view",
    name: nameArg,
    run: (options) => runViewCommand(nameArg, options),
  };
}

async function runViewCommand(
  name: string | undefined,
  options: RunCommandOptions,
): Promise<void> {
  const loader = startLoader(
    name ? `Loading ${name}` : "Loading project details",
    {
      enabled: !options.verbose && (name !== undefined || options.yes === true),
    },
  );
  let renderedProjects: string[] | undefined;

  try {
    const [
      { listProjectContainers },
      { listComposeServices },
      { runSystemProcess },
    ] = await Promise.all([
      import("../../runtime/project.ts"),
      import("../runtime/compose_files.ts"),
      import("../runtime/process.ts"),
    ]);
    const runProcess = options.runProcess ?? runSystemProcess;

    renderedProjects = await withTargetProjectList(
      options,
      "view",
      name,
      async (_db, projects) =>
        await Promise.all(
          projects.map(async (project) => {
            const [containersResult, discoveryResult] = await Promise
              .allSettled([
                listProjectContainers(project, options),
                listComposeServices(project, runProcess),
              ]);
            const errors: string[] = [];
            const containers = containersResult.status === "fulfilled"
              ? containersResult.value
              : [];
            if (containersResult.status === "rejected") {
              errors.push(
                `Failed to inspect containers: ${
                  formatErrorMessage(containersResult.reason)
                }`,
              );
            }

            if (discoveryResult.status === "rejected") {
              errors.push(
                `Failed to list compose services: ${
                  formatErrorMessage(discoveryResult.reason)
                }`,
              );
            } else if (discoveryResult.value.kind === "error") {
              errors.push(
                `Failed to list compose services: ${discoveryResult.value.message}`,
              );
            }

            const serviceNames = new Set<string>([
              ...(discoveryResult.status === "fulfilled" &&
                  discoveryResult.value.kind === "services"
                ? discoveryResult.value.services
                : []),
              ...containers
                .map((container) => container.service)
                .filter(Boolean),
            ]);
            const rows = [...serviceNames]
              .sort((left, right) => left.localeCompare(right))
              .map((service) =>
                buildServiceRow(
                  service,
                  containers,
                  containersResult.status === "fulfilled",
                )
              );
            const knownProjectState = formatProjectState(containers, {
              detailed: true,
            });
            const projectState = errors.length > 0
              ? { ...knownProjectState, state: "invalid" }
              : knownProjectState;

            return [
              formatProjectDetails(
                project.name,
                project.workingDir,
                project.composeArgs,
                project.enabled,
                projectState,
                errors,
              ),
              ...rows.map(formatServiceDetails),
            ].join("\n\n");
          }),
        ),
    );
  } finally {
    loader.stop();
  }

  if (!renderedProjects) {
    return;
  }

  console.log(renderedProjects.join("\n\n"));
}

type ServiceRow = {
  ports: string;
  service: string;
  state: string;
};

function buildServiceRow(
  service: string,
  containers: readonly ProjectListContainer[],
  stateKnown: boolean,
): ServiceRow {
  if (!stateKnown) {
    return { ports: "", service, state: "unknown" };
  }

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
  composeArgs: readonly string[],
  enabled: 0 | 1,
  projectState: ReturnType<typeof formatProjectState>,
  errors: readonly string[],
): string {
  const startup = enabled === 1 ? "enabled" : "disabled";
  return [
    `${formatStateDot(projectState.state)} ${name} - ${
      formatProjectStateSummary(
        projectState,
      )
    }`,
    ...formatDetailLines(
      [
        ["Startup", formatStartupValue(startup)],
        ["Workdir", underline(workingDir)],
        [
          "Creation args",
          composeArgs.length > 0 ? underline(composeArgs.join(" ")) : "-",
        ],
      ],
      4,
    ),
    ...(errors.length > 0
      ? ["    Errors:", ...errors.flatMap(formatInvalidStateError)]
      : []),
  ].join("\n");
}

function formatInvalidStateError(error: string): string[] {
  const [firstLine, ...remainingLines] = error.split(/\r?\n/);
  return [
    `        - ${red(firstLine)}`,
    ...remainingLines.map((line) => `          ${red(line)}`),
  ];
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatServiceDetails(row: ServiceRow): string {
  return [
    `${" ".repeat(4)}${formatStateDot(row.state)} ${row.service} - ${
      formatProjectStateSummary(
        row,
      )
    }`,
    ...formatDetailLines([["Published ports", row.ports || "-"]], 8),
  ].join("\n");
}

function formatDetailLines(
  rows: readonly (readonly [string, string])[],
  indent: number,
): string[] {
  const prefix = " ".repeat(indent);

  return rows.map(([key, value]) => {
    return `${prefix}${key}: ${value}`;
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
  const kind = state.match(/^(down|invalid|starting|stopping|up)(?:\s|$)/)?.[1];

  if (kind === "down") {
    return orange("●");
  }

  if (kind === "invalid") {
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
