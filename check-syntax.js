import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

async function jsFiles(directory) {
  return (await readdir(directory))
    .filter((file) => file.endsWith(".js"))
    .map((file) => `${directory}/${file}`);
}

async function check(file) {
  const child = spawn(process.execPath, ["--check", file], { stdio: "inherit", windowsHide: true });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) process.exit(code ?? 1);
}

const files = [
  "server.js",
  "smoke-test.js",
  "check-syntax.js",
  ...await jsFiles("src"),
  ...await jsFiles("src/tools"),
];

for (const file of files) await check(file);
