import { type Kysely, Migrator } from "kysely";
import * as createProjects from "./migrations/2026-04-22-create-projects.ts";
import * as addProjectEnabled from "./migrations/2026-04-27-add-project-enabled.ts";
import * as addProjectServiceHealth from "./migrations/2026-05-02-add-project-service-health.ts";
import * as addProjectServiceState from "./migrations/2026-05-02-add-project-service-state.ts";
import * as addProjectGit from "./migrations/2026-07-16-add-project-git.ts";

const migrations = {
  "2026-04-22-create-projects": createProjects,
  "2026-04-27-add-project-enabled": addProjectEnabled,
  "2026-05-02-add-project-service-health": addProjectServiceHealth,
  "2026-05-02-add-project-service-state": addProjectServiceState,
  "2026-07-16-add-project-git": addProjectGit,
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
