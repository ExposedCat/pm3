import { DatabaseSync } from "node:sqlite";
import { PolySqliteDialect } from "@soapbox/kysely-deno-sqlite";
import { dirname, fromFileUrl } from "@std/path";
import type { CompiledQuery, QueryResult } from "kysely";
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
  const database = new DatabaseSync(path);

  const db = new Kysely<DatabaseSchema>({
    dialect: new PolySqliteDialect({
      database: createNodeSqliteAdapter(database),
    }),
  });

  await migrateDatabase<DatabaseSchema>(db);

  return db;
}

export async function closeDatabase(db: PM3Database): Promise<void> {
  await db.destroy();
}

type NodeSqliteValue = null | number | bigint | string | Uint8Array;

type NodeSqliteRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

function createNodeSqliteAdapter(database: DatabaseSync) {
  return {
    executeQuery<R>({
      sql,
      parameters,
    }: CompiledQuery): Promise<QueryResult<R>> {
      const statement = database.prepare(sql);
      const values = parameters.map(normalizeNodeSqliteValue);

      if (expectsRows(sql)) {
        return Promise.resolve({ rows: statement.all(...values) as R[] });
      }

      const result = statement.run(...values) as NodeSqliteRunResult;
      return Promise.resolve({
        rows: [],
        numAffectedRows: BigInt(result.changes),
        insertId: BigInt(result.lastInsertRowid),
      });
    },
    async *streamQuery<R>({ sql, parameters }: CompiledQuery) {
      const statement = database.prepare(sql);
      const values = parameters.map(normalizeNodeSqliteValue);

      for (const row of statement.iterate(...values)) {
        yield { rows: [row as R] };
      }
    },
    destroy(): Promise<void> {
      database.close();
      return Promise.resolve();
    },
  };
}

function normalizeNodeSqliteValue(value: unknown): NodeSqliteValue {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value as NodeSqliteValue;
}

function expectsRows(sql: string): boolean {
  const normalized = sql.trimStart().toLowerCase();
  return (
    normalized.startsWith("select") ||
    normalized.startsWith("pragma") ||
    normalized.startsWith("explain") ||
    normalized.startsWith("with") ||
    /\breturning\b/i.test(sql)
  );
}
