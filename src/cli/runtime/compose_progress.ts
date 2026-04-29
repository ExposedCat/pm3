import type { RunCommandOptions } from "../commands.ts";
import { yellow } from "../output/color.ts";
import {
  getComposeEventService,
  type PodmanEvent,
  parsePodmanEvent,
} from "./compose_events.ts";
import { listComposeServices, PODMAN_COMMAND } from "./compose_files.ts";

const EVENT_STREAM_STOP_GRACE_MS = 150;

type ComposeProject = {
  name: string;
  workingDir: string;
};

export function getComposeOperation(args: readonly string[]): string {
  if (args.includes("build")) {
    return "Building";
  }

  if (args.includes("down")) {
    return "Removing";
  }

  if (args.includes("stop")) {
    return "Stopping";
  }

  if (args.includes("restart")) {
    return "Restarting";
  }

  return "Starting";
}

type ComposeOperation = ReturnType<typeof getComposeOperation>;

export type ComposeProgress = {
  captureComposeCommands: boolean;
  shownNoticeCount(): number;
  stop(): Promise<void>;
  writeComposeOutput(text: string): void;
};

export function createEmptyComposeProgress(): ComposeProgress {
  return {
    captureComposeCommands: false,
    shownNoticeCount: () => 0,
    stop: () => Promise.resolve(),
    writeComposeOutput: () => {},
  };
}

export async function startComposeProgress(
  project: ComposeProject,
  operation: ComposeOperation,
  options: RunCommandOptions,
  output: ComposeOutput,
): Promise<ComposeProgress> {
  if (
    operation === "Building" ||
    (options.runProcess && !options.runLineStream)
  ) {
    return createEmptyComposeProgress();
  }

  const { runSystemProcess } = await import("./process.ts");
  const runProcess = options.runProcess ?? runSystemProcess;
  const services = await listComposeServices(project, runProcess);
  if (services.length === 0) {
    return createEmptyComposeProgress();
  }

  const finished = new Set<string>();
  const started = new Set<string>();
  const serviceNames = new Set(services);
  for (const service of services) {
    startComposeServiceProgress(
      project.name,
      operation,
      started,
      service,
      output,
    );
  }

  const { runSystemLineStream } = await import("./process.ts");
  const runLineStream = options.runLineStream ?? runSystemLineStream;
  const stream = await runLineStream(
    {
      command: PODMAN_COMMAND,
      args: [
        "events",
        "--format",
        "json",
        "--filter",
        "type=container",
        "--filter",
        `label=com.docker.compose.project.working_dir=${project.workingDir}`,
        "--since",
        new Date().toISOString(),
      ],
    },
    (line) => {
      const event = parsePodmanEvent(line);
      if (!isComposeServiceEventComplete(operation, event)) {
        return;
      }

      const service = getComposeEventService(event);
      if (!service || !serviceNames.has(service) || finished.has(service)) {
        return;
      }

      finishComposeProgress(
        project.name,
        operation,
        finished,
        started,
        service,
        output,
      );
    },
  );
  let composeOutput = "";
  let shownNoticeCount = 0;
  let lastCommandService = "";

  return {
    captureComposeCommands: !options.verbose,
    shownNoticeCount: () => shownNoticeCount,
    async stop() {
      await delay(EVENT_STREAM_STOP_GRACE_MS);
      await stream.stop();
    },
    writeComposeOutput(text: string) {
      if (options.verbose) {
        return;
      }

      composeOutput += text;
      const lines = composeOutput.split(/\r?\n/);
      composeOutput = lines.pop() ?? "";

      for (const line of lines) {
        const service = getComposeCommandService(operation, services, line);
        if (service) {
          lastCommandService = service;
          startComposeServiceProgress(
            project.name,
            operation,
            started,
            service,
            output,
          );
        }

        const noticeService =
          getComposeNoticeService(services, line) || lastCommandService;
        if (noticeService && isComposeNoticeLine(line)) {
          const parentLine = formatComposeProgressLine(
            project.name,
            finished.has(noticeService)
              ? getFinishedComposeOperation(operation)
              : operation,
            noticeService,
          );
          startComposeServiceProgress(
            project.name,
            operation,
            started,
            noticeService,
            output,
          );
          output.writeLineAfter(parentLine, formatComposeNoticeLine(line));
          shownNoticeCount += 1;
        }
      }
    },
  };
}

function isComposeServiceEventComplete(
  operation: ComposeOperation,
  event: PodmanEvent | undefined,
): boolean {
  const status = event?.Status;

  if (operation === "Removing") {
    return status === "remove";
  }

  if (operation === "Stopping") {
    return status === "stop" || status === "died";
  }

  return status === "start";
}

function getComposeCommandService(
  operation: ComposeOperation,
  services: readonly string[],
  line: string,
): string {
  const normalized = line.trim();
  const commands = getPodmanCommandsForOperation(operation);

  if (!commands.some((command) => normalized.includes(`podman ${command} `))) {
    return "";
  }

  return findServiceInComposeLine(services, normalized);
}

function getPodmanCommandsForOperation(
  operation: ComposeOperation,
): readonly string[] {
  if (operation === "Starting" || operation === "Restarting") {
    return ["start"];
  }

  if (operation === "Stopping") {
    return ["stop"];
  }

  if (operation === "Removing") {
    return ["stop", "rm"];
  }

  return [];
}

function startComposeServiceProgress(
  projectName: string,
  operation: ComposeOperation,
  started: Set<string>,
  service: string,
  output: ComposeOutput,
): void {
  if (started.has(service)) {
    return;
  }

  started.add(service);
  output.startLine(formatComposeProgressLine(projectName, operation, service));
}

function finishComposeProgress(
  projectName: string,
  operation: ComposeOperation,
  finished: Set<string>,
  started: Set<string>,
  service: string,
  output: ComposeOutput,
): void {
  if (finished.has(service)) {
    return;
  }

  const line = formatComposeProgressLine(projectName, operation, service);
  const finishedLine = formatComposeProgressLine(
    projectName,
    getFinishedComposeOperation(operation),
    service,
  );
  if (!started.has(service)) {
    started.add(service);
    output.startLine(line);
  }

  finished.add(service);
  output.finishLine(line, finishedLine);
}

function formatComposeProgressLine(
  projectName: string,
  operation: string,
  service: string,
): string {
  return `${operation} ${projectName}/${service}`;
}

function getFinishedComposeOperation(operation: ComposeOperation): string {
  if (operation === "Starting") {
    return "Started";
  }

  if (operation === "Stopping") {
    return "Stopped";
  }

  if (operation === "Restarting") {
    return "Restarted";
  }

  if (operation === "Removing") {
    return "Removed";
  }

  return operation;
}

function getComposeNoticeService(
  services: readonly string[],
  line: string,
): string {
  return findServiceInComposeLine(services, line);
}

function findServiceInComposeLine(
  services: readonly string[],
  line: string,
): string {
  return (
    [...services]
      .sort((left, right) => right.length - left.length)
      .find((service) => line.includes(`_${service}_`)) ?? ""
  );
}

function isComposeNoticeLine(line: string): boolean {
  return /\b(?:err(?:or)?|warn(?:ing)?)\b/i.test(line);
}

function formatComposeNoticeLine(line: string): string {
  return yellow(formatComposeNoticeText(line));
}

function formatComposeNoticeText(line: string): string {
  return parsePodmanLogMessage(line) ?? line.trim();
}

function parsePodmanLogMessage(line: string): string | undefined {
  if (!/\blevel=warn(?:ing)?\b/i.test(line)) {
    return undefined;
  }

  const match = /\bmsg="((?:\\.|[^"\\])*)"/.exec(line);
  return match ? unescapeLogfmtQuotedValue(match[1]) : undefined;
}

function unescapeLogfmtQuotedValue(value: string): string {
  return value.replace(/\\(["\\nrt])/g, (_match, escaped: string) => {
    if (escaped === "n") {
      return "\n";
    }

    if (escaped === "r") {
      return "\r";
    }

    if (escaped === "t") {
      return "\t";
    }

    return escaped;
  });
}

type ComposeOutput = {
  finishLine(line: string, finishedLine: string): void;
  startLine(line: string): void;
  writeLineAfter(parentLine: string, line: string): void;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
