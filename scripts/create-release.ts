const version = requireEnv("VERSION");
const assets = await listReleaseAssets("dist/release");

await run("gh", [
  "release",
  "create",
  `v${version}`,
  ...assets,
  "--title",
  `pm3 v${version}`,
  "--notes",
  `Release generated from deno.json version ${version}.`,
]);

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

async function listReleaseAssets(dir: string): Promise<string[]> {
  const assets: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile) {
      assets.push(`${dir}/${entry.name}`);
    }
  }

  return assets.sort();
}

async function run(command: string, args: string[]): Promise<void> {
  const status = await new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;

  if (!status.success) {
    Deno.exit(status.code);
  }
}
