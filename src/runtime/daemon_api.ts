import { formatProjectState } from "../cli/commands/list.ts";
import type { RunCommandOptions } from "../cli/commands.ts";
import { inputError } from "../cli/errors.ts";
import { listComposeServices } from "../cli/runtime/compose_files.ts";
import type { PM3Database } from "../database/database.ts";
import {
  getProjectByName,
  listProjects,
  type Project,
  type ProjectListItem,
} from "../database/projects.ts";
import { listProjectContainers, type ProjectStartOptions } from "./project.ts";

const DAEMON_API_HOST = "127.0.0.1";
const DAEMON_API_PORT = 46373;

type LifecycleRequestOptions = Pick<ProjectStartOptions, "build" | "noCache">;
type ApiLifecycleAction = "restart" | "start" | "stop";

type ProjectListResponse = {
  created: string;
  enabled: boolean;
  name: string;
  ports: string;
  state: string;
  workingDir: string;
};

type ProjectServiceResponse = {
  ports: string;
  service: string;
  state: string;
};

type ProjectShowResponse = ProjectListResponse & {
  services: ProjectServiceResponse[];
};

export type DaemonApiLifecycle = (
  project: Project,
  action: ApiLifecycleAction,
  lifecycleOptions: LifecycleRequestOptions,
) => Promise<void>;

export function startDaemonApiServer(
  db: PM3Database,
  commandOptions: RunCommandOptions,
  runLifecycle: DaemonApiLifecycle,
): { stop(): Promise<void> } {
  const server = Deno.serve(
    {
      hostname: DAEMON_API_HOST,
      onListen: () => {
        console.log(
          `PM3 API listening on http://${DAEMON_API_HOST}:${DAEMON_API_PORT}`,
        );
      },
      port: DAEMON_API_PORT,
    },
    (request) =>
      handleDaemonApiRequest(db, commandOptions, runLifecycle, request),
  );

  return {
    async stop() {
      await server.shutdown();
    },
  };
}

async function handleDaemonApiRequest(
  db: PM3Database,
  commandOptions: RunCommandOptions,
  runLifecycle: DaemonApiLifecycle,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (request.method === "GET" && path === "/projects") {
      const detailed = readBooleanFlag(url.searchParams, ["detailed", "d"]);
      return jsonResponse({
        projects: await listDaemonApiProjects(db, commandOptions, detailed),
      });
    }

    const match = path.match(
      /^\/projects\/([^/]+)\/(start|stop|restart|show)$/,
    );
    if (!match) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { error: `Method ${request.method} not allowed` },
        { headers: { Allow: "POST" }, status: 405 },
      );
    }

    const name = decodeURIComponent(match[1]);
    const action = match[2] as ApiLifecycleAction | "show";
    const project = await getProjectByName(db, name);
    if (!project) {
      return jsonResponse(
        { error: `Project not found: ${name}` },
        { status: 404 },
      );
    }

    if (action === "show") {
      return jsonResponse({
        project: await buildDaemonApiProjectShow(project, commandOptions),
      });
    }

    const body = await readRequestBody(request);
    await runLifecycle(
      project,
      action,
      readLifecycleRequestOptions(action, url, body),
    );

    return jsonResponse({
      project: await buildDaemonApiProjectShow(project, commandOptions),
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonResponse(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    if (error instanceof Error) {
      return jsonResponse(
        { error: error.message || "Command failed" },
        { status: isInputError(error) ? 400 : 500 },
      );
    }

    return jsonResponse({ error: "Command failed" }, { status: 500 });
  }
}

async function listDaemonApiProjects(
  db: PM3Database,
  commandOptions: RunCommandOptions,
  detailed: boolean,
): Promise<ProjectListResponse[]> {
  const projects = await listProjects(db);
  return await Promise.all(
    projects.map((project) =>
      buildDaemonApiProjectListItem(project, commandOptions, detailed),
    ),
  );
}

async function buildDaemonApiProjectListItem(
  project: ProjectListItem,
  commandOptions: RunCommandOptions,
  detailed: boolean,
): Promise<ProjectListResponse> {
  const containers = await listProjectContainers(project, commandOptions);
  const state = formatProjectState(containers, { detailed });

  return {
    created: state.created,
    enabled: project.enabled === 1,
    name: project.name,
    ports: state.ports,
    state: state.state,
    workingDir: project.workingDir,
  };
}

async function buildDaemonApiProjectShow(
  project: Pick<ProjectListItem, "enabled" | "name" | "workingDir">,
  commandOptions: RunCommandOptions,
): Promise<ProjectShowResponse> {
  const { runSystemProcess } = await import("../cli/runtime/process.ts");
  const containers = await listProjectContainers(project, commandOptions);
  const state = formatProjectState(containers, { detailed: true });
  const runProcess = commandOptions.runProcess ?? runSystemProcess;
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

  return {
    created: state.created,
    enabled: project.enabled === 1,
    name: project.name,
    ports: state.ports,
    services: [...serviceNames]
      .sort((left, right) => left.localeCompare(right))
      .map((service) => buildDaemonApiService(service, containers)),
    state: state.state,
    workingDir: project.workingDir,
  };
}

function buildDaemonApiService(
  service: string,
  containers: Awaited<ReturnType<typeof listProjectContainers>>,
): ProjectServiceResponse {
  const state = formatProjectState(
    containers.filter((container) => container.service === service),
    { detailed: true },
  );

  return {
    ports: state.ports,
    service,
    state: state.state,
  };
}

function readLifecycleRequestOptions(
  action: ApiLifecycleAction,
  url: URL,
  body: Record<string, unknown>,
): LifecycleRequestOptions {
  const build = readOptionalRequestFlag(url.searchParams, body, ["build", "b"]);
  const noBuild = readOptionalRequestFlag(url.searchParams, body, [
    "noBuild",
    "no-build",
  ]);
  return {
    build: noBuild ? false : (build ?? action === "restart"),
    noCache: readRequestFlag(url.searchParams, body, [
      "noCache",
      "no-cache",
      "c",
    ]),
  };
}

async function readRequestBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (!request.body) {
    return {};
  }

  const text = await request.text();
  if (!text.trim()) {
    return {};
  }

  const value = JSON.parse(text) as unknown;
  return isPlainObject(value) ? value : {};
}

function readRequestFlag(
  searchParams: URLSearchParams,
  body: Record<string, unknown>,
  names: readonly string[],
): boolean {
  return readOptionalRequestFlag(searchParams, body, names) ?? false;
}

function readOptionalRequestFlag(
  searchParams: URLSearchParams,
  body: Record<string, unknown>,
  names: readonly string[],
): boolean | undefined {
  for (const name of names) {
    if (name in body) {
      return parseBooleanValue(body[name], name);
    }
  }

  return readOptionalBooleanFlag(searchParams, names);
}

function readBooleanFlag(
  searchParams: URLSearchParams,
  names: readonly string[],
): boolean {
  return readOptionalBooleanFlag(searchParams, names) ?? false;
}

function readOptionalBooleanFlag(
  searchParams: URLSearchParams,
  names: readonly string[],
): boolean | undefined {
  for (const name of names) {
    const value = searchParams.get(name);
    if (value !== null) {
      return parseBooleanValue(value, name);
    }
  }

  return undefined;
}

function parseBooleanValue(value: unknown, name: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number" && (value === 0 || value === 1)) {
    return value === 1;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["", "0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  throw inputError(`Invalid boolean value for ${name}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isInputError(error: Error): boolean {
  return (
    error.message.startsWith("Invalid boolean value for ") ||
    error.message.startsWith("Failed to list compose services for ")
  );
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}
