const [beforeRef] = Deno.args;
const currentVersion = await readCurrentVersion();
const previousVersion = beforeRef ? await readPreviousVersion(beforeRef) : "";
const changed = currentVersion.length > 0 && currentVersion !== previousVersion;

await writeGitHubOutput({
  changed: String(changed),
  ...(changed ? { version: currentVersion } : {}),
});

type DenoConfig = {
  version?: string;
};

async function readCurrentVersion(): Promise<string> {
  const config = JSON.parse(
    await Deno.readTextFile("deno.json"),
  ) as DenoConfig;

  return config.version ?? "";
}

async function readPreviousVersion(ref: string): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["show", `${ref}:deno.json`],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!result.success) {
    return "";
  }

  const config = JSON.parse(
    new TextDecoder().decode(result.stdout),
  ) as DenoConfig;

  return config.version ?? "";
}

async function writeGitHubOutput(
  values: Record<string, string>,
): Promise<void> {
  const outputPath = Deno.env.get("GITHUB_OUTPUT");
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (!outputPath) {
    console.log(lines.join("\n"));
    return;
  }

  await Deno.writeTextFile(outputPath, `${lines.join("\n")}\n`, {
    append: true,
  });
}
