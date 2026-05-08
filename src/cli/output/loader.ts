const LOADER_FRAMES = ["-", "\\", "|", "/"] as const;

export type LoaderLine = {
  id: string;
  text: string;
};

export type Loader = {
  finishLine(lineId: string, finishedText: string): void;
  startLine(line: LoaderLine): void;
  startLineAfter(parentLineId: string, line: LoaderLine): void;
  stop(): void;
  writeLine(line: LoaderLine): void;
  writeLineAfter(parentLineId: string, line: LoaderLine): void;
};

export function startLoader(
  label: string,
  options: { enabled: boolean },
): Loader {
  if (!options.enabled || !isTerminal(Deno.stdout)) {
    const childLines = new Set<string>();
    const activeLines = new Map<string, LoaderLine>();
    return {
      finishLine: (lineId, finishedText) => {
        activeLines.delete(lineId);
        console.log(`${childLines.has(lineId) ? "    " : ""}${finishedText}`);
      },
      startLine: (line) => {
        activeLines.set(line.id, line);
        console.log(line.text);
      },
      startLineAfter: (_parentLineId, line) => {
        childLines.add(line.id);
        activeLines.set(line.id, line);
        console.log(`    ${line.text}...`);
      },
      stop: () => {
        for (const line of activeLines.values()) {
          if (
            childLines.has(line.id) &&
            stripAnsi(line.text) === "Checking health"
          ) {
            console.log(
              `    ${line.text.replace("Checking health", "Healthcheck timeout")}`,
            );
          }
        }
        activeLines.clear();
      },
      writeLine: (line) => console.log(line.text),
      writeLineAfter: (_parentLineId, line) => console.log(`    ${line.text}`),
    };
  }

  let index = 0;
  let renderedRowCount = 0;
  const lines: { active: boolean; id: string; indent: string; text: string }[] =
    [];
  const encoder = new TextEncoder();
  const render = () => {
    const frame = LOADER_FRAMES[index % LOADER_FRAMES.length];
    const output: string[] = [];

    if (renderedRowCount > 0) {
      output.push(`\x1b[${renderedRowCount}A\r\x1b[J`);
    }

    const renderedLines =
      lines.length > 0
        ? lines.map((line) =>
            line.active
              ? `${frame} ${line.indent}${line.text}...`
              : `  ${line.indent}${line.text}`,
          )
        : [`${frame} ${label}...`];

    for (const line of renderedLines) {
      output.push(`\r\x1b[K${line}\n`);
    }

    Deno.stdout.writeSync(encoder.encode(output.join("")));
    renderedRowCount = countRenderedRows(renderedLines, getTerminalColumns());
  };
  const timer = setInterval(() => {
    if (lines.length > 0 && !lines.some((line) => line.active)) {
      return;
    }

    index += 1;
    render();
  }, 100);
  render();

  return {
    finishLine(lineId: string, finishedText: string) {
      const line = lines.find((entry) => entry.id === lineId);
      if (line) {
        line.active = false;
        line.text = finishedText;
        render();
      }
    },
    startLine(line: LoaderLine) {
      if (!lines.some((entry) => entry.id === line.id)) {
        lines.push({ active: true, id: line.id, indent: "", text: line.text });
        render();
      }
    },
    startLineAfter(parentLineId: string, line: LoaderLine) {
      if (lines.some((entry) => entry.id === line.id)) {
        return;
      }

      const parentIndex = lines.findIndex((entry) => entry.id === parentLineId);
      const insertIndex = parentIndex === -1 ? lines.length : parentIndex + 1;
      lines.splice(insertIndex, 0, {
        active: true,
        id: line.id,
        indent: "  ",
        text: line.text,
      });
      render();
    },
    stop() {
      clearInterval(timer);
      if (lines.length === 0) {
        Deno.stdout.writeSync(
          encoder.encode(`\x1b[${renderedRowCount}A\r\x1b[J`),
        );
        return;
      }

      for (const line of lines) {
        if (
          line.active &&
          line.indent === "  " &&
          stripAnsi(line.text) === "Checking health"
        ) {
          line.text = line.text.replace(
            "Checking health",
            "Healthcheck timeout",
          );
        }
        line.active = false;
      }
      render();
    },
    writeLine(line: LoaderLine) {
      if (lines.some((entry) => entry.id === line.id)) {
        return;
      }

      lines.push({
        active: false,
        id: line.id,
        indent: "",
        text: line.text,
      });
      render();
    },
    writeLineAfter(parentLineId: string, line: LoaderLine) {
      if (lines.some((entry) => entry.id === line.id)) {
        return;
      }

      const parentIndex = lines.findIndex((entry) => entry.id === parentLineId);
      const insertIndex = parentIndex === -1 ? lines.length : parentIndex + 1;
      lines.splice(insertIndex, 0, {
        active: false,
        id: line.id,
        indent: "  ",
        text: line.text,
      });
      render();
    },
  };
}

function getTerminalColumns(): number {
  try {
    return Math.max(1, Deno.consoleSize().columns);
  } catch {
    return 80;
  }
}

function countRenderedRows(lines: readonly string[], columns: number): number {
  return lines.reduce(
    (total, line) =>
      total +
      stripAnsi(line)
        .split(/\r?\n/)
        .reduce(
          (lineTotal, segment) =>
            lineTotal + Math.max(1, Math.ceil(segment.length / columns)),
          0,
        ),
    0,
  );
}

function stripAnsi(value: string): string {
  const escapeChar = String.fromCharCode(27);
  return value.replace(
    new RegExp(`${escapeChar}\\[[0-?]*[ -/]*[@-~]`, "g"),
    "",
  );
}

type TerminalWriter = {
  isTerminal?: () => boolean;
};

function isTerminal(writer: TerminalWriter): boolean {
  return writer.isTerminal?.() ?? false;
}
