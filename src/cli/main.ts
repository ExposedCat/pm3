import { parseArgs, runCommand } from "./commands.ts";
import { formatCliError } from "./errors.ts";

export async function runCliMain(args: readonly string[]): Promise<number> {
  try {
    await runCommand(parseArgs([...args]));
    return 0;
  } catch (error) {
    const { message } = formatCliError(error);
    console.error(message);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await runCliMain(Deno.args));
}
