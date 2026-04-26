export type RunCommandOptions = {
  databasePath?: string;
  runLineStream?: RunLineStream;
  runProcess?: RunProcess;
  verbose?: boolean;
};

export type ProcessCommand = {
  command: string;
  args: readonly string[];
  cwd: string;
  captureOutput?: boolean;
  onOutput?: (chunk: ProcessOutputChunk) => void;
  verbose?: boolean;
};

export type ProcessOutputChunk = {
  stream: "stdout" | "stderr";
  text: string;
};

export type ProcessResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

export type RunProcess = (command: ProcessCommand) => Promise<ProcessResult>;

export type LineStreamCommand = {
  command: string;
  args: readonly string[];
  cwd?: string;
};

export type LineStream = {
  stop(): Promise<void>;
};

export type RunLineStream = (
  command: LineStreamCommand,
  onLine: (line: string) => void,
) => Promise<LineStream>;

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
