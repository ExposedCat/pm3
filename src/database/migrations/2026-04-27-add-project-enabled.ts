import type { Migration } from "kysely";

export const up: Migration["up"] = async (db) => {
  await db.schema
    .alterTable("projects")
    .addColumn("enabled", "integer", (column) => column.notNull().defaultTo(0))
    .execute();
};

export const down: NonNullable<Migration["down"]> = async (db) => {
  await db.schema.alterTable("projects").dropColumn("enabled").execute();
};
