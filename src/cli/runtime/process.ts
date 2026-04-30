const PROCESS_OUTPUT_TAIL_LIMIT = 64 * 1024;

export type ProcessCommand = {
  command: string;
  args: readonly string[];
  cwd: string;
  captureOutput?: boolean;
  detachSignal?: AbortSignal;
  detached?: boolean;
  onOutput?: (chunk: ProcessOutputChunk) => void;
  signal?: AbortSignal;
  verbose?: boolean;
};

export type ProcessOutputChunk = {
  stream: "stdout" | "stderr";
  text: string;
};

export type ProcessResult = {
  code: number;
  detached?: boolean;
  stdout?: string;
  stderr?: string;
};

export type RunProcess = (command: ProcessCommand) => Promise<ProcessResult>;

export async function runSystemProcess(
  command: ProcessCommand,
): Promise<ProcessResult> {
  const process = new Deno.Command(command.command, {
    args: [...command.args],
    cwd: command.cwd,
    stdin: "null",
    stdout: command.detached ? "null" : "piped",
    stderr: command.detached ? "null" : "piped",
  });

  const child = process.spawn();
  const abort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may have already exited.
    }
  };
  command.signal?.addEventListener("abort", abort, { once: true });
  if (command.detached) {
    child.unref();
    command.signal?.removeEventListener("abort", abort);
    return { code: 0 };
  }
  const detach = () => child.unref();
  command.detachSignal?.addEventListener("abort", detach, { once: true });

  const [status, stdout, stderr] = await Promise.all([
    child.status,
    collectOutput(
      child.stdout,
      command.onOutput
        ? (text) => command.onOutput?.({ stream: "stdout", text })
        : undefined,
      command.verbose && !command.captureOutput ? Deno.stdout : undefined,
      command.captureOutput ? undefined : PROCESS_OUTPUT_TAIL_LIMIT,
      command.detachSignal,
    ),
    collectOutput(
      child.stderr,
      command.onOutput
        ? (text) => command.onOutput?.({ stream: "stderr", text })
        : undefined,
      command.verbose && !command.captureOutput ? Deno.stderr : undefined,
      command.captureOutput ? undefined : PROCESS_OUTPUT_TAIL_LIMIT,
      command.detachSignal,
    ),
  ]).finally(() => {
    command.signal?.removeEventListener("abort", abort);
    command.detachSignal?.removeEventListener("abort", detach);
  });

  return {
    code: status.code,
    detached: command.detachSignal?.aborted || undefined,
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
  };
}

async function collectOutput(
  stream: ReadableStream<Uint8Array>,
  onOutput?: (text: string) => void,
  writer?: Pick<typeof Deno.stdout, "write">,
  tailLimit?: number,
  stopSignal?: AbortSignal,
): Promise<string> {
  const streamDecoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let output = "";
  const reader = stream.getReader();

  try {
    while (!stopSignal?.aborted) {
      const result = await readChunk(reader, stopSignal);
      if (!result || result.done) {
        break;
      }

      const text = streamDecoder.decode(result.value, { stream: true });
      onOutput?.(text);
      if (tailLimit === undefined) {
        chunks.push(result.value);
      } else {
        output = `${output}${text}`.slice(-tailLimit);
      }
      await writer?.write(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const remaining = streamDecoder.decode();
  if (remaining) {
    onOutput?.(remaining);
    output =
      tailLimit === undefined
        ? output
        : `${output}${remaining}`.slice(-tailLimit);
  }

  if (tailLimit !== undefined) {
    return output;
  }

  return new TextDecoder().decode(concatChunks(chunks));
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stopSignal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array> | undefined> {
  if (!stopSignal) {
    return reader.read();
  }

  if (stopSignal.aborted) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve, reject) => {
    const abort = () => {
      stopSignal.removeEventListener("abort", abort);
      void reader.cancel().finally(() => resolve(undefined));
    };

    stopSignal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (result) => {
        stopSignal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        stopSignal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

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

export function runSystemLineStream(
  command: LineStreamCommand,
  onLine: (line: string) => void,
): Promise<LineStream> {
  const process = new Deno.Command(command.command, {
    args: [...command.args],
    cwd: command.cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const child = process.spawn();
  let exited = false;
  const status = child.status.finally(() => {
    exited = true;
  });
  const stdout = readLines(child.stdout, onLine);
  const stderr = drainStream(child.stderr);

  return Promise.resolve({
    async stop() {
      if (!exited) {
        try {
          child.kill("SIGTERM");
        } catch {
          // The stream may have exited between checking and killing.
        }
      }

      const settled = Promise.allSettled([status, stdout, stderr]);
      const stopped = await settlesWithin(settled, 1_000);
      if (!stopped) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The stream already exited.
        }
        await Promise.race([settled, delay(1_000)]);
      }
    },
  });
}

async function settlesWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  return await Promise.race([promise.then(() => true), delay(milliseconds)]);
}

function delay(milliseconds: number): Promise<false> {
  return new Promise((resolve) =>
    setTimeout(() => resolve(false), milliseconds),
  );
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line) {
          onLine(line);
        }
      }
    }
  } catch {
    // Stopping the event stream can interrupt pending reads.
  }

  buffer += decoder.decode();
  if (buffer) {
    onLine(buffer);
  }
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    for await (const _chunk of stream) {
      // Drain stderr so the child cannot block on a full pipe.
    }
  } catch {
    // Stopping the event stream can interrupt pending reads.
  }
}
