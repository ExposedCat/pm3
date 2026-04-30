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
    await signals.dispose();
  }
}

if (import.meta.main) {
  Deno.exit(await runCliMain(Deno.args));
}

type CliSignals = {
  detachSignal: AbortSignal;
  dispose(): Promise<void>;
  signal: AbortSignal;
};

function createCliSignals(): CliSignals {
  const interruptController = new AbortController();
  const detachController = new AbortController();
  const disposeController = new AbortController();
  const abort = () => interruptController.abort();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, abort);
    interruptController.signal.addEventListener(
      "abort",
      () => Deno.removeSignalListener(signal, abort),
      { once: true },
    );
  }

  const stdinClosed = watchStdinClosed(
    detachController,
    disposeController.signal,
  );

  return {
    detachSignal: detachController.signal,
    signal: interruptController.signal,
    async dispose() {
      disposeController.abort();
      await stdinClosed;
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        try {
          Deno.removeSignalListener(signal, abort);
        } catch {
          // The listener may already be removed after an interrupt.
        }
      }
    },
  };
}

async function watchStdinClosed(
  detachController: AbortController,
  disposeSignal: AbortSignal,
): Promise<void> {
  if (!Deno.stdin.isTerminal()) {
    return;
  }

  const reader = Deno.stdin.readable.getReader();
  try {
    while (!disposeSignal.aborted) {
      const result = await readStdin(reader, disposeSignal);
      if (!result) {
        return;
      }

      if (result.done) {
        detachController.abort();
        return;
      }
    }
  } catch {
    // Stdin can disappear when the parent terminal closes.
    detachController.abort();
  } finally {
    reader.releaseLock();
  }
}

function readStdin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  disposeSignal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array> | undefined> {
  if (disposeSignal.aborted) {
    return Promise.resolve(undefined);
  }

  return Promise.race([
    reader.read(),
    new Promise<undefined>((resolve) => {
      disposeSignal.addEventListener(
        "abort",
        () => {
          void reader.cancel().finally(() => resolve(undefined));
        },
        { once: true },
      );
    }),
  ]);
}
