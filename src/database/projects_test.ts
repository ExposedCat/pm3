import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { closeDatabase, createDatabase } from "./database.ts";
import {
  addProject,
  deleteProject,
  disableProject,
  enableProject,
  getProjectByName,
  getProjectDetails,
  listEnabledProjects,
  listProjects,
} from "./projects.ts";

Deno.test("projects can be added, listed, and loaded", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pm3-projects-test-" });
  const db = await createDatabase(join(dir, "pm3.sqlite"));

  try {
    const project = await addProject(db, {
      name: "api",
      workingDir: "/tmp/api",
    });

    assertEquals(await listProjects(db), [
      {
        id: project.id,
        name: "api",
        workingDir: project.workingDir,
        enabled: 0,
      },
    ]);
    assertEquals(await getProjectDetails(db, project.id), {
      ...project,
      enabled: 0,
    });
    assertEquals(await getProjectByName(db, "api"), project);
    assertEquals(await getProjectByName(db, "missing"), undefined);
    assertEquals(await listEnabledProjects(db), []);

    await enableProject(db, project.id);
    await enableProject(db, project.id);
    assertEquals(await listEnabledProjects(db), [
      {
        id: project.id,
        name: "api",
        workingDir: project.workingDir,
        enabled: 1,
      },
    ]);

    await disableProject(db, project.id);
    await disableProject(db, project.id);
    assertEquals(await getProjectDetails(db, project.id), {
      ...project,
      enabled: 0,
    });
    assertEquals(await listEnabledProjects(db), []);

    await deleteProject(db, project.id);
    assertEquals(await listProjects(db), []);
    assertEquals(await getProjectDetails(db, project.id), undefined);
  } finally {
    await closeDatabase(db);
    await Deno.remove(dir, { recursive: true });
  }
});
