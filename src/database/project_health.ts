import type { Insertable, Selectable } from "kysely";
import type { ProjectComposeHealthStatus } from "../cli/runtime/compose_events.ts";
import type { PM3Database } from "./database.ts";

export type ProjectServiceHealthTable = {
  projectId: number;
  service: string;
  status: ProjectComposeHealthStatus;
  updatedAt: string;
};

export type ProjectServiceHealth = Selectable<ProjectServiceHealthTable>;

export async function listProjectServiceHealth(
  db: PM3Database,
): Promise<ProjectServiceHealth[]> {
  return await db.selectFrom("projectServiceHealth").selectAll().execute();
}

export type SetProjectServiceHealthInput = Pick<
  Insertable<ProjectServiceHealthTable>,
  "projectId" | "service" | "status"
>;

export async function setProjectServiceHealth(
  db: PM3Database,
  input: SetProjectServiceHealthInput,
): Promise<void> {
  const updatedAt = new Date().toISOString();

  await db
    .insertInto("projectServiceHealth")
    .values({ ...input, updatedAt })
    .onConflict((conflict) =>
      conflict.columns(["projectId", "service"]).doUpdateSet({
        status: input.status,
        updatedAt,
      })
    )
    .execute();
}
