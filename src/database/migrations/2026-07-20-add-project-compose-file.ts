import type { Migration } from "kysely";

export const up: Migration["up"] = async (db) => {
  await db.schema
    .alterTable("projects")
    .addColumn("composeFile", "text")
    .execute();
};

export const down: NonNullable<Migration["down"]> = async (db) => {
  await db.schema.alterTable("projects").dropColumn("composeFile").execute();
};
