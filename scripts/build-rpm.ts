import { join } from "@std/path";

const version = requireEnv("VERSION");
const runnerTemp = requireEnv("RUNNER_TEMP");
const rpmRoot = join(runnerTemp, "rpmbuild");
const sourceRoot = join(runnerTemp, "source");
const packageRoot = join(sourceRoot, `pm3-${version}`);

await Deno.mkdir(join(rpmRoot, "BUILD"), { recursive: true });
await Deno.mkdir(join(rpmRoot, "RPMS"), { recursive: true });
await Deno.mkdir(join(rpmRoot, "SOURCES"), { recursive: true });
await Deno.mkdir(join(rpmRoot, "SPECS"), { recursive: true });
await Deno.mkdir(join(rpmRoot, "SRPMS"), { recursive: true });
await Deno.mkdir(packageRoot, { recursive: true });

await run("tar", [
  "--exclude-vcs",
  "--exclude=./dist",
  "--exclude=./.github",
  "-cf",
  "-",
  ".",
], { stdout: "piped" }).then(async (tar) => {
  const extract = new Deno.Command("tar", {
    args: ["-xf", "-", "-C", packageRoot],
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  await tar.stdout.pipeTo(extract.stdin);
  const status = await extract.status;
  if (!status.success) {
    Deno.exit(status.code);
  }
});

await run("tar", [
  "-czf",
  join(rpmRoot, "SOURCES", `pm3-${version}.tar.gz`),
  "-C",
  sourceRoot,
  `pm3-${version}`,
]);

const spec = await Deno.readTextFile("packaging/rpm/pm3.spec");
await Deno.writeTextFile(
  join(rpmRoot, "SPECS", "pm3.spec"),
  spec.replace(/^Version:\s+.*/m, `Version:        ${version}`),
);

await run("rpmbuild", [
  "--define",
  `_topdir ${rpmRoot}`,
  "--define",
  "systemd_post() %{nil}",
  "--define",
  "systemd_preun() %{nil}",
  "--define",
  "systemd_postun_with_restart() %{nil}",
  "--nodeps",
  "-bb",
  join(rpmRoot, "SPECS", "pm3.spec"),
]);

await Deno.mkdir("dist/release", { recursive: true });
await copyBuiltRpms(join(rpmRoot, "RPMS"), version);

async function copyBuiltRpms(root: string, version: string): Promise<void> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) {
      await copyBuiltRpms(path, version);
      continue;
    }

    if (entry.isFile && entry.name.startsWith(`pm3-${version}-`)) {
      await Deno.copyFile(path, join("dist/release", entry.name));
    }
  }
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

type RunOptions = {
  stdout?: "inherit" | "piped";
};

async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<Deno.ChildProcess> {
  const child = new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: options.stdout ?? "inherit",
    stderr: "inherit",
  }).spawn();

  if (options.stdout === "piped") {
    return child;
  }

  const status = await child.status;
  if (!status.success) {
    Deno.exit(status.code);
  }

  return child;
}
