import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { runCli, withTempCli } from "../test_utils.ts";
import "../../database/database.ts";

Deno.test({
  name: "view prints the project by name",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiDir = join(root, "api");
      const workerDir = join(root, "worker");
      await Deno.mkdir(apiDir);
      await Deno.mkdir(workerDir);
      await runCli(["create", apiDir, "--name", "api"], databasePath);
      await runCli(["create", workerDir, "--name", "worker"], databasePath);

      const output = await runCli(["view", "worker"], databasePath);

      assertEquals(
        output,
        ["name: worker", "id: 2", `workdir: ${resolve(workerDir)}`].join("\n"),
      );
    });
  },
});
