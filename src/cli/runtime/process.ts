import type { ProcessCommand, ProcessResult } from "../command.ts";

export async function runSystemProcess(
  command: ProcessCommand,
): Promise<ProcessResult> {
  const child = new Deno.Command(command.command, {
    args: [...command.args],
    cwd: command.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;

  return { code: status.code };
}
