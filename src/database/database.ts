import { DatabaseSync } from "node:sqlite";
import { PolySqliteDialect } from "@soapbox/kysely-deno-sqlite";
import { dirname, join } from "@std/path";
import type { CompiledQuery, QueryResult } from "kysely";
import { Kysely } from "kysely";
import { migrateDatabase } from "./migrations.ts";
import type { ProjectServiceHealthTable } from "./project_health.ts";
import type { ProjectServiceStateTable } from "./project_state.ts";
import type { ProjectTable } from "./projects.ts";

const DATABASE_PATH_ENV = "PM3_DATABASE_PATH";
const XDG_DATA_HOME_ENV = "XDG_DATA_HOME";
const HOME_ENV = "HOME";
const DATA_DIR_NAME = "pm3";
const DATABASE_FILE_NAME = "pm3.sqlite";

export type DatabaseSchema = {
  projectServiceHealth: ProjectServiceHealthTable;
  projectServiceState: ProjectServiceStateTable;
  projects: ProjectTable;
};

export type PM3Database = Kysely<DatabaseSchema>;

export function resolveDatabasePath(path?: string): string {
  return (
    path ??
      getEnv(DATABASE_PATH_ENV) ??
      join(resolveUserDataDir(), DATA_DIR_NAME, DATABASE_FILE_NAME)
  );
}

export async function createDatabase(
  path = resolveDatabasePath(),
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

type NodeSqliteStatement = {
  readonly reader: boolean;
  all(parameters: ReadonlyArray<NodeSqliteValue>): unknown[];
  run(parameters: ReadonlyArray<NodeSqliteValue>): NodeSqliteRunResult;
  iterate(
    parameters: ReadonlyArray<NodeSqliteValue>,
  ): IterableIterator<unknown>;
};

function createNodeSqliteAdapter(database: DatabaseSync) {
  return {
    executeQuery<R>({
      query,
      sql,
      parameters,
    }: CompiledQuery): Promise<QueryResult<R>> {
      const statement = createNodeSqliteStatement(database.prepare(sql), query);
      const values = parameters.map(normalizeNodeSqliteValue);

      if (statement.reader) {
        return Promise.resolve({ rows: statement.all(values) as R[] });
      }

      const result = statement.run(values);
      const numAffectedRows = BigInt(result.changes);

      return Promise.resolve({
        rows: [],
        numAffectedRows,
        numUpdatedOrDeletedRows: numAffectedRows,
        insertId: BigInt(result.lastInsertRowid),
      });
    },
    async *streamQuery<R>({ query, sql, parameters }: CompiledQuery) {
      const statement = createNodeSqliteStatement(database.prepare(sql), query);
      const values = parameters.map(normalizeNodeSqliteValue);

      for (const row of statement.iterate(values)) {
        yield { rows: [row as R] };
      }
    },
    destroy(): Promise<void> {
      database.close();
      return Promise.resolve();
    },
  };
}

function createNodeSqliteStatement(
  statement: ReturnType<DatabaseSync["prepare"]>,
  query: CompiledQuery["query"],
): NodeSqliteStatement {
  return {
    reader: resolveQueryReader(statement, query),
    all(parameters) {
      return statement.all(...parameters);
    },
    run(parameters) {
      return statement.run(...parameters) as NodeSqliteRunResult;
    },
    iterate(parameters) {
      return statement.iterate(...parameters) as IterableIterator<unknown>;
    },
  };
}

function normalizeNodeSqliteValue(value: unknown): NodeSqliteValue {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value as NodeSqliteValue;
}

function resolveQueryReader(
  statement: ReturnType<DatabaseSync["prepare"]>,
  query: CompiledQuery["query"],
): boolean {
  const reader = (statement as { reader?: unknown }).reader;
  if (typeof reader === "boolean") {
    return reader;
  }

  switch (query.kind) {
    case "SelectQueryNode":
      return true;
    case "InsertQueryNode":
    case "UpdateQueryNode":
    case "DeleteQueryNode":
    case "MergeQueryNode":
      return "returning" in query && query.returning !== undefined;
    default:
      return false;
  }
}

function resolveUserDataDir(): string {
  return (
    getEnv(XDG_DATA_HOME_ENV) ?? join(requireEnv(HOME_ENV), ".local", "share")
  );
}

function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value) {
    throw new Error(`${name} is required to resolve the pm3 database path.`);
  }

  return value;
}

function getEnv(name: string): string | undefined {
  return Deno.env.get(name) || undefined;
}
