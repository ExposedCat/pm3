import type {
  LineStream,
  LineStreamCommand,
  ProcessCommand,
  ProcessResult,
} from "../command.ts";

export async function runSystemProcess(
  command: ProcessCommand,
): Promise<ProcessResult> {
  const process = new Deno.Command(command.command, {
    args: [...command.args],
    cwd: command.cwd,
    stdin: "inherit",
    stdout: "piped",
    stderr: "piped",
  });

  const child = process.spawn();
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    collectOutput(
      child.stdout,
      command.onOutput
        ? (text) => command.onOutput?.({ stream: "stdout", text })
        : undefined,
      command.verbose && !command.captureOutput ? Deno.stdout : undefined,
    ),
    collectOutput(
      child.stderr,
      command.onOutput
        ? (text) => command.onOutput?.({ stream: "stderr", text })
        : undefined,
      command.verbose && !command.captureOutput ? Deno.stderr : undefined,
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
): Promise<string> {
  const streamDecoder = new TextDecoder();
  const chunks: Uint8Array[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
    onOutput?.(streamDecoder.decode(chunk, { stream: true }));
    await writer?.write(chunk);
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

export async function runSystemLineStream(
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

  return {
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
  };
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
