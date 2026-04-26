import type { Generated, Insertable, Selectable } from "kysely";
import type { PM3Database } from "./database.ts";

export type ProjectTable = {
  id: Generated<number>;
  name: string;
  workingDir: string;
};

export type Project = Selectable<ProjectTable>;
export type ProjectListItem = Pick<Project, "id" | "name" | "workingDir">;

export async function listProjects(
  db: PM3Database,
): Promise<ProjectListItem[]> {
  return await db
    .selectFrom("projects")
    .select(["id", "name", "workingDir"])
    .orderBy("name", "asc")
    .execute();
}

export async function getProjectDetails(
  db: PM3Database,
  id: number,
): Promise<Project | undefined> {
  return await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function getProjectByName(
  db: PM3Database,
  name: string,
): Promise<Project | undefined> {
  return await db
    .selectFrom("projects")
    .selectAll()
    .where("name", "=", name)
    .executeTakeFirst();
}

export type AddProjectInput = Pick<
  Insertable<ProjectTable>,
  "name" | "workingDir"
>;

export async function addProject(
  db: PM3Database,
  input: AddProjectInput,
): Promise<Project> {
  const result = await db
    .insertInto("projects")
    .values(input)
    .executeTakeFirst();

  const project = await getProjectDetails(db, Number(result.insertId));
  if (!project) {
    throw new Error("Project was inserted but could not be loaded.");
  }

  return project;
}

export async function deleteProject(
  db: PM3Database,
  id: number,
): Promise<void> {
  await db.deleteFrom("projects").where("id", "=", id).execute();
}
