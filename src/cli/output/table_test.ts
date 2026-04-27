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
    [
      "NAME    STATE",
      "api     \x1b[32mup\x1b[0m",
      "worker  \x1b[31mdown\x1b[0m",
    ]
      .join("\n"),
  );
});

Deno.test("formatTable preserves empty cells", () => {
  assertEquals(
    formatTable([
      ["NAME", "STATE", "PORTS"],
      ["api", "down", ""],
    ]),
    ["NAME  STATE  PORTS", "api   \x1b[31mdown\x1b[0m"].join("\n"),
  );
});

Deno.test("formatTable colors pending states", () => {
  assertEquals(
    formatTable([
      ["NAME", "STATE"],
      ["api", "pending"],
    ]),
    ["NAME  STATE", "api   \x1b[33mpending\x1b[0m"].join("\n"),
  );
});
