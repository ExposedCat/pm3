import { join } from "@std/path";

const version = requireEnv("VERSION");
const releaseDir = "dist/release";

await Deno.mkdir(releaseDir, { recursive: true });
await Deno.copyFile("dist/pm3", join(releaseDir, "pm3-linux-x86_64"));
await Deno.chmod(join(releaseDir, "pm3-linux-x86_64"), 0o755);
await Deno.copyFile(
  "packaging/systemd/pm3.service",
  join(releaseDir, "pm3.service"),
);

const checksums = await createChecksums(releaseDir);
await Deno.writeTextFile(
  join(releaseDir, `pm3-${version}-SHA256SUMS.txt`),
  checksums,
);

async function createChecksums(dir: string): Promise<string> {
  const lines: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) {
      continue;
    }

    const path = join(dir, entry.name);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      await Deno.readFile(path),
    );
    lines.push(`${encodeHex(hash)}  ${path}`);
  }

  return `${lines.sort().join("\n")}\n`;
}

function encodeHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}
