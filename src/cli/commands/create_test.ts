import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { parseArgs, runCommand } from "../commands.ts";

Deno.test("create parses podman-compose arguments after the separator", () => {
  const parsed = parseArgs([
    "create",
    "./app",
    "--name",
    "api",
    "--",
    "-f",
    "compose.prod.yaml",
    "--profile",
    "production",
  ]);

  if (parsed.command.kind !== "create") {
    throw new Error("Expected create command");
  }

  assertEquals(parsed.command.composeArgs, [
    "-f",
    "compose.prod.yaml",
    "--profile",
    "production",
  ]);
});

Deno.test("create preserves global-looking compose arguments", () => {
  const parsed = parseArgs([
    "--verbose",
    "create",
    "./app",
    "--",
    "--verbose",
    "-v",
  ]);

  if (parsed.command.kind !== "create") {
    throw new Error("Expected create command");
  }

  assertEquals(parsed.verbose, true);
  assertEquals(parsed.command.composeArgs, ["--verbose", "-v"]);
});

Deno.test("create no longer accepts --compose", () => {
  assertThrows(
    () => parseArgs(["create", "./app", "--compose", "compose.yaml"]),
    Error,
    "Unknown option for create: --compose",
  );
});

Deno.test("create reports a friendly duplicate-name error", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;

  try {
    await runCommand(parseArgs(["create", "/first", "--name", "api"]), {
      databasePath,
    });

    await assertRejects(
      () =>
        runCommand(parseArgs(["create", "/second", "--name", "api"]), {
          databasePath,
        }),
      Error,
      "Project api already exists",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
