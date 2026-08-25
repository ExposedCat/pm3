const tsFiles = await collectTsFiles("src");

await run("deno", ["check", ...tsFiles]);
await run("deno", ["fmt", "--check", "src/"]);
await run("deno", ["lint", "src/"]);

async function collectTsFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...(await collectTsFiles(path)));
      continue;
    }

    if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files.sort();
}

async function run(command: string, args: string[]): Promise<void> {
  const result = await new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;

  if (!result.success) {
    Deno.exit(result.code);
  }
}
