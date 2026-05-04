import { parse as parseYaml } from "@std/yaml";
import { inputError } from "../errors.ts";
import type {
  ProjectComposeHealthStatus,
  ProjectComposeServiceStatus,
} from "./compose_events.ts";
import {
  type ComposeConfigDiscovery,
  readComposeConfig,
} from "./compose_files.ts";
import type { ProcessCommand } from "./process.ts";

type ComposeProject = {
  name: string;
  workingDir: string;
};

export type ComposeHookEvent =
  | ProjectComposeHealthStatus
  | ProjectComposeServiceStatus;

export type ComposeServiceHooksConfig = ReadonlyMap<ComposeHookEvent, string>;
export type ComposeHooksConfig = ReadonlyMap<string, ComposeServiceHooksConfig>;

export async function readComposeHooksConfig(
  project: ComposeProject,
  runProcess: (
    command: ProcessCommand,
  ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
): Promise<ComposeHooksConfig> {
  const discovery = await readComposeConfig(project, runProcess);
  if (discovery.kind === "missing-compose-file") {
    return new Map();
  }

  if (discovery.kind === "error") {
    throw inputError(
      `Failed to initialize hook config for ${project.name}: ${discovery.message}`,
    );
  }

  return parseComposeHooksConfig(discovery);
}

function parseComposeHooksConfig(
  discovery: Extract<ComposeConfigDiscovery, { kind: "config" }>,
): ComposeHooksConfig {
  const parsed = parseYaml(discovery.text);
  if (!isRecord(parsed)) {
    throw inputError("Invalid compose config: expected a mapping");
  }

  const extension = getRecord(parsed["x-pm3"]);
  const hooks = getRecord(extension.hooks);
  const config = new Map<string, ComposeServiceHooksConfig>();

  for (const [service, value] of Object.entries(hooks)) {
    const serviceHooks = getRecord(value);
    const eventHooks = new Map<ComposeHookEvent, string>();

    for (const event of HOOK_EVENTS) {
      const command = serviceHooks[event];
      if (typeof command !== "string" || command.trim().length === 0) {
        continue;
      }

      eventHooks.set(event, command.trim());
    }

    if (eventHooks.size > 0) {
      config.set(service, eventHooks);
    }
  }

  return config;
}

const HOOK_EVENTS = [
  "degraded",
  "healthy",
  "started",
  "starting",
  "stopped",
  "stopping",
] as const satisfies readonly ComposeHookEvent[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function resolveComposeHookCommand(
  config: ComposeHooksConfig | undefined,
  service: string,
  event: ComposeHookEvent,
): string {
  return config?.get(service)?.get(event) ?? config?.get("all")?.get(event) ?? "";
}
