import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { closeDatabase, createDatabase } from "./database.ts";
import {
  listProjectServiceStates,
  setProjectServiceState,
} from "./project_state.ts";
import { addProject, deleteProject } from "./projects.ts";

Deno.test("project service states are stored and cascade on project delete", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pm3-project-state-test-" });
  const db = await createDatabase(join(dir, "pm3.sqlite"));

  try {
    const project = await addProject(db, {
      name: "api",
      workingDir: "/tmp/api",
    });

    await setProjectServiceState(db, {
      projectId: project.id,
      service: "web",
      status: "started",
    });
    await setProjectServiceState(db, {
      projectId: project.id,
      service: "web",
      status: "stopped",
    });

    const states = await listProjectServiceStates(db);
    assertEquals(states.length, 1);
    assertEquals(states[0]?.projectId, project.id);
    assertEquals(states[0]?.service, "web");
    assertEquals(states[0]?.status, "stopped");

    await deleteProject(db, project.id);
    assertEquals(await listProjectServiceStates(db), []);
  } finally {
    await closeDatabase(db);
    await Deno.remove(dir, { recursive: true });
  }
});
