import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_BYTES, SERVER_VERSION } from "./src/constants.js";
import { formatOutput } from "./src/output.js";
import { errorData, runProcess, runProcessLines } from "./src/process.js";
import { callTool } from "./src/tools.js";

const child = spawn(process.execPath, ["server.js"], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH: "1",
    SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES: "1024",
    SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES: "2048",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let buffer = "";
const pending = new Map();
const unexpectedResponses = [];
let tempDir;
let httpServer;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();

  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;

    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (!waiter) {
      unexpectedResponses.push(response);
      continue;
    }

    clearTimeout(waiter.timer);
    pending.delete(response.id);
    waiter.resolve(response);
  }
});

child.on("exit", (code, signal) => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`server exited before response: ${code ?? signal}`));
  }
  pending.clear();
});

function request(method, params) {
  const id = nextId++;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${method}`));
    }, 2_000);

    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notification(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function shellQuote(value) {
  if (process.platform === "win32") return `"${value.replaceAll("\"", "\\\"")}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function configuredShell() {
  return (process.env.SIMPLE_CONTEXT_LIMITER_SHELL ?? "").toLowerCase();
}

function isPowerShellConfigured() {
  const shell = configuredShell();
  return shell.includes("powershell") || shell.includes("pwsh");
}

function assertSavingsMeta(meta) {
  assert.equal(typeof meta.returnedBytes, "number");
  assert.equal(typeof meta.savedBytes, "number");
  assert.equal(typeof meta.estimatedTokensSaved, "number");
  assert.ok(meta.returnedBytes >= 0);
  assert.ok(meta.savedBytes >= 0);
  assert.ok(meta.estimatedTokensSaved >= 0);
}

async function pathExists(filePath) {
  try {
    await import("node:fs/promises").then((fs) => fs.stat(filePath));
    return true;
  } catch {
    return false;
  }
}

async function findRgForTest() {
  const rgName = process.platform === "win32" ? "rg.exe" : "rg";
  const entries = (process.env.PATH ?? process.env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const candidates = [
    ...entries.map((entry) => join(entry, rgName)),
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cache", "opencode", "bin", rgName),
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent", "bin", rgName),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

try {
  const longLine = formatOutput("x".repeat(MAX_BYTES + 8192), 60);
  assert.equal(longLine.truncated, true);
  assert.ok(Buffer.byteLength(longLine.text, "utf8") <= MAX_BYTES);
  assert.doesNotMatch(longLine.text, /-\d+ lines omitted/);
  const unicodeLongLine = formatOutput("🙂".repeat(MAX_BYTES), 60);
  assert.equal(unicodeLongLine.truncated, true);
  assert.doesNotMatch(unicodeLongLine.text, /�/);

  const timedOutProcess = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeout: 50 });
  assert.equal(timedOutProcess.timedOut, true);

  const lineLimitedProcess = await runProcessLines(process.execPath, ["-e", "for (let i = 0; i < 50; i++) console.log(i)"], { maxLines: 10 });
  assert.equal(lineLimitedProcess.truncated, true);
  assert.equal(lineLimitedProcess.lines.length, 10);

  tempDir = await mkdtemp(join(tmpdir(), "simple-context-limiter-test-"));
  const largeFile = join(tempDir, "large.txt");
  const largeOneLineFile = join(tempDir, "large-one-line.txt");
  const hugeRangeFile = join(tempDir, "huge-range.txt");
  const dashFile = join(tempDir, "dash.txt");
  await writeFile(largeFile, Array.from({ length: 300 }, (_, i) => `file line ${i}`).join("\n"), "utf8");
  await writeFile(largeOneLineFile, "🙂".repeat(2048), "utf8");
  await writeFile(hugeRangeFile, `${"x".repeat(4096)}\nsmall\n`, "utf8");
  await writeFile(dashFile, "-needle\nplain\n", "utf8");

  const init = await request("initialize", {});
  assert.equal(init.result.serverInfo.name, "simple-context-limiter");
  const packageJson = JSON.parse(await readFile(join(import.meta.dirname, "package.json"), "utf8"));
  assert.equal(SERVER_VERSION, packageJson.version);
  assert.equal(init.result.serverInfo.version, packageJson.version);

  notification("notifications/initialized", {});
  notification("unknown/notification", {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(unexpectedResponses, []);

  const listed = await request("tools/list", {});
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["context_run", "context_read", "context_search", "context_fetch"]);

  const ok = await request("tools/call", {
    name: "context_run",
    arguments: { command: isPowerShellConfigured() ? "Write-Output ok" : `${shellQuote(process.execPath)} -e "console.log('ok')"` },
  });
  assert.equal(ok.result.content[0].text.trim(), "ok");
  assert.equal(ok.result._meta.truncated, false);
  assertSavingsMeta(ok.result._meta);
  assert.equal(typeof ok.result._meta.durationMs, "number");
  assert.equal(typeof ok.result._meta.shell, "string");

  const invalidRunMaxLines = await request("tools/call", {
    name: "context_run",
    arguments: { command: "noop", maxLines: "20" },
  });
  assert.equal(invalidRunMaxLines.error.code, -32602);
  assert.match(invalidRunMaxLines.error.message, /maxLines must be an integer/);

  if (configuredShell().includes("bash")) {
    const bashOnly = await request("tools/call", {
      name: "context_run",
      arguments: { command: "printf 'configured-bash-ok\\n'" },
    });
    assert.equal(bashOnly.result.content[0].text.trim(), "configured-bash-ok");
  }

  if (configuredShell().includes("cmd")) {
    const cmdOnly = await request("tools/call", {
      name: "context_run",
      arguments: { command: "echo configured-cmd-ok" },
    });
    assert.equal(cmdOnly.result.content[0].text.trim(), "configured-cmd-ok");
  }

  if (isPowerShellConfigured()) {
    const powershellOnly = await request("tools/call", {
      name: "context_run",
      arguments: { command: "Write-Output configured-powershell-ok" },
    });
    assert.equal(powershellOnly.result.content[0].text.trim(), "configured-powershell-ok");
  }

  const failed = await request("tools/call", {
    name: "context_run",
    arguments: { command: isPowerShellConfigured() ? "exit 7" : `${shellQuote(process.execPath)} -e "process.exit(7)"` },
  });
  assert.equal(failed.error.code, -32000);
  assert.equal(failed.error.data.exitCode, 7);

  const slow = request("tools/call", {
    name: "context_run",
    arguments: { command: isPowerShellConfigured() ? "Start-Sleep -Milliseconds 300; Write-Output slow" : `${shellQuote(process.execPath)} -e "setTimeout(() => console.log('slow'), 300)"` },
  });
  const listWhileRunning = await request("tools/list", {});
  assert.equal(listWhileRunning.result.tools.length, 4);
  const slowResult = await slow;
  assert.equal(slowResult.result.content[0].text.trim(), "slow");

  const read = await request("tools/call", {
    name: "context_read",
    arguments: { path: largeFile, maxLines: 20 },
  });
  assert.equal(read.result._meta.truncated, true);
  assertSavingsMeta(read.result._meta);
  assert.ok(read.result._meta.savedBytes > 0);
  assert.equal(read.result._meta.fileReadLimited, true);
  assert.match(read.result.content[0].text, /file line 0/);
  assert.match(read.result.content[0].text, /file line 299/);

  const limitedRead = await request("tools/call", {
    name: "context_read",
    arguments: { path: largeOneLineFile, maxLines: 20 },
  });
  assert.equal(limitedRead.result._meta.fileReadLimited, true);
  assert.equal(limitedRead.result._meta.truncated, true);
  assert.doesNotMatch(limitedRead.result.content[0].text, /�/);

  const rangeRead = await request("tools/call", {
    name: "context_read",
    arguments: { path: largeFile, fromLine: 291, toLine: 295, maxLines: 20 },
  });
  assert.equal(rangeRead.result._meta.truncated, false);
  assert.equal(rangeRead.result._meta.fromLine, 291);
  assert.equal(rangeRead.result._meta.toLine, 295);
  assert.equal(rangeRead.result._meta.returnedLines, 5);
  assert.match(rangeRead.result.content[0].text, /file line 290/);
  assert.match(rangeRead.result.content[0].text, /file line 294/);
  assert.doesNotMatch(rangeRead.result.content[0].text, /file line 289/);

  const limitedRangeRead = await request("tools/call", {
    name: "context_read",
    arguments: { path: largeFile, fromLine: 1, toLine: 50, maxLines: 10 },
  });
  assert.equal(limitedRangeRead.result._meta.truncated, true);
  assert.equal(limitedRangeRead.result._meta.rangeLimited, true);
  assert.equal(limitedRangeRead.result._meta.returnedLines, 10);

  const byteLimitedRangeRead = await request("tools/call", {
    name: "context_read",
    arguments: { path: hugeRangeFile, fromLine: 1, toLine: 1, maxLines: 20 },
  });
  assert.equal(byteLimitedRangeRead.result._meta.truncated, true);
  assert.equal(byteLimitedRangeRead.result._meta.fileReadLimited, true);
  assert.equal(byteLimitedRangeRead.result._meta.returnedLines, 0);

  const invalidRangeRead = await request("tools/call", {
    name: "context_read",
    arguments: { path: largeFile, fromLine: 5, toLine: 1 },
  });
  assert.equal(invalidRangeRead.error.code, -32602);
  assert.match(invalidRangeRead.error.message, /toLine must be greater/);

  const invalidRangeTypeRead = await request("tools/call", {
    name: "context_read",
    arguments: { path: largeFile, fromLine: "1" },
  });
  assert.equal(invalidRangeTypeRead.error.code, -32602);
  assert.match(invalidRangeTypeRead.error.message, /fromLine must be an integer/);

  const invalidReadMaxLines = await request("tools/call", {
    name: "context_read",
    arguments: { path: largeFile, maxLines: 201 },
  });
  assert.equal(invalidReadMaxLines.error.code, -32602);
  assert.match(invalidReadMaxLines.error.message, /maxLines must be between 10 and 200/);

  const rgPath = await findRgForTest();
  if (rgPath) {
    const searched = await request("tools/call", {
      name: "context_search",
      arguments: { pattern: "file line 29", path: largeFile, maxMatches: 5 },
    });
    assert.ok(searched.result, JSON.stringify(searched));
    assert.match(searched.result.content[0].text, /file line 29/);
    assert.equal(typeof searched.result._meta.rgPath, "string");
    assert.equal(searched.result._meta.shownMatches, 5);
    assert.equal(searched.result._meta.truncated, true);
    assertSavingsMeta(searched.result._meta);
    assert.equal(searched.result._meta.totalMatchesKnown, false);
    assert.equal(searched.result._meta.totalMatches, undefined);
    assert.equal(searched.result._meta.matchesRead, 6);

    const dashPattern = await request("tools/call", {
      name: "context_search",
      arguments: { pattern: "-needle", path: dashFile, maxMatches: 5 },
    });
    assert.ok(dashPattern.result, JSON.stringify(dashPattern));
    assert.match(dashPattern.result.content[0].text, /-needle/);
  }

  const invalidSearchMaxMatches = await request("tools/call", {
    name: "context_search",
    arguments: { pattern: "anything", maxMatches: 0 },
  });
  assert.equal(invalidSearchMaxMatches.error.code, -32602);
  assert.match(invalidSearchMaxMatches.error.message, /maxMatches must be between 1 and 1000/);

  const html = `<html><body>${Array.from({ length: 300 }, (_, i) => `<p>line ${i}</p>`).join("")}</body></html>`;
  const fetched = await request("tools/call", {
    name: "context_fetch",
    arguments: { url: `data:text/html,${encodeURIComponent(html)}`, force: true, maxLines: 20 },
  });
  assert.ok(fetched.result, JSON.stringify(fetched));
  assert.equal(fetched.result._meta.truncated, true);
  assertSavingsMeta(fetched.result._meta);
  assert.ok(fetched.result._meta.savedBytes > 0);
  assert.equal(fetched.result._meta.downloadLimited, true);
  assert.match(fetched.result.content[0].text, /lines omitted/);

  const entityFetch = await request("tools/call", {
    name: "context_fetch",
    arguments: { url: `data:text/html,${encodeURIComponent("<p>A&#8212;B &#x2014; C</p>")}`, force: true, maxLines: 20 },
  });
  assert.match(entityFetch.result.content[0].text, /A.B . C/s);
  assert.doesNotMatch(entityFetch.result.content[0].text, /&#/);

  const invalidForce = await request("tools/call", {
    name: "context_fetch",
    arguments: { url: "data:text/plain,ok", force: "false" },
  });
  assert.equal(invalidForce.error.code, -32602);
  assert.match(invalidForce.error.message, /force must be a boolean/);

  const invalidFetchMaxLines = await request("tools/call", {
    name: "context_fetch",
    arguments: { url: "data:text/plain,ok", maxLines: "20" },
  });
  assert.equal(invalidFetchMaxLines.error.code, -32602);
  assert.match(invalidFetchMaxLines.error.message, /maxLines must be an integer/);

  const limitedFetch = await request("tools/call", {
    name: "context_fetch",
    arguments: { url: `data:text/plain,${encodeURIComponent("🙂".repeat(2048))}`, force: true, maxLines: 20 },
  });
  assert.equal(limitedFetch.result._meta.downloadLimited, true);
  assert.equal(limitedFetch.result._meta.truncated, true);
  assert.doesNotMatch(limitedFetch.result.content[0].text, /�/);

  const cacheUrl = `data:text/plain,${encodeURIComponent(`cache-${Date.now()}`)}`;
  const uncachedFetch = await request("tools/call", {
    name: "context_fetch",
    arguments: { url: cacheUrl, force: true },
  });
  assert.equal(uncachedFetch.result._meta.cached, false);
  assertSavingsMeta(uncachedFetch.result._meta);
  const cachedFetch = await request("tools/call", {
    name: "context_fetch",
    arguments: { url: cacheUrl },
  });
  assert.equal(cachedFetch.result._meta.cached, true);

  const cachePrune = await runProcess(process.execPath, ["--input-type=module", "-e", `
    const one = 'data:text/plain,' + encodeURIComponent('a'.repeat(700));
    const two = 'data:text/plain,' + encodeURIComponent('b'.repeat(700));
    const { callTool } = await import('./src/tools.js');
    const first = await callTool('context_fetch', { url: one, force: true });
    const second = await callTool('context_fetch', { url: two, force: true });
    const firstAgain = await callTool('context_fetch', { url: one });
    console.log(JSON.stringify({ first: first._meta.cached, second: second._meta.cached, firstAgain: firstAgain._meta.cached }));
  `], {
    cwd: import.meta.dirname,
    timeout: 5_000,
    env: {
      ...process.env,
      HOME: join(tempDir, "cache-home"),
      USERPROFILE: join(tempDir, "cache-home"),
      SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH: "1",
      SIMPLE_CONTEXT_LIMITER_CACHE_MAX_BYTES: "1000",
      SIMPLE_CONTEXT_LIMITER_CACHE_MAX_ENTRIES: "10",
    },
  });
  assert.equal(cachePrune.code, 0, cachePrune.stderr);
  assert.deepEqual(JSON.parse(cachePrune.stdout.trim()), { first: false, second: false, firstAgain: false });

  httpServer = createServer((req, res) => {
    res.writeHead(418, { "content-type": "text/plain" });
    res.end("teapot");
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  try {
    await callTool("context_fetch", { url: `http://127.0.0.1:${port}/missing`, force: true });
    assert.fail("expected context_fetch to reject HTTP errors");
  } catch (error) {
    const data = errorData(error);
    assert.equal(error.code, -32000);
    assert.equal(data.httpStatus, 418);
    assert.equal(data.httpStatusText, "I'm a Teapot");
    assert.match(data.url, /127\.0\.0\.1/);
  }

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const error = new Error("network unavailable");
      error.code = "ETEST";
      throw error;
    };
    await callTool("context_fetch", { url: "https://example.test/unavailable", force: true });
    assert.fail("expected context_fetch to include URL for network errors");
  } catch (error) {
    const data = errorData(error);
    assert.equal(error.code, -32000);
    assert.equal(data.url, "https://example.test/unavailable");
    assert.equal(data.cause.code, "ETEST");
    assert.equal(data.cause.message, "network unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("smoke tests passed");
} finally {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  if (typeof tempDir === "string") await rm(tempDir, { recursive: true, force: true });
  child.kill();
}
