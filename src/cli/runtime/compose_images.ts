import { parse as parseYaml } from "@std/yaml";
import type { RunCommandOptions } from "../commands.ts";
import { inputError } from "../errors.ts";
import { PODMAN_COMMAND, readComposeConfig } from "./compose_files.ts";
import type { ProcessResult, RunProcess } from "./process.ts";

type ComposeProject = {
  composeArgs?: readonly string[];
  name: string;
  workingDir: string;
};

export async function pullMissingComposeImages(
  project: ComposeProject,
  options: RunCommandOptions,
  runProcess: RunProcess,
): Promise<void> {
  const discovery = await readComposeConfig(project, runProcess);
  if (discovery.kind === "missing-compose-file") {
    return;
  }
  if (discovery.kind === "error") {
    throw inputError(
      `Failed to inspect compose images for ${project.name}: ${discovery.message}`,
    );
  }

  for (const image of parsePullableShortImages(discovery.text)) {
    if (await isLocalImage(project, image, runProcess)) {
      continue;
    }

    const result = await runProcess({
      command: PODMAN_COMMAND,
      args: ["pull", image],
      cwd: project.workingDir,
      interactive: true,
      signal: options.signal,
      verbose: true,
    });
    if (result.code !== 0) {
      throw inputError(formatImagePullFailure(image, result));
    }
  }
}

function parsePullableShortImages(configText: string): string[] {
  const config = getRecord(parseYaml(configText));
  const services = getRecord(config.services);
  const images = new Set<string>();

  for (const service of Object.values(services)) {
    const definition = getRecord(service);
    const image = definition.image;
    if (
      typeof image !== "string" ||
      !image ||
      (definition.build !== undefined && definition.build !== null) ||
      definition.pull_policy === "never" ||
      definition.pull_policy === "build" ||
      isQualifiedImage(image)
    ) {
      continue;
    }

    images.add(image);
  }

  return [...images];
}

function isQualifiedImage(image: string): boolean {
  const slashIndex = image.indexOf("/");
  if (slashIndex === -1) {
    return false;
  }

  const firstComponent = image.slice(0, slashIndex);
  return (
    firstComponent === "localhost" ||
    firstComponent.includes(".") ||
    firstComponent.includes(":")
  );
}

async function isLocalImage(
  project: ComposeProject,
  image: string,
  runProcess: RunProcess,
): Promise<boolean> {
  const result = await runProcess({
    command: PODMAN_COMMAND,
    args: ["image", "exists", image],
    cwd: project.workingDir,
    captureOutput: true,
  });
  return result.code === 0;
}

function formatImagePullFailure(image: string, result: ProcessResult): string {
  const detail = result.stderr?.trim() || result.stdout?.trim();
  return detail
    ? `Failed to pull compose image ${image}: ${detail}`
    : `Failed to pull compose image ${image} (podman exited with code ${result.code})`;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
