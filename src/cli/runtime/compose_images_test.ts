import { assertEquals, assertRejects } from "@std/assert";
import { pullMissingComposeImages } from "./compose_images.ts";
import type { ProcessCommand } from "./process.ts";

Deno.test("missing short compose images use an interactive podman pull", async () => {
  const calls: ProcessCommand[] = [];
  await pullMissingComposeImages(
    {
      composeArgs: ["-f", "compose.yaml"],
      name: "api",
      workingDir: "/project",
    },
    {},
    (command) => {
      calls.push(command);
      if (command.command === "podman-compose") {
        return Promise.resolve({
          code: 0,
          stdout: `
services:
  api:
    image: denoland/deno:2
  worker:
    image: denoland/deno:2
`,
        });
      }
      if (command.args[0] === "image") {
        return Promise.resolve({ code: 1 });
      }
      return Promise.resolve({ code: 0 });
    },
  );

  assertEquals(calls, [
    {
      command: "podman-compose",
      args: ["-f", "compose.yaml", "config"],
      cwd: "/project",
      captureOutput: true,
    },
    {
      command: "podman",
      args: ["image", "exists", "denoland/deno:2"],
      cwd: "/project",
      captureOutput: true,
    },
    {
      command: "podman",
      args: ["pull", "denoland/deno:2"],
      cwd: "/project",
      interactive: true,
      signal: undefined,
      verbose: true,
    },
  ]);
});

Deno.test("compose image preparation leaves resolved images untouched", async () => {
  const calls: ProcessCommand[] = [];
  await pullMissingComposeImages(
    {
      composeArgs: ["-f", "compose.yaml"],
      name: "api",
      workingDir: "/project",
    },
    {},
    (command) => {
      calls.push(command);
      if (command.command === "podman-compose") {
        return Promise.resolve({
          code: 0,
          stdout: `
services:
  qualified:
    image: docker.io/library/node:22
  port:
    image: registry.example:5000/team/api:latest
  local:
    image: node:22
  built:
    image: local-api
    build: .
  never:
    image: unavailable
    pull_policy: never
`,
        });
      }
      return Promise.resolve({ code: 0 });
    },
  );

  assertEquals(calls, [
    {
      command: "podman-compose",
      args: ["-f", "compose.yaml", "config"],
      cwd: "/project",
      captureOutput: true,
    },
    {
      command: "podman",
      args: ["image", "exists", "node:22"],
      cwd: "/project",
      captureOutput: true,
    },
  ]);
});

Deno.test("compose image pull failures identify the image", async () => {
  await assertRejects(
    () =>
      pullMissingComposeImages(
        {
          composeArgs: ["-f", "compose.yaml"],
          name: "api",
          workingDir: "/project",
        },
        {},
        (command) => {
          if (command.command === "podman-compose") {
            return Promise.resolve({
              code: 0,
              stdout: "services:\n  api:\n    image: example:latest\n",
            });
          }
          if (command.args[0] === "image") {
            return Promise.resolve({ code: 1 });
          }
          return Promise.resolve({
            code: 125,
            stderr:
              "short-name resolution enforced but cannot prompt without a TTY",
          });
        },
      ),
    Error,
    "Failed to pull compose image example:latest: short-name resolution enforced but cannot prompt without a TTY",
  );
});
