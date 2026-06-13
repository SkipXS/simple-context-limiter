import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const npmExecPath = process.env.npm_execpath;
const bundledNpmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const useBundledNpmCli = !npmExecPath && process.platform === "win32" && existsSync(bundledNpmCli);
const npmCommand = npmExecPath || useBundledNpmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgsPrefix = npmExecPath ? [npmExecPath] : useBundledNpmCli ? [bundledNpmCli] : [];
const npmUsesShell = !npmExecPath && !useBundledNpmCli && process.platform === "win32";

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: options.shell ?? false,
    });

    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0 && !signal) resolveRun(result);
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal})\n${result.stderr || result.stdout}`));
    });
  });
}

function request(child, method, params, id) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function notification(child, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function collectMcpResponses(child, expectedCount) {
  const responses = [];
  let buffer = "";

  return await new Promise((resolveCollect, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("timed out waiting for installed MCP server")), 5_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();

      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;

        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        responses.push(JSON.parse(line));
        if (responses.length >= expectedCount) {
          finish(resolveCollect, responses);
        }
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code, signal) => finish(reject, new Error(`installed MCP server exited early: ${code ?? signal}`)));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(resolveStop, 2_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.stdin.destroy();
    child.kill();
  });
}

let tempDir;
let tarballPath;

try {
  tempDir = await mkdtemp(join(tmpdir(), "simple-context-limiter-pack-"));
  const pack = await run(npmCommand, [...npmArgsPrefix, "pack", "--ignore-scripts", "--json"], { shell: npmUsesShell });
  const packed = JSON.parse(pack.stdout);
  const fileNames = new Set(packed[0].files.map((file) => file.path));
  tarballPath = resolve(packed[0].filename);

  for (const fileName of [
    "package.json",
    "server.js",
    "src/tools/registry.js",
    "src/package-scripts.js",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
  ]) {
    assert.equal(fileNames.has(fileName), true, `expected package to include ${fileName}`);
  }

  for (const fileName of [
    "smoke-test.js",
    "pack-smoke-test.js",
    "check-syntax.js",
    "scripts/output-quality-check.js",
    "test/search.test.js",
  ]) {
    assert.equal(fileNames.has(fileName), false, `expected package to exclude ${fileName}`);
  }
  for (const fileName of fileNames) {
    assert.equal(fileName.startsWith("scripts/"), false, `expected package to exclude scripts/: ${fileName}`);
    assert.equal(fileName.startsWith("test/"), false, `expected package to exclude test/: ${fileName}`);
  }

  await run(npmCommand, [...npmArgsPrefix, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: tempDir, shell: npmUsesShell });

  const installedPackageDir = join(tempDir, "node_modules", "simple-context-limiter");
  const installedCheck = await run(npmCommand, [...npmArgsPrefix, "run", "check"], { cwd: installedPackageDir, shell: npmUsesShell });
  assert.match(installedCheck.stdout, /source-checkout validation command/);

  const child = spawn(npmCommand, [...npmArgsPrefix, "exec", "--", "simple-context-limiter"], {
    cwd: tempDir,
    env: {
      ...process.env,
      SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "0",
      SIMPLE_CONTEXT_LIMITER_STATS: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: npmUsesShell,
  });

  try {
    request(child, "initialize", { protocolVersion: "2024-11-05" }, 1);
    notification(child, "notifications/initialized", {});
    request(child, "tools/list", {}, 2);
    const responses = await collectMcpResponses(child, 2);
    const initialize = responses.find((response) => response.id === 1);
    const toolsList = responses.find((response) => response.id === 2);

    assert.equal(initialize.result.serverInfo.name, "simple-context-limiter");
    assert.equal(toolsList.result.tools.length, 8);
    assert.deepEqual(toolsList.result.tools.map((tool) => tool.name), [
      "sc-run",
      "sc-logs",
      "sc-read",
      "sc-search",
      "sc-discover",
      "sc-fetch",
      "sc-diff",
      "sc-usage",
    ]);
  } finally {
    await stopChild(child);
  }

  console.log("pack smoke test passed");
} finally {
  if (typeof tarballPath === "string") await rm(tarballPath, { force: true });
  if (typeof tempDir === "string") await rm(tempDir, { recursive: true, force: true });
}
