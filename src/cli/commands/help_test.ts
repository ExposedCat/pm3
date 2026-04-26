import { assertEquals, assertThrows } from "@std/assert";
import { commandDefinitions, parseArgs } from "../commands.ts";
import { formatHelpText } from "../help.ts";
import { runCli } from "../test_utils.ts";

Deno.test("help prints usage", async () => {
  const expected = formatHelpText(commandDefinitions).trimEnd();

  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const output = await runCli(args);

    assertEquals(output, expected);
  }
});

Deno.test("help rejects extra arguments", () => {
  for (
    const args of [
      ["help", "extra"],
      ["--help", "extra"],
      ["-h", "extra"],
    ]
  ) {
    assertThrows(
      () => parseArgs(args),
      Error,
      "Unexpected argument for help: extra",
    );
  }
});

Deno.test("help text is generated from command metadata", () => {
  const output = formatHelpText(commandDefinitions);

  assertEquals(output.includes("\nCommands:\n"), false);

  for (const command of commandDefinitions) {
    const usage = [
      command.names[0],
      ...command.args,
      ...(command.options ?? []),
    ].join(" ");

    assertEquals(output.includes(`  pm3 ${usage}`), true);
    assertEquals(output.includes(command.description), true);
  }
});
