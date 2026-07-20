import type { Generated, Insertable, Selectable } from "kysely";
import type { PM3Database } from "./database.ts";

type ProjectEnabledValue = 0 | 1;
type ProjectGitValue = 0 | 1;

export type ProjectTable = {
  composeFile: string | null;
  id: Generated<number>;
  name: string;
  workingDir: string;
  enabled: Generated<ProjectEnabledValue>;
  git: Generated<ProjectGitValue>;
};

export type Project = Selectable<ProjectTable>;
export type ProjectListItem = Pick<
  Project,
  "composeFile" | "id" | "name" | "workingDir" | "enabled" | "git"
>;

const PROJECT_DISABLED = 0 as const;
const PROJECT_ENABLED = 1 as const;
const PROJECT_GIT_DISABLED = 0 as const;
const PROJECT_GIT_ENABLED = 1 as const;

export async function listProjects(
  db: PM3Database,
): Promise<ProjectListItem[]> {
  return await db
    .selectFrom("projects")
    .select(["composeFile", "id", "name", "workingDir", "enabled", "git"])
    .orderBy("name", "asc")
    .execute();
}

export async function listEnabledProjects(db: PM3Database): Promise<Project[]> {
  return await db
    .selectFrom("projects")
    .selectAll()
    .where("enabled", "=", PROJECT_ENABLED)
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
> & {
  composeFile?: string;
  git?: boolean;
};

export async function addProject(
  db: PM3Database,
  input: AddProjectInput,
): Promise<Project> {
  const result = await db
    .insertInto("projects")
    .values({
      name: input.name,
      workingDir: input.workingDir,
      ...(input.composeFile === undefined
        ? {}
        : { composeFile: input.composeFile }),
      ...(input.git === undefined ? {} : { git: toProjectGitValue(input.git) }),
    })
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

export async function enableProject(
  db: PM3Database,
  id: number,
): Promise<void> {
  await setProjectEnabled(db, id, PROJECT_ENABLED);
}

export async function disableProject(
  db: PM3Database,
  id: number,
): Promise<void> {
  await setProjectEnabled(db, id, PROJECT_DISABLED);
}

export async function setProjectGit(
  db: PM3Database,
  id: number,
  git: boolean,
): Promise<void> {
  await db
    .updateTable("projects")
    .set({ git: toProjectGitValue(git) })
    .where("id", "=", id)
    .execute();
}

async function setProjectEnabled(
  db: PM3Database,
  id: number,
  enabled: ProjectEnabledValue,
): Promise<void> {
  await db
    .updateTable("projects")
    .set({ enabled })
    .where("id", "=", id)
    .execute();
}

function toProjectGitValue(git: boolean): ProjectGitValue {
  return git ? PROJECT_GIT_ENABLED : PROJECT_GIT_DISABLED;
}
