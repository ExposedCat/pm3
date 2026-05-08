import type {
  ProjectComposeHealthStatus,
  ProjectComposeServiceStatus,
} from "./compose_events.ts";

export type ComposeHookEvent =
  | ProjectComposeHealthStatus
  | ProjectComposeServiceStatus;

type ComposeHookLookup = {
  event: ComposeHookEvent;
  project: string;
  service: string;
};

export function resolveComposeHookCommand({
  event,
  project,
  service,
}: ComposeHookLookup): string {
  return Deno.env.get(`PM3_${project}_${service}_${event}_EXEC`)?.trim() ?? "";
}
