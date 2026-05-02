import { dirname, join } from "@std/path";
import type {
  ProjectComposeHealthStatus,
  ProjectComposeServiceStatus,
} from "../cli/runtime/compose_events.ts";

const DAEMON_SOCKET_ENV = "PM3_DAEMON_SOCKET";
const XDG_RUNTIME_DIR_ENV = "XDG_RUNTIME_DIR";

export type DaemonLifecycleOperation = "restart" | "start" | "stop";

export type DaemonLifecycleHealth = {
  service: string;
  status: ProjectComposeHealthStatus;
};

export type DaemonLifecycleState = {
  service: string;
  status: ProjectComposeServiceStatus;
};

export type DaemonMessage =
  | {
    type: "lifecycle.begin";
    projectId: number;
    project: string;
    operation: DaemonLifecycleOperation;
  }
  | {
    type: "lifecycle.end";
    projectId: number;
    project: string;
    operation: DaemonLifecycleOperation;
    health: DaemonLifecycleHealth[];
    state: DaemonLifecycleState[];
  }
  | {
    type: "lifecycle.abort";
    projectId: number;
    project: string;
    operation: DaemonLifecycleOperation;
  };

export async function startDaemonIpcServer(
  onMessage: (message: DaemonMessage) => void,
): Promise<{ stop(): Promise<void> }> {
  const socketPath = resolveDaemonSocketPath();
  await Deno.mkdir(dirname(socketPath), { recursive: true });
  await removeStaleSocket(socketPath);

  const listener = Deno.listen({ path: socketPath, transport: "unix" });
  void acceptDaemonMessages(listener, onMessage);

  return {
    async stop() {
      listener.close();
      await removeExistingSocket(socketPath);
    },
  };
}

export async function notifyDaemon(message: DaemonMessage): Promise<void> {
  let connection: Deno.Conn | undefined;
  try {
    connection = await Deno.connect({
      path: resolveDaemonSocketPath(),
      transport: "unix",
    });
    await connection.write(
      new TextEncoder().encode(`${JSON.stringify(message)}\n`),
    );
  } catch {
    // Lifecycle commands still work when the daemon is not running.
  } finally {
    connection?.close();
  }
}

function resolveDaemonSocketPath(): string {
  return (
    Deno.env.get(DAEMON_SOCKET_ENV) ??
      join(Deno.env.get(XDG_RUNTIME_DIR_ENV) ?? "/tmp", "pm3", "daemon.sock")
  );
}

async function acceptDaemonMessages(
  listener: Deno.Listener,
  onMessage: (message: DaemonMessage) => void,
): Promise<void> {
  try {
    for await (const connection of listener) {
      void readDaemonMessages(connection, onMessage);
    }
  } catch {
    // Closing the listener stops the accept loop.
  }
}

async function readDaemonMessages(
  connection: Deno.Conn,
  onMessage: (message: DaemonMessage) => void,
): Promise<void> {
  const buffer = new Uint8Array(4096);
  const decoder = new TextDecoder();
  let text = "";

  try {
    while (true) {
      const read = await connection.read(buffer);
      if (read === null) {
        break;
      }

      text += decoder.decode(buffer.subarray(0, read), { stream: true });
      const lines = text.split(/\r?\n/);
      text = lines.pop() ?? "";
      for (const line of lines) {
        const message = parseDaemonMessage(line);
        if (message) {
          onMessage(message);
        }
      }
    }

    const remaining = `${text}${decoder.decode()}`.trim();
    if (remaining) {
      const message = parseDaemonMessage(remaining);
      if (message) {
        onMessage(message);
      }
    }
  } finally {
    connection.close();
  }
}

function parseDaemonMessage(line: string): DaemonMessage | undefined {
  try {
    const message = JSON.parse(line) as unknown;
    if (!isDaemonMessage(message)) {
      return undefined;
    }

    return message;
  } catch {
    return undefined;
  }
}

function isDaemonMessage(message: unknown): message is DaemonMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<DaemonMessage>;
  return (
    (candidate.type === "lifecycle.begin" ||
      candidate.type === "lifecycle.end" ||
      candidate.type === "lifecycle.abort") &&
    typeof candidate.projectId === "number" &&
    typeof candidate.project === "string" &&
    isDaemonLifecycleOperation(candidate.operation)
  );
}

function isDaemonLifecycleOperation(
  value: unknown,
): value is DaemonLifecycleOperation {
  return value === "restart" || value === "start" || value === "stop";
}

async function removeExistingSocket(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const connection = await Deno.connect({ path, transport: "unix" });
    connection.close();
    throw new Error(`PM3 daemon socket is already in use: ${path}`);
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.ConnectionRefused
    ) {
      await removeExistingSocket(path);
      return;
    }

    throw error;
  }
}
