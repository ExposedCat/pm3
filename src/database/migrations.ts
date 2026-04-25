import { type Kysely, Migrator } from "kysely";
import * as createProjects from "./migrations/2026-04-22-create-projects.ts";

const migrations = {
  "2026-04-22-create-projects": createProjects,
};

export async function migrateDatabase<DB>(db: Kysely<DB>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: {
      getMigrations: () => Promise.resolve(migrations),
    },
  });

  const { error } = await migrator.migrateToLatest();
  if (error) {
    throw error;
  }
}
