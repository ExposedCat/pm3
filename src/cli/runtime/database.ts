import { join } from "@std/path";
import {
  closeDatabase,
  createDatabase,
  type PM3Database,
} from "../../database/database.ts";
import type { RunCommandOptions } from "../command.ts";

const DATABASE_PATH_ENV = "PM3_DATABASE_PATH";
const XDG_DATA_HOME_ENV = "XDG_DATA_HOME";
const HOME_ENV = "HOME";
const DATA_DIR_NAME = "pm3";
const DATABASE_FILE_NAME = "pm3.sqlite";

export async function withCliDatabase<T>(
  options: RunCommandOptions,
  callback: (db: PM3Database) => Promise<T>,
): Promise<T> {
  const db = await createDatabase(resolveCliDatabasePath(options));

  try {
    return await callback(db);
  } finally {
    await closeDatabase(db);
  }
}

function resolveCliDatabasePath(options: RunCommandOptions): string {
  return (
    options.databasePath ??
    getEnv(DATABASE_PATH_ENV) ??
    join(resolveUserDataDir(), DATA_DIR_NAME, DATABASE_FILE_NAME)
  );
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
