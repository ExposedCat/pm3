import type { ProcessCommand, ProcessResult } from "../command.ts";

export async function runSystemProcess(
  command: ProcessCommand,
): Promise<ProcessResult> {
  const outputMode = command.captureOutput ? "piped" : "inherit";
  const process = new Deno.Command(command.command, {
    args: [...command.args],
    cwd: command.cwd,
    stdin: "inherit",
    stdout: outputMode,
    stderr: outputMode,
  });

  if (command.captureOutput) {
    const output = await process.output();

    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout).trimEnd(),
      stderr: new TextDecoder().decode(output.stderr).trimEnd(),
    };
  }

  const child = process.spawn();
  const status = await child.status;

  return { code: status.code };
}
