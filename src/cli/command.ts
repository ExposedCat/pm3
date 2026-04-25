export type RunCommandOptions = {
  databasePath?: string;
  runProcess?: RunProcess;
};

export type ProcessCommand = {
  command: string;
  args: readonly string[];
  cwd: string;
};

export type ProcessResult = {
  code: number;
};

export type RunProcess = (command: ProcessCommand) => Promise<ProcessResult>;

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
