import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgsPrefix = npmExecPath ? [npmExecPath] : [];

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
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
    const timer = setTimeout(() => reject(new Error("timed out waiting for installed MCP server")), 5_000);
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
          clearTimeout(timer);
          resolveCollect(responses);
        }
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => reject(new Error(`installed MCP server exited early: ${code ?? signal}`)));
  });
}

let tempDir;
let tarballPath;

try {
  tempDir = await mkdtemp(join(tmpdir(), "simple-context-limiter-pack-"));
  const pack = await run(npmCommand, [...npmArgsPrefix, "pack", "--ignore-scripts", "--json"]);
  const packed = JSON.parse(pack.stdout);
  tarballPath = resolve(packed[0].filename);

  await run(npmCommand, [...npmArgsPrefix, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: tempDir });

  const serverPath = join(tempDir, "node_modules", "simple-context-limiter", "server.js");
  const child = spawn(process.execPath, [serverPath], {
    cwd: tempDir,
    env: {
      ...process.env,
      SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "0",
      SIMPLE_CONTEXT_LIMITER_STATS: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
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
      "run",
      "logs",
      "read",
      "search",
      "discover",
      "fetch",
      "diff",
      "usage",
    ]);
  } finally {
    child.kill();
  }

  console.log("pack smoke test passed");
} finally {
  if (typeof tarballPath === "string") await rm(tarballPath, { force: true });
  if (typeof tempDir === "string") await rm(tempDir, { recursive: true, force: true });
}
