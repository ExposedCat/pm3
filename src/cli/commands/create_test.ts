import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { runCli, withTempCli } from "../test_utils.ts";
import "../../database/database.ts";

Deno.test({
  name: "create creates a project with an explicit name",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "service");
      await Deno.mkdir(workdir);

      const output = await runCli(
        ["create", workdir, "--name", "api"],
        databasePath,
      );

      assertEquals(
        output,
        ["name: api", "id: 1", `workdir: ${resolve(workdir)}`].join("\n"),
      );
    });
  },
});

Deno.test({
  name: "create names a project after the workdir by default",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const workdir = join(root, "worker");
      await Deno.mkdir(workdir);

      const output = await runCli(["create", workdir], databasePath);

      assertEquals(
        output,
        ["name: worker", "id: 1", `workdir: ${resolve(workdir)}`].join("\n"),
      );
    });
  },
});
