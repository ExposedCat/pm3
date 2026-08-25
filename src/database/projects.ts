import type { Generated, Insertable, Selectable } from "kysely";
import type { PM3Database } from "./database.ts";

type ProjectEnabledValue = 0 | 1;
type ProjectGitValue = 0 | 1;

export type ProjectTable = {
  composeArgs: Generated<string>;
  id: Generated<number>;
  name: string;
  workingDir: string;
  enabled: Generated<ProjectEnabledValue>;
  git: Generated<ProjectGitValue>;
};

type ProjectRow = Selectable<ProjectTable>;

export type Project = Omit<ProjectRow, "composeArgs"> & {
  composeArgs: string[];
};
export type ProjectListItem = Pick<
  Project,
  "composeArgs" | "id" | "name" | "workingDir" | "enabled" | "git"
>;

const PROJECT_DISABLED = 0 as const;
const PROJECT_ENABLED = 1 as const;
const PROJECT_GIT_DISABLED = 0 as const;
const PROJECT_GIT_ENABLED = 1 as const;

export async function listProjects(
  db: PM3Database,
): Promise<ProjectListItem[]> {
  const projects = await db
    .selectFrom("projects")
    .select(["composeArgs", "id", "name", "workingDir", "enabled", "git"])
    .orderBy("name", "asc")
    .execute();

  return projects.map(parseProject);
}

export async function listEnabledProjects(db: PM3Database): Promise<Project[]> {
  const projects = await db
    .selectFrom("projects")
    .selectAll()
    .where("enabled", "=", PROJECT_ENABLED)
    .orderBy("name", "asc")
    .execute();

  return projects.map(parseProject);
}

export async function getProjectDetails(
  db: PM3Database,
  id: number,
): Promise<Project | undefined> {
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  return project ? parseProject(project) : undefined;
}

export async function getProjectByName(
  db: PM3Database,
  name: string,
): Promise<Project | undefined> {
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("name", "=", name)
    .executeTakeFirst();

  return project ? parseProject(project) : undefined;
}

export type AddProjectInput =
  & Pick<
    Insertable<ProjectTable>,
    "name" | "workingDir"
  >
  & {
    composeArgs?: readonly string[];
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
      ...(input.composeArgs === undefined
        ? {}
        : { composeArgs: JSON.stringify(input.composeArgs) }),
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

function parseProject(project: ProjectRow): Project {
  const composeArgs: unknown = JSON.parse(project.composeArgs);
  if (
    !Array.isArray(composeArgs) ||
    !composeArgs.every((arg): arg is string => typeof arg === "string")
  ) {
    throw new Error(`Invalid compose arguments for project: ${project.name}`);
  }

  return { ...project, composeArgs };
}
