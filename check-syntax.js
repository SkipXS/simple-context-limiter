import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

async function jsFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return await jsFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  }));
  return files.flat();
}

async function check(file) {
  const child = spawn(process.execPath, ["--check", file], { stdio: "inherit", windowsHide: true });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) process.exit(code ?? 1);
}

const files = [
  "server.js",
  "smoke-test.js",
  "pack-smoke-test.js",
  "check-syntax.js",
  ...await jsFiles("src"),
];

for (const file of files) await check(file);
