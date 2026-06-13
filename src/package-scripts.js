#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptName = process.argv[2];

const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgsPrefix = npmExecPath ? [npmExecPath] : [];
const npmUsesShell = !npmExecPath && process.platform === "win32";

const sourceCheckoutMarkers = [
  "check-syntax.js",
  "smoke-test.js",
  "pack-smoke-test.js",
  "scripts/output-quality-check.js",
  "test",
];

const commands = {
  check: [
    ["node", ["check-syntax.js"]],
    ["npm", ["run", "test:unit"]],
    ["node", ["scripts/output-quality-check.js"]],
  ],
  quality: [["node", ["scripts/output-quality-check.js"]]],
  coverage: [["node", ["--test", "--experimental-test-coverage", "test/*.test.js"]]],
  test: [
    ["npm", ["run", "test:unit"]],
    ["npm", ["run", "test:smoke"]],
  ],
  "test:unit": [["node", ["--test", "test/*.test.js"]]],
  "test:smoke": [["node", ["smoke-test.js"]]],
  "release:check": [
    ["npm", ["pack", "--dry-run", "--ignore-scripts"]],
    ["node", ["pack-smoke-test.js"]],
  ],
  prepack: [["node", ["check-syntax.js"]]],
  prepublishOnly: [
    ["npm", ["run", "check"]],
    ["npm", ["run", "release:check"]],
  ],
};

if (!Object.hasOwn(commands, scriptName)) {
  console.error(`Unknown package script: ${scriptName ?? ""}`);
  process.exit(1);
}

if (!hasSourceCheckoutFiles()) {
  console.log(
    `simple-context-limiter: npm script "${scriptName}" is a source-checkout validation command; `
    + "the published package intentionally includes only runtime files and documentation. "
    + "Use the simple-context-limiter bin entrypoint to validate an installed package.",
  );
  process.exit(0);
}

for (const [command, args] of commands[scriptName]) {
  const result = run(command, args);
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function hasSourceCheckoutFiles() {
  return sourceCheckoutMarkers.every((marker) => existsSync(join(packageRoot, marker)));
}

function run(command, args) {
  if (command === "npm") {
    return spawnSync(npmCommand, [...npmArgsPrefix, ...args], {
      cwd: packageRoot,
      stdio: "inherit",
      windowsHide: true,
      shell: npmUsesShell,
    });
  }

  return spawnSync(process.execPath, args, {
    cwd: packageRoot,
    stdio: "inherit",
    windowsHide: true,
  });
}
