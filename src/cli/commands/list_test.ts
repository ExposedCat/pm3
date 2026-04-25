import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { runCli, withTempCli } from "../test_utils.ts";
import "../../database/database.ts";

Deno.test({
  name: "list prints projects ordered by name",
  sanitizeResources: false,
  async fn() {
    await withTempCli(async ({ databasePath, root }) => {
      const apiDir = join(root, "api");
      const workerDir = join(root, "worker");
      await Deno.mkdir(apiDir);
      await Deno.mkdir(workerDir);
      await runCli(["create", workerDir, "--name", "worker"], databasePath);
      await runCli(["create", apiDir, "--name", "api"], databasePath);

      const output = await runCli(["list"], databasePath);

      assertEquals(output, ["api\t2", "worker\t1"].join("\n"));
    });
  },
});
