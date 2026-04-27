const LOADER_FRAMES = ["-", "\\", "|", "/"] as const;

export type Loader = {
  finishLine(line: string, finishedLine: string): void;
  startLine(line: string): void;
  stop(): void;
  writeLineAfter(parentLine: string, line: string): void;
};

export function startLoader(
  label: string,
  options: { enabled: boolean },
): Loader {
  if (!options.enabled || !isTerminal(Deno.stdout)) {
    return {
      finishLine: (_line, finishedLine) => console.log(finishedLine),
      startLine: (line) => console.log(line),
      stop: () => {},
      writeLineAfter: (_parentLine, line) => console.log(`    ${line}`),
    };
  }

  let index = 0;
  let renderedRowCount = 0;
  const lines: { active: boolean; label: string }[] = [];
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
            line.active ? `${frame} ${line.label}...` : `  ${line.label}`,
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
    finishLine(lineLabel: string, finishedLabel = lineLabel) {
      const line = lines.find((entry) => entry.label === lineLabel);
      if (line) {
        line.active = false;
        line.label = finishedLabel;
        render();
      }
    },
    startLine(lineLabel: string) {
      if (!lines.some((line) => line.label === lineLabel)) {
        lines.push({ active: true, label: lineLabel });
        render();
      }
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
        line.active = false;
      }
      render();
    },
    writeLineAfter(parentLine: string, lineLabel: string) {
      if (lines.some((line) => line.label === lineLabel)) {
        return;
      }

      const parentIndex = lines.findIndex((line) => line.label === parentLine);
      const insertIndex = parentIndex === -1 ? lines.length : parentIndex + 1;
      lines.splice(insertIndex, 0, { active: false, label: `  ${lineLabel}` });
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
