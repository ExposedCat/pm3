import { DatabaseSync } from "node:sqlite";
import { assertEquals } from "@std/assert";
import { closeDatabase, createDatabase } from "./database.ts";
import { addProject, getProjectByName } from "./projects.ts";

Deno.test("project compose arguments are persisted in order", async () => {
  const directory = await Deno.makeTempDir();

  try {
    const db = await createDatabase(`${directory}/pm3.sqlite`);
    try {
      await addProject(db, {
        composeArgs: ["-f", "compose.prod.yaml", "--profile", "production"],
        name: "api",
        workingDir: "/project",
      });

      const project = await getProjectByName(db, "api");
      assertEquals(project?.composeArgs, [
        "-f",
        "compose.prod.yaml",
        "--profile",
        "production",
      ]);
    } finally {
      await closeDatabase(db);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("legacy compose files migrate to compose arguments", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;

  try {
    const initializedDb = await createDatabase(databasePath);
    await closeDatabase(initializedDb);

    const legacyDb = new DatabaseSync(databasePath);
    try {
      legacyDb.exec("ALTER TABLE projects ADD COLUMN composeFile TEXT");
      legacyDb
        .prepare("DELETE FROM kysely_migration WHERE name = ?")
        .run("2026-08-15-replace-project-compose-file-with-args");
      legacyDb.exec("ALTER TABLE projects DROP COLUMN composeArgs");
      legacyDb
        .prepare(
          "INSERT INTO projects (name, workingDir, enabled, git, composeFile) VALUES (?, ?, ?, ?, ?)",
        )
        .run("api", "/project", 0, 0, "/project/compose.prod.yaml");
    } finally {
      legacyDb.close();
    }

    const migratedDb = await createDatabase(databasePath);
    try {
      const project = await getProjectByName(migratedDb, "api");
      assertEquals(project?.composeArgs, ["-f", "/project/compose.prod.yaml"]);
    } finally {
      await closeDatabase(migratedDb);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
