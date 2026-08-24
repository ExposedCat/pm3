import type { PM3Database } from "../database/database.ts";
import type { Project } from "../database/projects.ts";
import { createCommand } from "./commands/create.ts";
import { daemonCommand } from "./commands/daemon.ts";
import { disableCommand } from "./commands/disable.ts";
import { enableCommand } from "./commands/enable.ts";
import { helpCommand } from "./commands/help.ts";
import {
  restartCommand,
  startCommand,
  stopCommand,
} from "./commands/lifecycle.ts";
import { listCommand } from "./commands/list.ts";
import { logsCommand } from "./commands/logs.ts";
import { removeCommand } from "./commands/remove.ts";
import { viewCommand } from "./commands/view.ts";
import { inputError, usageError } from "./errors.ts";
import type { RunLineStream, RunProcess } from "./runtime/process.ts";

export const commandDefinitions = [
  createCommand,
  enableCommand,
  disableCommand,
  startCommand,
  stopCommand,
  restartCommand,
  logsCommand,
  listCommand,
  viewCommand,
  removeCommand,
  daemonCommand,
  helpCommand,
] as const;

export type Command = ReturnType<(typeof commandDefinitions)[number]["parse"]>;

export type RunCommandOptions = {
  databasePath?: string;
  detachSignal?: AbortSignal;
  launchDetachedLifecycle?: (command: DetachedLifecycleLaunch) => Promise<void>;
  runLineStream?: RunLineStream;
  runProcess?: RunProcess;
  signal?: AbortSignal;
  verbose?: boolean;
};

export type DetachedLifecycleLaunch = {
  args: readonly string[];
  env: Record<string, string>;
};

export type CliCommand<TKind extends string = string> = {
  kind: TKind;
  run(options: RunCommandOptions): Promise<void>;
};

export type CommandDefinition<TCommand extends CliCommand = CliCommand> = {
  names: readonly [string, ...string[]];
  args: readonly string[];
  options?: readonly string[];
  description: string;
  parse(args: string[]): TCommand;
};

export type ParsedCommand = {
  command: Command;
  verbose: boolean;
};

export function parseArgs(args: string[]): ParsedCommand {
  const { commandArgs, verbose } = parseGlobalOptions(args);
  const [commandName, ...rest] = commandArgs;

  if (!commandName) {
    return { command: helpCommand.parse([]), verbose };
  }

  const definition = commandDefinitions.find((command) =>
    command.names.includes(commandName),
  );
  if (!definition) {
    throw usageError(`Unknown command: ${commandName}`);
  }

  return { command: definition.parse(rest), verbose };
}

export async function runCommand(
  parsedCommand: ParsedCommand,
  options: RunCommandOptions = {},
): Promise<void> {
  const { command, verbose } = parsedCommand;
  await command.run({ ...options, verbose: options.verbose ?? verbose });
}

type MissingProjectMessage = string | ((name: string) => string);

export async function withNamedProject<T>(
  options: RunCommandOptions,
  name: string,
  callback: (db: PM3Database, project: Project) => Promise<T>,
  missingMessage: MissingProjectMessage = (projectName) =>
    `Project not found: ${projectName}`,
): Promise<T> {
  const { getProjectByName } = await import("../database/projects.ts");
  const { withCliDatabase } = await import("./runtime/database.ts");

  return await withCliDatabase(options, async (db) => {
    const project = await getProjectByName(db, name);
    if (!project) {
      throw inputError(
        typeof missingMessage === "function"
          ? missingMessage(name)
          : missingMessage,
      );
    }

    return await callback(db, project);
  });
}

export async function withTargetProjects<T>(
  options: RunCommandOptions,
  name: string | undefined,
  callback: (db: PM3Database, project: Project) => Promise<T>,
  missingMessage?: MissingProjectMessage,
): Promise<T[]> {
  return await withTargetProjectList(
    options,
    name,
    async (db, projects) => {
      const results: T[] = [];
      for (const project of projects) {
        results.push(await callback(db, project));
      }

      return results;
    },
    missingMessage,
  );
}

export async function withTargetProjectList<T>(
  options: RunCommandOptions,
  name: string | undefined,
  callback: (db: PM3Database, projects: readonly Project[]) => Promise<T>,
  missingMessage: MissingProjectMessage = (projectName) =>
    `Project not found: ${projectName}`,
): Promise<T> {
  const { getProjectByName, listProjects } = await import(
    "../database/projects.ts"
  );
  const { withCliDatabase } = await import("./runtime/database.ts");

  return await withCliDatabase(options, async (db) => {
    if (name) {
      const project = await getProjectByName(db, name);
      if (!project) {
        throw inputError(
          typeof missingMessage === "function"
            ? missingMessage(name)
            : missingMessage,
        );
      }

      return await callback(db, [project]);
    }

    const projects = await listProjects(db);
    if (projects.length === 0) {
      throw inputError("No projects registered.");
    }

    return await callback(db, projects);
  });
}

type GlobalOptionsResult = {
  commandArgs: string[];
  verbose: boolean;
};

function parseGlobalOptions(args: readonly string[]): GlobalOptionsResult {
  const commandArgs: string[] = [];
  let verbose = false;

  for (const arg of args) {
    if (arg === "-v" || arg === "--verbose") {
      verbose = true;
      continue;
    }

    commandArgs.push(arg);
  }

  return { commandArgs, verbose };
}
