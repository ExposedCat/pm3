const version = await readCurrentVersion();
const pending = version.length > 0 && !await releaseExists(version);

await writeGitHubOutput({
  changed: String(pending),
  ...(pending ? { version } : {}),
});

type DenoConfig = {
  version?: string;
};

async function readCurrentVersion(): Promise<string> {
  const config = JSON.parse(await Deno.readTextFile("deno.json")) as DenoConfig;

  return config.version ?? "";
}

async function releaseExists(version: string): Promise<boolean> {
  const status = await new Deno.Command("gh", {
    args: ["release", "view", `v${version}`],
    stdout: "null",
    stderr: "null",
  }).spawn().status;

  return status.success;
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
