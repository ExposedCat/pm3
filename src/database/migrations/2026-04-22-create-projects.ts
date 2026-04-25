import type { Migration } from "kysely";

export const up: Migration["up"] = async (db) => {
  await db.schema
    .createTable("projects")
    .ifNotExists()
    .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("name", "text", (column) => column.notNull().unique())
    .addColumn("workingDir", "text", (column) => column.notNull())
    .execute();
};

export const down: NonNullable<Migration["down"]> = async (db) => {
  await db.schema.dropTable("projects").ifExists().execute();
};
