export function formatTable(rows: readonly (readonly string[])[]): string {
  const widths = getColumnWidths(rows);

  return rows
    .map((row) =>
      row
        .map((value, index) => value.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
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
