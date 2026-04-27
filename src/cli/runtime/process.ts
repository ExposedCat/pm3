const PROCESS_OUTPUT_TAIL_LIMIT = 64 * 1024;

export type ProcessCommand = {
  command: string;
  args: readonly string[];
  cwd: string;
  captureOutput?: boolean;
  detached?: boolean;
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

export async function runSystemProcess(
  command: ProcessCommand,
): Promise<ProcessResult> {
  const process = new Deno.Command(command.command, {
    args: [...command.args],
    cwd: command.cwd,
    stdin: command.detached ? "null" : "inherit",
    stdout: command.detached ? "null" : "piped",
    stderr: command.detached ? "null" : "piped",
  });

  const child = process.spawn();
  if (command.detached) {
    child.unref();
    return { code: 0 };
  }

  const [status, stdout, stderr] = await Promise.all([
    child.status,
    collectOutput(
      child.stdout,
      command.onOutput
        ? (text) => command.onOutput?.({ stream: "stdout", text })
        : undefined,
      command.verbose && !command.captureOutput ? Deno.stdout : undefined,
      command.captureOutput ? undefined : PROCESS_OUTPUT_TAIL_LIMIT,
    ),
    collectOutput(
      child.stderr,
      command.onOutput
        ? (text) => command.onOutput?.({ stream: "stderr", text })
        : undefined,
      command.verbose && !command.captureOutput ? Deno.stderr : undefined,
      command.captureOutput ? undefined : PROCESS_OUTPUT_TAIL_LIMIT,
    ),
  ]);

  return {
    code: status.code,
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
  };
}

async function collectOutput(
  stream: ReadableStream<Uint8Array>,
  onOutput?: (text: string) => void,
  writer?: Pick<typeof Deno.stdout, "write">,
  tailLimit?: number,
): Promise<string> {
  const streamDecoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let output = "";

  for await (const chunk of stream) {
    const text = streamDecoder.decode(chunk, { stream: true });
    onOutput?.(text);
    if (tailLimit === undefined) {
      chunks.push(chunk);
    } else {
      output = `${output}${text}`.slice(-tailLimit);
    }
    await writer?.write(chunk);
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
