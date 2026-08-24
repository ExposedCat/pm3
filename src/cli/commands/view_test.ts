import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { closeDatabase, createDatabase } from "../../database/database.ts";
import { addProject } from "../../database/projects.ts";
import { parseArgs, runCommand } from "../commands.ts";

Deno.test("show is no longer a command", () => {
  assertThrows(
    () => parseArgs(["show", "api"]),
    Error,
    "Unknown command: show",
  );
});

Deno.test("view renders project and service details", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;

  try {
    const db = await createDatabase(databasePath);
    try {
      await addProject(db, {
        composeArgs: ["-f", "compose.prod.yaml", "--profile", "production"],
        name: "api",
        workingDir: "/project",
      });
    } finally {
      await closeDatabase(db);
    }

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      output.push(values.join(" "));
    };

    try {
      await runCommand(parseArgs(["view", "api"]), {
        databasePath,
        runProcess: (command) => {
          if (command.args.includes("ps")) {
            return Promise.resolve({
              code: 0,
              stdout: JSON.stringify([
                {
                  Created: 1,
                  Labels: { "io.podman.compose.service": "web" },
                  Ports: [
                    {
                      container_port: 80,
                      host_ip: "127.0.0.1",
                      host_port: 8080,
                      protocol: "tcp",
                    },
                  ],
                  StartedAt: 1,
                  State: "running",
                  Status: "Up",
                },
              ]),
            });
          }

          return Promise.resolve({ code: 0, stdout: "web\nworker" });
        },
      });
    } finally {
      console.log = originalLog;
    }

    assertEquals(output.length, 1);
    assertStringIncludes(output[0], "api");
    assertStringIncludes(output[0], "Workdir");
    assertStringIncludes(output[0], "/project");
    assertStringIncludes(output[0], "Creation args");
    assertStringIncludes(
      output[0],
      "-f compose.prod.yaml --profile production",
    );
    assertStringIncludes(output[0], "web -");
    assertStringIncludes(output[0], "up");
    assertStringIncludes(output[0], "127.0.0.1:8080->80/tcp");
    assertStringIncludes(output[0], "worker -");
    assertStringIncludes(output[0], "down");
    assertStringIncludes(output[0], "Published ports");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("view renders known details and errors for an invalid project", async () => {
  const directory = await Deno.makeTempDir();
  const databasePath = `${directory}/pm3.sqlite`;

  try {
    const db = await createDatabase(databasePath);
    try {
      await addProject(db, {
        composeArgs: ["-f", "broken.yaml"],
        name: "safe",
        workingDir: "/project",
      });
    } finally {
      await closeDatabase(db);
    }

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));

    try {
      await runCommand(parseArgs(["view", "safe"]), {
        databasePath,
        runProcess: (command) =>
          Promise.resolve(
            command.args.includes("ps")
              ? { code: 1, stderr: "could not parse broken.yaml" }
              : {
                  code: 1,
                  stderr: "services.web.image must be a string",
                },
          ),
      });
    } finally {
      console.log = originalLog;
    }

    assertEquals(output.length, 1);
    assertStringIncludes(output[0], "safe");
    assertStringIncludes(output[0], "invalid");
    assertStringIncludes(output[0], "/project");
    assertStringIncludes(output[0], "-f broken.yaml");
    assertStringIncludes(output[0], "Errors:");
    assertStringIncludes(output[0], "Failed to inspect containers");
    assertStringIncludes(output[0], "could not parse broken.yaml");
    assertStringIncludes(output[0], "Failed to list compose services");
    assertStringIncludes(output[0], "services.web.image must be a string");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
