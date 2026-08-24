import { assertEquals } from "@std/assert";
import { createPodmanComposeArgs } from "./compose_files.ts";

Deno.test("podman-compose arguments are applied before the subcommand", () => {
  assertEquals(
    createPodmanComposeArgs(
      {
        composeArgs: ["-f", "compose.prod.yaml", "--profile", "production"],
        workingDir: "/project",
      },
      ["up", "-d"],
    ),
    ["-f", "compose.prod.yaml", "--profile", "production", "up", "-d"],
  );
});
