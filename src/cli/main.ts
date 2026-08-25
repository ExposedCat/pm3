import { parseArgs, runCommand } from "./commands.ts";
import { formatCliError } from "./errors.ts";

export async function runCliMain(args: readonly string[]): Promise<number> {
  const signals = createCliSignals();
  try {
    await runCommand(parseArgs([...args]), {
      detachSignal: signals.detachSignal,
      signal: signals.signal,
    });
    return 0;
  } catch (error) {
    const { message } = formatCliError(error);
    console.error(message);
    return 1;
  } finally {
    signals.dispose();
  }
}

if (import.meta.main) {
  Deno.exit(await runCliMain(Deno.args));
}

type CliSignals = {
  detachSignal: AbortSignal;
  dispose(): void;
  signal: AbortSignal;
};

function createCliSignals(): CliSignals {
  const interruptController = new AbortController();
  const detachController = new AbortController();
  const abort = () => interruptController.abort();
  const detach = () => detachController.abort();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, abort);
    interruptController.signal.addEventListener(
      "abort",
      () => Deno.removeSignalListener(signal, abort),
      { once: true },
    );
  }
  Deno.addSignalListener("SIGHUP", detach);

  return {
    detachSignal: detachController.signal,
    signal: interruptController.signal,
    dispose() {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        try {
          Deno.removeSignalListener(signal, abort);
        } catch {
          // The listener may already be removed after an interrupt.
        }
      }
      try {
        Deno.removeSignalListener("SIGHUP", detach);
      } catch {
        // The listener may already be removed after a hangup.
      }
    },
  };
}
