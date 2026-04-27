export function formatTable(rows: readonly (readonly string[])[]): string {
  const widths = getColumnWidths(rows);

  return rows
    .map((row) =>
      row
        .map((value, index) => value.padEnd(widths[index] ?? 0))
        .map((value, index) => colorStateCell(value, rows[0]?.[index]))
        .join("  ")
        .trimEnd()
    )
    .join("\n");
}

function getColumnWidths(rows: readonly (readonly string[])[]): number[] {
  const widths: number[] = [];

  for (const row of rows) {
    row.forEach((value, index) => {
      widths[index] = Math.max(widths[index] ?? 0, value.length);
    });
  }

  return widths;
}

function colorStateCell(value: string, header: string | undefined): string {
  if (header !== "STATE") {
    return value;
  }

  const match = value.match(/^(.+?)(\s*)$/);
  const content = match?.[1] ?? value;
  const padding = match?.[2] ?? "";
  const state = content.match(/^(down|pending|up)(?:\s|$)/)?.[1];

  if (state === "down") {
    return `${red(content)}${padding}`;
  }

  if (state === "pending") {
    return `${yellow(content)}${padding}`;
  }

  if (state === "up") {
    return `${green(content)}${padding}`;
  }

  return value;
}

function red(value: string): string {
  return `\x1b[31m${value}\x1b[0m`;
}

function yellow(value: string): string {
  return `\x1b[33m${value}\x1b[0m`;
}

function green(value: string): string {
  return `\x1b[32m${value}\x1b[0m`;
}
