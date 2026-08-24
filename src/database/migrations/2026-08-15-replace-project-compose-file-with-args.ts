import { type Migration, sql } from "kysely";

export const up: Migration["up"] = async (db) => {
  await db.schema
    .alterTable("projects")
    .addColumn("composeArgs", "text", (column) =>
      column.notNull().defaultTo("[]"),
    )
    .execute();
  await sql`
    UPDATE projects
    SET composeArgs = json_array('-f', composeFile)
    WHERE composeFile IS NOT NULL
  `.execute(db);
  await db.schema.alterTable("projects").dropColumn("composeFile").execute();
};

export const down: NonNullable<Migration["down"]> = async (db) => {
  await db.schema
    .alterTable("projects")
    .addColumn("composeFile", "text")
    .execute();
  await sql`
    UPDATE projects
    SET composeFile = json_extract(composeArgs, '$[1]')
    WHERE json_array_length(composeArgs) = 2
      AND json_extract(composeArgs, '$[0]') = '-f'
  `.execute(db);
  await db.schema.alterTable("projects").dropColumn("composeArgs").execute();
};
