import type { Insertable, Selectable } from "kysely";
import type { ProjectComposeServiceStatus } from "../cli/runtime/compose_events.ts";
import type { PM3Database } from "./database.ts";

export type ProjectServiceStateTable = {
  projectId: number;
  service: string;
  status: ProjectComposeServiceStatus;
  updatedAt: string;
};

export type ProjectServiceState = Selectable<ProjectServiceStateTable>;

export async function listProjectServiceStates(
  db: PM3Database,
): Promise<ProjectServiceState[]> {
  return await db.selectFrom("projectServiceState").selectAll().execute();
}

export type SetProjectServiceStateInput = Pick<
  Insertable<ProjectServiceStateTable>,
  "projectId" | "service" | "status"
>;

export async function setProjectServiceState(
  db: PM3Database,
  input: SetProjectServiceStateInput,
): Promise<void> {
  const updatedAt = new Date().toISOString();

  await db
    .insertInto("projectServiceState")
    .values({ ...input, updatedAt })
    .onConflict((conflict) =>
      conflict.columns(["projectId", "service"]).doUpdateSet({
        status: input.status,
        updatedAt,
      })
    )
    .execute();
}
