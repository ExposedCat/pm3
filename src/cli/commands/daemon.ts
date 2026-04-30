import type { CliCommand, CommandDefinition } from "../commands.ts";
import { usageError } from "../errors.ts";

export type DaemonCommand = CliCommand<"daemon">;

export const daemonCommand = {
  names: ["daemon"],
  args: [],
  options: [],
  description: "Run daemon for enabled projects",
  parse: parseDaemonArgs,
} satisfies CommandDefinition<DaemonCommand>;

function parseDaemonArgs(args: string[]): DaemonCommand {
  const [arg] = args;
  if (arg) {
    throw usageError(`Unexpected argument for daemon: ${arg}`);
  }

  return {
    kind: "daemon",
    run: async (options) => {
      const { withCliDatabase } = await import("../runtime/database.ts");
      const { runDaemon } = await import("../../runtime/daemon.ts");

      await withCliDatabase(options, async (db) => {
        await runDaemon(db, options);
      });
    },
  };
}
