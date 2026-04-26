import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { closeDatabase, createDatabase } from "./database.ts";
import {
  addProject,
  getProjectByName,
  getProjectDetails,
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
      { id: project.id, name: "api", workingDir: project.workingDir },
    ]);
    assertEquals(await getProjectDetails(db, project.id), project);
    assertEquals(await getProjectByName(db, "api"), project);
    assertEquals(await getProjectByName(db, "missing"), undefined);
  } finally {
    await closeDatabase(db);
    await Deno.remove(dir, { recursive: true });
  }
});
