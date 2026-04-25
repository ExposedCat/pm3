import { Database as SqliteDatabase } from "@db/sqlite";
import { DenoSqlite3Dialect } from "@soapbox/kysely-deno-sqlite";
import { dirname, fromFileUrl } from "@std/path";
import { Kysely } from "kysely";
import { migrateDatabase } from "./migrations.ts";
import type { ProjectTable } from "./projects.ts";

export const DEFAULT_DATABASE_PATH = fromFileUrl(
  new URL("../../data/pm3.sqlite", import.meta.url),
);

export type DatabaseSchema = {
  projects: ProjectTable;
};

export type PM3Database = Kysely<DatabaseSchema>;

export async function createDatabase(
  path = DEFAULT_DATABASE_PATH,
): Promise<PM3Database> {
  Deno.mkdirSync(dirname(path), { recursive: true });

  const db = new Kysely<DatabaseSchema>({
    dialect: new DenoSqlite3Dialect({
      database: new SqliteDatabase(path),
    }),
  });

  await migrateDatabase<DatabaseSchema>(db);

  return db;
}

export async function closeDatabase(db: PM3Database): Promise<void> {
  await db.destroy();
}
