import { parseArgs, runCommand } from "./commands.ts";
import { formatCliError } from "./errors.ts";

export async function runCliMain(args: readonly string[]): Promise<number> {
  try {
    await runCommand(parseArgs([...args]));
    return 0;
  } catch (error) {
    const { message, showUsage } = formatCliError(error);
    console.error(`pm3: ${message}`);
    if (showUsage) {
      console.error("Run `pm3 help` for usage.");
    }
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await runCliMain(Deno.args));
}
