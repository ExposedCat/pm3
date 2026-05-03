import { assertEquals } from "@std/assert";
import { formatTable } from "./table.ts";

Deno.test("formatTable prints headers without rows", () => {
  assertEquals(formatTable([["NAME", "STATE"]]), "NAME  STATE");
});

Deno.test("formatTable aligns rows by column width", () => {
  assertEquals(
    formatTable([
      ["NAME", "STATE"],
      ["api", "up"],
      ["worker", "down"],
    ]),
    ["NAME    STATE", "api     up", "worker  down"].join("\n"),
  );
});

Deno.test("formatTable preserves empty cells", () => {
  assertEquals(
    formatTable([
      ["NAME", "STATE", "PORTS"],
      ["api", "down", ""],
    ]),
    ["NAME  STATE  PORTS", "api   down"].join("\n"),
  );
});

Deno.test("formatTable applies custom cell formatting", () => {
  assertEquals(
    formatTable(
      [
        ["NAME", "STATE"],
        ["api", "starting"],
      ],
      {
        formatCell: (cell) =>
          cell.header === "STATE" ? `[${cell.value.trimEnd()}]` : cell.value,
      },
    ),
    ["NAME  [STATE]", "api   [starting]"].join("\n"),
  );
});
