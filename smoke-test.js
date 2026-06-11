import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { COMMAND_SHELL_NAME, MAX_BYTES, SERVER_VERSION } from "./src/constants.js";
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
  assert.equal(typeof meta.savedPercent, "number");
  assert.equal(typeof meta.estimatedTokensSaved, "number");
  assert.ok(meta.returnedBytes >= 0);
  assert.ok(meta.savedBytes >= 0);
  assert.ok(meta.savedPercent >= 0);
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

async function hasGitForTest() {
  try {
    const result = await runProcess("git", ["--version"], { timeout: 5_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

try {
  const longLine = formatOutput("x".repeat(MAX_BYTES + 8192), 60);
  assert.equal(longLine.truncated, true);
  assert.ok(Buffer.byteLength(longLine.text, "utf8") <= MAX_BYTES);
  assert.doesNotMatch(longLine.text, /-\d+ lines omitted/);
  const emptyOutput = formatOutput("");
  assert.equal(emptyOutput.text, "(no output)");
  assert.equal(emptyOutput.totalBytes, emptyOutput.returnedBytes);
  const customByteLimit = formatOutput("x".repeat(8192), 60, 1024);
  assert.equal(customByteLimit.truncated, true);
  assert.ok(Buffer.byteLength(customByteLimit.text, "utf8") <= 1024);
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
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    "context_run",
    "context_logs",
    "context_read",
    "context_search",
    "context_files",
    "context_tree",
    "context_repo_summary",
    "context_file_outline",
    "context_test_summary",
    "context_changed_files",
    "context_grep_context",
    "context_fetch",
    "context_diff",
    "context_stats",
  ]);

  const files = await request("tools/call", {
    name: "context_files",
    arguments: { include: "^(server|package)\\.json$|^server\\.js$", maxFiles: 20 },
  });
  assert.ok(files.result, JSON.stringify(files));
  assert.match(files.result.content[0].text, /server\.js/);
  assert.equal(typeof files.result._meta.totalFiles, "number");

  const fallbackFilesDir = join(tempDir, "fallback-files");
  await mkdir(join(fallbackFilesDir, "sub"), { recursive: true });
  await writeFile(join(fallbackFilesDir, "sub", "a.txt"), "a\n", "utf8");
  const fallbackFilesRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    const { callTool } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "src", "tools.js")).href)});
    const result = await callTool('context_files', { path: 'sub', maxFiles: 20 });
    console.log(JSON.stringify(result.content[0].text));
  `], {
    cwd: fallbackFilesDir,
    timeout: 5_000,
    env: { ...process.env, PATH: "", Path: "" },
  });
  assert.equal(fallbackFilesRun.code, 0, fallbackFilesRun.stderr);
  assert.match(JSON.parse(fallbackFilesRun.stdout.trim()), /sub\/a\.txt/);

  const tree = await request("tools/call", {
    name: "context_tree",
    arguments: { path: tempDir, maxDepth: 2, maxEntries: 20 },
  });
  assert.ok(tree.result, JSON.stringify(tree));
  assert.match(tree.result.content[0].text, /large\.txt/);

  const repoSummary = await request("tools/call", {
    name: "context_repo_summary",
    arguments: { maxLines: 40 },
  });
  assert.ok(repoSummary.result, JSON.stringify(repoSummary));
  assert.match(repoSummary.result.content[0].text, /simple-context-limiter/);

  const outline = await request("tools/call", {
    name: "context_file_outline",
    arguments: { path: join(import.meta.dirname, "src", "tools", "run.js"), maxSymbols: 20 },
  });
  assert.ok(outline.result, JSON.stringify(outline));
  assert.match(outline.result.content[0].text, /runTool/);

  const testSummary = await request("tools/call", {
    name: "context_test_summary",
    arguments: {
      command: isPowerShellConfigured()
        ? `& ${shellQuote(process.execPath)} -e "console.error('ReferenceError: missing'); process.exit(2)"`
        : `${shellQuote(process.execPath)} -e "console.error('ReferenceError: missing'); process.exit(2)"`,
      maxBytes: 4096,
    },
  });
  assert.ok(testSummary.result, JSON.stringify(testSummary));
  assert.equal(testSummary.result._meta.exitCode, 2);
  assert.match(testSummary.result.content[0].text, /ReferenceError: missing/);

  const invalidDiffMaxFiles = await request("tools/call", {
    name: "context_diff",
    arguments: { maxFiles: 0 },
  });
  assert.equal(invalidDiffMaxFiles.error.code, -32602);
  assert.match(invalidDiffMaxFiles.error.message, /maxFiles must be between 1 and 100/);

  const ok = await request("tools/call", {
    name: "context_run",
    arguments: { command: isPowerShellConfigured() ? "Write-Output ok" : `${shellQuote(process.execPath)} -e "console.log('ok')"` },
  });
  assert.ok(ok.result.content[0].text.startsWith("ok"));
  assert.equal(ok.result._meta.truncated, false);
  assertSavingsMeta(ok.result._meta);
  assert.equal(typeof ok.result._meta.durationMs, "number");
  assert.equal(typeof ok.result._meta.shell, "string");

  const byteLimitedRun = await request("tools/call", {
    name: "context_run",
    arguments: {
      command: isPowerShellConfigured()
        ? `& ${shellQuote(process.execPath)} -e "console.log('x'.repeat(50000))"`
        : `${shellQuote(process.execPath)} -e "console.log('x'.repeat(50000))"`,
      maxLines: 20,
      maxBytes: 1024,
    },
  });
  assert.equal(byteLimitedRun.result._meta.truncated, true);
  assert.ok(byteLimitedRun.result._meta.returnedBytes <= 1024);
  assert.ok(byteLimitedRun.result._meta.savedBytes > 0);

  const invalidRunMaxLines = await request("tools/call", {
    name: "context_run",
    arguments: { command: "noop", maxLines: "20" },
  });
  assert.equal(invalidRunMaxLines.error.code, -32602);
  assert.match(invalidRunMaxLines.error.message, /maxLines must be an integer/);

  const invalidRunMaxBytes = await request("tools/call", {
    name: "context_run",
    arguments: { command: "noop", maxBytes: "1024" },
  });
  assert.equal(invalidRunMaxBytes.error.code, -32602);
  assert.match(invalidRunMaxBytes.error.message, /maxBytes must be an integer/);

  const logsCommand = isPowerShellConfigured()
    ? `& ${shellQuote(process.execPath)} -e "for (let i = 0; i < 40; i++) console.log('line ' + i); console.error('AssertionError: expected true'); console.error('    at test.js:10:5'); process.exit(7)"`
    : `${shellQuote(process.execPath)} -e "for (let i = 0; i < 40; i++) console.log('line ' + i); console.error('AssertionError: expected true'); console.error('    at test.js:10:5'); process.exit(7)"`;
  const logs = await request("tools/call", {
    name: "context_logs",
    arguments: { command: logsCommand, maxBlocks: 2, contextLines: 1, maxBytes: 4096 },
  });
  assert.ok(logs.result, JSON.stringify(logs));
  assert.equal(logs.result._meta.exitCode, 7);
  assert.equal(logs.result._meta.blocksFound, 1);
  assert.equal(logs.result._meta.blocksShown, 1);
  assert.equal(logs.result._meta.fallback, false);
  assert.equal(logs.result._meta.shell, COMMAND_SHELL_NAME);
  assert.match(logs.result.content[0].text, /Command exit 7/);
  assert.match(logs.result.content[0].text, /AssertionError/);
  assert.match(logs.result.content[0].text, /at test\.js:10:5/);
  assert.doesNotMatch(logs.result.content[0].text, /line 0/);
  assertSavingsMeta(logs.result._meta);

  const logsFallbackCommand = isPowerShellConfigured()
    ? `& ${shellQuote(process.execPath)} -e "for (let i = 0; i < 30; i++) console.log('plain ' + i)"`
    : `${shellQuote(process.execPath)} -e "for (let i = 0; i < 30; i++) console.log('plain ' + i)"`;
  const logsFallback = await request("tools/call", {
    name: "context_logs",
    arguments: { command: logsFallbackCommand, maxLines: 10, maxBytes: 4096 },
  });
  assert.ok(logsFallback.result, JSON.stringify(logsFallback));
  assert.equal(logsFallback.result._meta.exitCode, 0);
  assert.equal(logsFallback.result._meta.fallback, true);
  assert.match(logsFallback.result.content[0].text, /No error patterns found/);
  assert.match(logsFallback.result.content[0].text, /plain 29/);
  assert.doesNotMatch(logsFallback.result.content[0].text, /plain 0/);

  const jsErrorLogs = await request("tools/call", {
    name: "context_logs",
    arguments: {
      command: isPowerShellConfigured()
        ? `& ${shellQuote(process.execPath)} -e "console.log('before'); console.error('TypeError: bad input'); console.log('after'); process.exit(1)"`
        : `${shellQuote(process.execPath)} -e "console.log('before'); console.error('TypeError: bad input'); console.log('after'); process.exit(1)"`,
      contextLines: 1,
      maxBytes: 4096,
    },
  });
  assert.ok(jsErrorLogs.result, JSON.stringify(jsErrorLogs));
  assert.equal(jsErrorLogs.result._meta.blocksFound, 1);
  assert.match(jsErrorLogs.result.content[0].text, /TypeError: bad input/);

  const invalidLogsMaxBlocks = await request("tools/call", {
    name: "context_logs",
    arguments: { command: "noop", maxBlocks: 0 },
  });
  assert.equal(invalidLogsMaxBlocks.error.code, -32602);
  assert.match(invalidLogsMaxBlocks.error.message, /maxBlocks must be between 1 and 50/);

  if (configuredShell().includes("bash")) {
    const bashOnly = await request("tools/call", {
      name: "context_run",
      arguments: { command: "printf 'configured-bash-ok\\n'" },
    });
    assert.ok(bashOnly.result.content[0].text.startsWith("configured-bash-ok"));
  }

  if (configuredShell().includes("cmd")) {
    const cmdOnly = await request("tools/call", {
      name: "context_run",
      arguments: { command: "echo configured-cmd-ok" },
    });
    assert.ok(cmdOnly.result.content[0].text.startsWith("configured-cmd-ok"));
  }

  if (isPowerShellConfigured()) {
    const powershellOnly = await request("tools/call", {
      name: "context_run",
      arguments: { command: "Write-Output configured-powershell-ok" },
    });
    assert.ok(powershellOnly.result.content[0].text.startsWith("configured-powershell-ok"));
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
  assert.equal(listWhileRunning.result.tools.length, listed.result.tools.length);
  const slowResult = await slow;
  assert.ok(slowResult.result.content[0].text.startsWith("slow"));

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

  const byteLimitedRead = await request("tools/call", {
    name: "context_read",
    arguments: { path: largeOneLineFile, maxLines: 20, maxBytes: 1024 },
  });
  assert.equal(byteLimitedRead.result._meta.truncated, true);
  assert.ok(byteLimitedRead.result._meta.returnedBytes <= 1024);

  const rangeRead = await request("tools/call", {
    name: "context_read",
    arguments: { path: largeFile, fromLine: 291, toLine: 295, maxLines: 20 },
  });
  assert.equal(rangeRead.result._meta.truncated, false);
  assert.equal(rangeRead.result._meta.fromLine, 291);
  assert.equal(rangeRead.result._meta.toLine, 295);
  assert.equal(rangeRead.result._meta.returnedLines, 5);
  assert.equal(typeof rangeRead.result._meta.scannedBytes, "number");
  assert.equal(rangeRead.result._meta.scanTimedOut, false);
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
  assert.equal(byteLimitedRangeRead.result._meta.returnedLines, 1);
  assert.match(byteLimitedRangeRead.result.content[0].text, /^x+/);

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

  const invalidReadMaxBytes = await request("tools/call", {
    name: "context_read",
    arguments: { path: largeFile, maxBytes: 1023 },
  });
  assert.equal(invalidReadMaxBytes.error.code, -32602);
  assert.match(invalidReadMaxBytes.error.message, /maxBytes must be between 1024/);

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

    const grepContext = await request("tools/call", {
      name: "context_grep_context",
      arguments: { pattern: "file line 29", path: largeFile, contextLines: 1, maxMatches: 3 },
    });
    assert.ok(grepContext.result, JSON.stringify(grepContext));
    assert.match(grepContext.result.content[0].text, /file line 29/);
    assert.equal(typeof grepContext.result._meta.rgPath, "string");

    const byteLimitedSearch = await request("tools/call", {
      name: "context_search",
      arguments: { pattern: "x", path: hugeRangeFile, maxMatches: 5, maxLines: 20, maxBytes: 1024 },
    });
    assert.ok(byteLimitedSearch.result, JSON.stringify(byteLimitedSearch));
    assert.equal(byteLimitedSearch.result._meta.truncated, true);
    assert.ok(byteLimitedSearch.result._meta.returnedBytes <= 1024);

    const noMatchSearch = await request("tools/call", {
      name: "context_search",
      arguments: { pattern: "does-not-exist", path: largeFile, maxMatches: 5 },
    });
    assert.equal(noMatchSearch.result.content[0].text, "(no matches)");
    assert.equal(noMatchSearch.result._meta.totalBytes, noMatchSearch.result._meta.returnedBytes);

    const noMatchGrepContext = await request("tools/call", {
      name: "context_grep_context",
      arguments: { pattern: "does-not-exist", path: largeFile, maxMatches: 5 },
    });
    assert.equal(noMatchGrepContext.result.content[0].text, "(no matches)");
    assert.equal(noMatchGrepContext.result._meta.totalBytes, noMatchGrepContext.result._meta.returnedBytes);
  }

  const invalidSearchMaxMatches = await request("tools/call", {
    name: "context_search",
    arguments: { pattern: "anything", maxMatches: 0 },
  });
  assert.equal(invalidSearchMaxMatches.error.code, -32602);
  assert.match(invalidSearchMaxMatches.error.message, /maxMatches must be between 1 and 1000/);

  const invalidSearchMaxBytes = await request("tools/call", {
    name: "context_search",
    arguments: { pattern: "anything", maxBytes: MAX_BYTES + 1 },
  });
  assert.equal(invalidSearchMaxBytes.error.code, -32602);
  assert.match(invalidSearchMaxBytes.error.message, /maxBytes must be between 1024/);

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

  const fetchedAgain = await request("tools/call", {
    name: "context_fetch",
    arguments: { url: `data:text/html,${encodeURIComponent(html)}`, maxLines: 20 },
  });
  assert.equal(fetchedAgain.result._meta.cached, false);
  assert.equal(fetchedAgain.result._meta.downloadLimited, true);

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

  const invalidFetchMaxBytes = await request("tools/call", {
    name: "context_fetch",
    arguments: { url: "data:text/plain,ok", maxBytes: "1024" },
  });
  assert.equal(invalidFetchMaxBytes.error.code, -32602);
  assert.match(invalidFetchMaxBytes.error.message, /maxBytes must be an integer/);

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

  const cacheRace = await runProcess(process.execPath, ["--input-type=module", "-e", `
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const { callTool } = await import('./src/tools.js');
    const urls = Array.from({ length: 20 }, (_, i) => 'data:text/plain,' + encodeURIComponent('cache-race-' + i));
    await Promise.all(urls.map((url) => callTool('context_fetch', { url, force: true })));
    const cache = JSON.parse(await readFile(join(process.env.HOME, '.simple-context-limiter', 'cache.json'), 'utf8'));
    console.log(Object.keys(cache).length);
  `], {
    cwd: import.meta.dirname,
    timeout: 5_000,
    env: {
      ...process.env,
      HOME: join(tempDir, "cache-race-home"),
      USERPROFILE: join(tempDir, "cache-race-home"),
      SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH: "1",
    },
  });
  assert.equal(cacheRace.code, 0, cacheRace.stderr);
  assert.equal(Number(cacheRace.stdout.trim()), 20);

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

  if (await hasGitForTest()) {
    const gitDir = join(tempDir, "diff-repo");
    await mkdir(gitDir);

    async function git(args) {
      const result = await runProcess("git", args, { cwd: gitDir, timeout: 5_000 });
      assert.equal(result.code, 0, result.stderr);
      return result;
    }

    const originalLines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const changedLines = originalLines.map((line, i) => {
      if (i === 1) return "changed early";
      if (i === 30) return "changed late";
      return line;
    });
    await git(["init"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test User"]);
    await writeFile(join(gitDir, "a.txt"), originalLines.join("\n"), "utf8");
    await writeFile(join(gitDir, "b.txt"), "same\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-m", "initial"]);
    await writeFile(join(gitDir, "a.txt"), changedLines.join("\n"), "utf8");
    await writeFile(join(gitDir, "b.txt"), "changed\n", "utf8");

    const diffRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
      const { callTool } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "src", "tools.js")).href)});
      const diff = await callTool('context_diff', { maxFiles: 1, maxHunks: 1, maxBytes: 4096 });
      const blankPathDiff = await callTool('context_diff', { path: '', maxBytes: 4096 });
      const changedFiles = await callTool('context_changed_files', { maxBytes: 4096 });
      const noStagedDiff = await callTool('context_diff', { staged: true, maxBytes: 4096 });
      console.log(JSON.stringify({ diff: { text: diff.content[0].text, meta: diff._meta }, blankPathDiff: { text: blankPathDiff.content[0].text, meta: blankPathDiff._meta }, changedFiles: { text: changedFiles.content[0].text, meta: changedFiles._meta }, noStagedDiff: { text: noStagedDiff.content[0].text, meta: noStagedDiff._meta } }));
    `], {
      cwd: gitDir,
      timeout: 5_000,
      env: {
        ...process.env,
        HOME: join(tempDir, "diff-home"),
        USERPROFILE: join(tempDir, "diff-home"),
      },
    });
    assert.equal(diffRun.code, 0, diffRun.stderr);
    const diffPayload = JSON.parse(diffRun.stdout.trim());
    assert.match(diffPayload.diff.text, /Diff stat:/);
    assert.match(diffPayload.diff.text, /Diff hunks:/);
    assert.match(diffPayload.diff.text, /a\.txt/);
    assert.match(diffPayload.diff.text, /more hunks omitted/);
    assert.match(diffPayload.diff.text, /more files omitted/);
    assert.equal(diffPayload.diff.meta.filesChanged, 2);
    assert.equal(diffPayload.diff.meta.filesShown, 1);
    assert.equal(diffPayload.diff.meta.filesLimited, true);
    assert.equal(diffPayload.diff.meta.hunksLimited, true);
    assert.equal(diffPayload.diff.meta.truncated, true);
    assert.ok(diffPayload.diff.meta.returnedBytes <= 4096);
    assertSavingsMeta(diffPayload.diff.meta);
    assert.match(diffPayload.blankPathDiff.text, /Diff stat:/);
    assert.equal(diffPayload.blankPathDiff.meta.filesChanged, 2);
    assert.match(diffPayload.changedFiles.text, /a\.txt/);
    assert.match(diffPayload.changedFiles.text, /b\.txt/);
    assert.equal(diffPayload.changedFiles.meta.changedFiles, 2);
    assert.equal(diffPayload.noStagedDiff.text, "(no diff)");
    assert.equal(diffPayload.noStagedDiff.meta.staged, true);
    assert.equal(diffPayload.noStagedDiff.meta.truncated, false);
  }

  const statsRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    const { callTool } = await import('./src/tools.js');
    await callTool('context_run', { command: ${JSON.stringify(`${shellQuote(process.execPath)} -e "console.log('x'.repeat(50000))"`)}, maxLines: 20 });
    await callTool('context_run', { command: ${JSON.stringify(`${shellQuote(process.execPath)} -e "console.log('ok')"`)}, maxLines: 20 });
    await callTool('context_fetch', { url: 'data:text/plain,' + encodeURIComponent('x'.repeat(2048)), force: true, maxLines: 20 });
    const stats = await callTool('context_stats', {});
    console.log(JSON.stringify({ text: stats.content[0].text, meta: stats._meta }));
  `], {
    cwd: import.meta.dirname,
    timeout: 5_000,
    env: {
      ...process.env,
      HOME: join(tempDir, "stats-home"),
      USERPROFILE: join(tempDir, "stats-home"),
      SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH: "1",
      SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES: "1024",
    },
  });
  assert.equal(statsRun.code, 0, statsRun.stderr);
  const statsPayload = JSON.parse(statsRun.stdout.trim());
  assert.match(statsPayload.text, /Total: 3 calls · saved /);
  assert.match(statsPayload.text, /By tool:/);
  assert.match(statsPayload.text, /context_run: 2 calls/);
  assert.match(statsPayload.text, /context_fetch: 1 calls/);
  const parsedStats = statsPayload.meta;
  assert.equal(parsedStats.project, import.meta.dirname);
  assert.equal(parsedStats.calls, 3);
  assert.equal(parsedStats.byTool.context_run.calls, 2);
  assert.equal(parsedStats.byTool.context_fetch.calls, 1);
  assert.ok(parsedStats.returnedBytes <= parsedStats.totalBytes);
  assert.ok(parsedStats.byTool.context_run.returnedBytes <= parsedStats.byTool.context_run.totalBytes);
  assert.ok(parsedStats.savedBytes > 0);
  assert.ok(parsedStats.estimatedTokensSaved > 0);

  httpServer = createServer((req, res) => {
    if (req.url === "/large") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(50000));
      return;
    }

    res.writeHead(418, { "content-type": "text/plain" });
    res.end("teapot");
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const byteLimitedFetch = await callTool("context_fetch", { url: `http://127.0.0.1:${port}/large`, force: true, maxLines: 20, maxBytes: 1024 });
  assert.equal(byteLimitedFetch._meta.truncated, true);
  assert.ok(byteLimitedFetch._meta.returnedBytes <= 1024);
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
