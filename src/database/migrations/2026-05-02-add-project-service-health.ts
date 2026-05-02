import type { Migration } from "kysely";

export const up: Migration["up"] = async (db) => {
  await db.schema
    .createTable("projectServiceHealth")
    .ifNotExists()
    .addColumn("projectId", "integer", (column) =>
      column.notNull().references("projects.id").onDelete("cascade"),
    )
    .addColumn("service", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("updatedAt", "text", (column) => column.notNull())
    .addPrimaryKeyConstraint("projectServiceHealthPrimary", [
      "projectId",
      "service",
    ])
    .execute();
};

export const down: NonNullable<Migration["down"]> = async (db) => {
  await db.schema.dropTable("projectServiceHealth").ifExists().execute();
};
