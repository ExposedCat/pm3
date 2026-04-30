import {
  closeDatabase,
  createDatabase,
  type PM3Database,
} from "../../database/database.ts";
import type { RunCommandOptions } from "../commands.ts";

export async function withCliDatabase<T>(
  options: RunCommandOptions,
  callback: (db: PM3Database) => Promise<T>,
): Promise<T> {
  const db = await createDatabase(options.databasePath);

  try {
    return await callback(db);
  } finally {
    await closeDatabase(db);
  }
}
