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

process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";

const child = spawn(process.execPath, ["server.js"], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH: "1",
    SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES: "1024",
    SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES: "2048",
    SIMPLE_CONTEXT_LIMITER_MAX_RPC_BATCH_CONCURRENCY: "2",
    SIMPLE_CONTEXT_LIMITER_MAX_RPC_BATCH_SIZE: "4",
    SIMPLE_CONTEXT_LIMITER_MAX_RPC_LINE_BYTES: "65536",
    SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "0",
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

function rawRequest(payload) {
  const start = unexpectedResponses.length;
  child.stdin.write(JSON.stringify(payload) + "\n");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("timed out waiting for raw response"));
    }, 2_000);
    const interval = setInterval(() => {
      if (unexpectedResponses.length <= start) return;

      clearTimeout(timer);
      clearInterval(interval);
      resolve(unexpectedResponses.splice(start, 1)[0]);
    }, 10);
  });
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

function findSchemaKeyword(value, banned, path = "inputSchema") {
  if (value === null || typeof value !== "object") return undefined;
  for (const key of Object.keys(value)) {
    const currentPath = `${path}.${key}`;
    if (banned.includes(key)) return currentPath;
    const nested = findSchemaKeyword(value[key], banned, currentPath);
    if (nested) return nested;
  }
  return undefined;
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

async function findAstGrepForTest() {
  const names = process.platform === "win32" ? ["sg.exe", "ast-grep.exe"] : ["sg", "ast-grep"];
  const entries = (process.env.PATH ?? process.env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);

  for (const entry of entries) {
    for (const name of names) {
      const candidate = join(entry, name);
      if (!await pathExists(candidate)) continue;
      try {
        const result = await runProcess(candidate, ["--version"], { timeout: 5_000 });
        if (result.code === 0) return candidate;
      } catch {}
    }
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
  assert.equal(emptyOutput.totalLines, 0);
  assert.equal(emptyOutput.totalBytes, 0);
  assert.ok(emptyOutput.returnedBytes > 0);
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
  const manyShortLinesFile = join(tempDir, "many-short-lines.txt");
  const manyByteLinesFile = join(tempDir, "many-byte-lines.txt");
  const hugeRangeFile = join(tempDir, "huge-range.txt");
  const scanLimitedRangeFile = join(tempDir, "scan-limited-range.txt");
  const dashFile = join(tempDir, "dash.txt");
  await writeFile(largeFile, Array.from({ length: 300 }, (_, i) => `file line ${i}`).join("\n"), "utf8");
  await writeFile(largeOneLineFile, "🙂".repeat(2048), "utf8");
  await writeFile(manyShortLinesFile, Array.from({ length: 300 }, () => "x").join("\n"), "utf8");
  await writeFile(manyByteLinesFile, Array.from({ length: 500 }, () => "xxxx").join("\n"), "utf8");
  await writeFile(hugeRangeFile, `${"x".repeat(4096)}\nsmall\n`, "utf8");
  await writeFile(scanLimitedRangeFile, "x".repeat(4096), "utf8");
  await writeFile(dashFile, "-needle\nplain\n", "utf8");

  const init = await request("initialize", {});
  assert.equal(init.result.serverInfo.name, "simple-context-limiter");
  const invalidInitializeParams = await request("initialize", []);
  assert.equal(invalidInitializeParams.error.code, -32602);
  assert.match(invalidInitializeParams.error.message, /initialize params/);
  const invalidInitializeProtocol = await request("initialize", { protocolVersion: 123 });
  assert.equal(invalidInitializeProtocol.error.code, -32602);
  assert.match(invalidInitializeProtocol.error.message, /protocolVersion/);
  const packageJson = JSON.parse(await readFile(join(import.meta.dirname, "package.json"), "utf8"));
  assert.equal(SERVER_VERSION, packageJson.version);
  assert.equal(init.result.serverInfo.version, packageJson.version);
  assert.equal(packageJson.bin["simple-context-limiter"], "server.js");
  assert.ok(packageJson.files.includes("server.js"));
  assert.ok(packageJson.files.includes("src/"));
  assert.match(await readFile(join(import.meta.dirname, "server.js"), "utf8"), /^#!\/usr\/bin\/env node/);

  notification("notifications/initialized", {});
  notification("unknown/notification", {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(unexpectedResponses, []);

  const unknownMethod = await request("unknown/method", {});
  assert.equal(unknownMethod.error.code, -32601);
  assert.match(unknownMethod.error.message, /Unknown method/);

  const invalidNullRequest = await rawRequest(null);
  assert.equal(invalidNullRequest.id, null);
  assert.equal(invalidNullRequest.error.code, -32600);
  assert.match(invalidNullRequest.error.message, /Invalid Request/);

  const invalidMissingMethod = await rawRequest({ jsonrpc: "2.0", id: "invalid" });
  assert.equal(invalidMissingMethod.id, "invalid");
  assert.equal(invalidMissingMethod.error.code, -32600);
  assert.match(invalidMissingMethod.error.message, /Invalid Request/);

  const invalidJsonRpcVersion = await rawRequest({ jsonrpc: "1.0", id: "bad-version", method: "tools/list" });
  assert.equal(invalidJsonRpcVersion.id, "bad-version");
  assert.equal(invalidJsonRpcVersion.error.code, -32600);

  const invalidRequestId = await rawRequest({ jsonrpc: "2.0", id: { bad: true }, method: "tools/list" });
  assert.equal(invalidRequestId.id, null);
  assert.equal(invalidRequestId.error.code, -32600);

  const oversizedLine = await rawRequest({ jsonrpc: "2.0", id: "too-large", method: "x".repeat(70000) });
  assert.equal(oversizedLine.id, null);
  assert.equal(oversizedLine.error.code, -32600);
  assert.match(oversizedLine.error.message, /Request line exceeds/);

  const emptyBatch = await rawRequest([]);
  assert.equal(emptyBatch.id, null);
  assert.equal(emptyBatch.error.code, -32600);

  const batch = await rawRequest([
    { jsonrpc: "2.0", id: "list", method: "tools/list" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    null,
    { jsonrpc: "2.0", id: "missing", method: "unknown/method" },
  ]);
  assert.equal(Array.isArray(batch), true);
  assert.equal(batch.length, 3);
  assert.equal(batch.find((response) => response.id === "list").result.tools.length, 8);
  assert.equal(batch.find((response) => response.id === null).error.code, -32600);
  assert.equal(batch.find((response) => response.id === "missing").error.code, -32601);

  const oversizedBatch = await rawRequest(Array.from({ length: 5 }, (_, index) => ({
    jsonrpc: "2.0",
    id: `batch-${index}`,
    method: "tools/list",
  })));
  assert.equal(oversizedBatch.id, null);
  assert.equal(oversizedBatch.error.code, -32600);
  assert.match(oversizedBatch.error.message, /Batch size exceeds 4/);

  const listed = await request("tools/list", {});
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    "run",
    "logs",
    "read",
    "search",
    "discover",
    "fetch",
    "diff",
    "usage",
  ]);
  assert.equal(listed.result.tools.every((tool) => tool.inputSchema.additionalProperties === false), true);
  assert.equal(findSchemaKeyword(listed.result.tools.map((tool) => tool.inputSchema), ["oneOf", "anyOf", "allOf", "enum", "const", "not"]), undefined);
  const readSchema = listed.result.tools.find((tool) => tool.name === "read").inputSchema;
  assert.equal(readSchema.type, "object");
  assert.equal(readSchema.anyOf, undefined);
  assert.match(readSchema.properties.paths.description, /path is also provided/);

  const unknownTool = await request("tools/call", {
    name: "missing",
    arguments: {},
  });
  assert.equal(unknownTool.error.code, -32601);
  assert.match(unknownTool.error.message, /Unknown tool/);

  const missingToolName = await request("tools/call", { arguments: {} });
  assert.equal(missingToolName.error.code, -32602);
  assert.match(missingToolName.error.message, /params\.name/);

  const invalidToolArguments = await request("tools/call", { name: "usage", arguments: [] });
  assert.equal(invalidToolArguments.error.code, -32602);
  assert.match(invalidToolArguments.error.message, /params\.arguments/);

  const files = await request("tools/call", {
    name: "discover",
    arguments: { mode: "files", include: "^(server|package)\\.json$|^server\\.js$", maxFiles: 20 },
  });
  assert.ok(files.result, JSON.stringify(files));
  assert.match(files.result.content[0].text, /server\.js/);
  assert.equal(typeof files.result._meta.totalFiles, "number");

  const fallbackFilesDir = join(tempDir, "fallback-files");
  await mkdir(join(fallbackFilesDir, "sub"), { recursive: true });
  await writeFile(join(fallbackFilesDir, "sub", "a.txt"), "a\n", "utf8");
  for (let i = 0; i < 10; i++) await writeFile(join(fallbackFilesDir, "sub", `extra-${i}.txt`), `${i}\n`, "utf8");
  const fallbackFilesRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    const { callTool } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "src", "tools.js")).href)});
    const result = await callTool('discover', { mode: 'files', path: 'sub', maxFiles: 3 });
    console.log(JSON.stringify({ text: result.content[0].text, meta: result._meta }));
  `], {
    cwd: fallbackFilesDir,
    timeout: 5_000,
    env: { ...process.env, PATH: "", Path: "" },
  });
  assert.equal(fallbackFilesRun.code, 0, fallbackFilesRun.stderr);
  const fallbackFilesPayload = JSON.parse(fallbackFilesRun.stdout.trim());
  assert.match(fallbackFilesPayload.text, /more files omitted/);
  assert.equal(fallbackFilesPayload.meta.shownFiles, 3);
  assert.equal(fallbackFilesPayload.meta.totalFilesKnown, false);
  assert.equal(fallbackFilesPayload.meta.truncated, true);

  const fallbackFileRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    const { callTool } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "src", "tools.js")).href)});
    const result = await callTool('discover', { mode: 'files', path: 'sub/a.txt', maxFiles: 20 });
    console.log(JSON.stringify(result.content[0].text));
  `], {
    cwd: fallbackFilesDir,
    timeout: 5_000,
    env: { ...process.env, PATH: "", Path: "" },
  });
  assert.equal(fallbackFileRun.code, 0, fallbackFileRun.stderr);
  assert.equal(JSON.parse(fallbackFileRun.stdout.trim()), "sub/a.txt");

  const tree = await request("tools/call", {
    name: "discover",
    arguments: { mode: "tree", path: tempDir, maxDepth: 2, maxEntries: 20 },
  });
  assert.ok(tree.result, JSON.stringify(tree));
  assert.match(tree.result.content[0].text, /large\.txt/);

  const depthLimitedTree = await request("tools/call", {
    name: "discover",
    arguments: { mode: "tree", path: fallbackFilesDir, maxDepth: 1, maxEntries: 20 },
  });
  assert.equal(depthLimitedTree.result._meta.depthLimited, true);
  assert.equal(depthLimitedTree.result._meta.truncated, true);

  const entryLimitedTree = await request("tools/call", {
    name: "discover",
    arguments: { mode: "tree", path: join(fallbackFilesDir, "sub"), maxDepth: 1, maxEntries: 3 },
  });
  assert.equal(entryLimitedTree.result._meta.entriesShown, 3);
  assert.ok(entryLimitedTree.result._meta.entriesOmitted > 0);
  assert.equal(entryLimitedTree.result._meta.entriesOmittedLowerBound, entryLimitedTree.result._meta.entriesOmitted);
  assert.equal(entryLimitedTree.result._meta.entriesOmittedKnown, false);
  assert.equal(entryLimitedTree.result._meta.truncated, true);

  const repoSummary = await request("tools/call", {
    name: "discover",
    arguments: { mode: "summary", maxLines: 40 },
  });
  assert.ok(repoSummary.result, JSON.stringify(repoSummary));
  assert.match(repoSummary.result.content[0].text, /simple-context-limiter/);

  const outline = await request("tools/call", {
    name: "discover",
    arguments: { mode: "outline", path: join(import.meta.dirname, "src", "tools", "shared.js"), maxSymbols: 20 },
  });
  assert.ok(outline.result, JSON.stringify(outline));
  assert.match(outline.result.content[0].text, /invalidParams/);

  const testSummary = await request("tools/call", {
    name: "logs",
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
    name: "diff",
    arguments: { maxFiles: 0 },
  });
  assert.equal(invalidDiffMaxFiles.error.code, -32602);
  assert.match(invalidDiffMaxFiles.error.message, /maxFiles must be between 1 and 100/);

  const unknownRunArg = await request("tools/call", {
    name: "run",
    arguments: { command: "noop", unexpected: true },
  });
  assert.equal(unknownRunArg.error.code, -32602);
  assert.match(unknownRunArg.error.message, /Unknown argument/);

  const ok = await request("tools/call", {
    name: "run",
    arguments: { command: isPowerShellConfigured() ? "Write-Output ok" : `${shellQuote(process.execPath)} -e "console.log('ok')"` },
  });
  assert.ok(ok.result.content[0].text.startsWith("ok"));
  assert.equal(ok.result._meta.truncated, false);
  assertSavingsMeta(ok.result._meta);
  assert.equal(typeof ok.result._meta.durationMs, "number");
  assert.equal(ok.result._meta.timeoutMs, 120_000);
  assert.equal(typeof ok.result._meta.shell, "string");

  const stdoutWithStderr = await request("tools/call", {
    name: "run",
    arguments: {
      command: isPowerShellConfigured()
        ? `& ${shellQuote(process.execPath)} -e "console.log('stdout-ok'); console.error('stderr-noise')"`
        : `${shellQuote(process.execPath)} -e "console.log('stdout-ok'); console.error('stderr-noise')"`,
    },
  });
  assert.match(stdoutWithStderr.result.content[0].text, /stdout-ok/);
  assert.doesNotMatch(stdoutWithStderr.result.content[0].text, /stderr-noise/);

  const byteLimitedRun = await request("tools/call", {
    name: "run",
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

  const outputTooLargeCommand = isPowerShellConfigured()
    ? `& ${shellQuote(process.execPath)} -e "process.stdout.write('x'.repeat(50000))"`
    : `${shellQuote(process.execPath)} -e "process.stdout.write('x'.repeat(50000))"`;
  const outputTooLargeRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    const { callTool } = await import('./src/tools.js');
    const result = await callTool('run', { command: ${JSON.stringify(outputTooLargeCommand)}, maxLines: 200, maxBytes: 32768 });
    console.log(JSON.stringify(result._meta));
  `], {
    cwd: import.meta.dirname,
    timeout: 5_000,
    env: {
      ...process.env,
      SIMPLE_CONTEXT_LIMITER_MAX_COMMAND_BYTES: "1024",
      SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "0",
    },
  });
  assert.equal(outputTooLargeRun.code, 0, outputTooLargeRun.stderr);
  const outputTooLargeMeta = JSON.parse(outputTooLargeRun.stdout.trim());
  assert.equal(outputTooLargeMeta.truncated, true);
  assert.equal(outputTooLargeMeta.outputTooLarge, true);
  assert.equal(outputTooLargeMeta.totalBytesKnown, false);
  assert.ok(Object.hasOwn(outputTooLargeMeta, "exitCode") || Object.hasOwn(outputTooLargeMeta, "signal"));
  assert.ok(outputTooLargeMeta.savedBytes > 0);

  const invalidRunMaxLines = await request("tools/call", {
    name: "run",
    arguments: { command: "noop", maxLines: "20" },
  });
  assert.equal(invalidRunMaxLines.error.code, -32602);
  assert.match(invalidRunMaxLines.error.message, /maxLines must be an integer/);

  const invalidRunMaxBytes = await request("tools/call", {
    name: "run",
    arguments: { command: "noop", maxBytes: "1024" },
  });
  assert.equal(invalidRunMaxBytes.error.code, -32602);
  assert.match(invalidRunMaxBytes.error.message, /maxBytes must be an integer/);

  const invalidRunTimeout = await request("tools/call", {
    name: "run",
    arguments: { command: "noop", timeoutMs: 99 },
  });
  assert.equal(invalidRunTimeout.error.code, -32602);
  assert.match(invalidRunTimeout.error.message, /timeoutMs must be between 100 and 1800000/);

  const timedOutRun = await request("tools/call", {
    name: "run",
    arguments: {
      command: isPowerShellConfigured()
        ? `& ${shellQuote(process.execPath)} -e "setTimeout(() => {}, 1000)"`
        : `${shellQuote(process.execPath)} -e "setTimeout(() => {}, 1000)"`,
      timeoutMs: 100,
    },
  });
  assert.equal(timedOutRun.result.isError, true);
  assert.match(timedOutRun.result.content[0].text, /timed out after 100ms/);

  const logsCommand = isPowerShellConfigured()
    ? `& ${shellQuote(process.execPath)} -e "for (let i = 0; i < 40; i++) console.log('line ' + i); console.error('AssertionError: expected true'); console.error('    at test.js:10:5'); process.exit(7)"`
    : `${shellQuote(process.execPath)} -e "for (let i = 0; i < 40; i++) console.log('line ' + i); console.error('AssertionError: expected true'); console.error('    at test.js:10:5'); process.exit(7)"`;
  const logs = await request("tools/call", {
    name: "logs",
    arguments: { command: logsCommand, maxBlocks: 2, contextLines: 1, maxBytes: 4096 },
  });
  assert.ok(logs.result, JSON.stringify(logs));
  assert.equal(logs.result._meta.exitCode, 7);
  assert.equal(logs.result._meta.blocksFound, 1);
  assert.equal(logs.result._meta.blocksShown, 1);
  assert.equal(logs.result._meta.fallback, false);
  assert.equal(logs.result._meta.shell, COMMAND_SHELL_NAME);
  assert.equal(logs.result._meta.timeoutMs, 120_000);
  assert.match(logs.result.content[0].text, /Command exit 7/);
  assert.match(logs.result.content[0].text, /AssertionError/);
  assert.match(logs.result.content[0].text, /at test\.js:10:5/);
  assert.doesNotMatch(logs.result.content[0].text, /line 0/);
  assertSavingsMeta(logs.result._meta);

  const npmErrLogs = await request("tools/call", {
    name: "logs",
    arguments: {
      command: isPowerShellConfigured()
        ? `& ${shellQuote(process.execPath)} -e "for (let i = 0; i < 20; i++) console.log('before ' + i); console.error('npm ERR! code E404'); for (let i = 0; i < 40; i++) console.log('after ' + i)"`
        : `${shellQuote(process.execPath)} -e "for (let i = 0; i < 20; i++) console.log('before ' + i); console.error('npm ERR! code E404'); for (let i = 0; i < 40; i++) console.log('after ' + i)"`,
      contextLines: 0,
      maxLines: 10,
      maxBytes: 4096,
    },
  });
  assert.equal(npmErrLogs.result._meta.fallback, false);
  assert.match(npmErrLogs.result.content[0].text, /npm ERR! code E404/);

  const logsFallbackCommand = isPowerShellConfigured()
    ? `& ${shellQuote(process.execPath)} -e "for (let i = 0; i < 30; i++) console.log('plain ' + i)"`
    : `${shellQuote(process.execPath)} -e "for (let i = 0; i < 30; i++) console.log('plain ' + i)"`;
  const logsFallback = await request("tools/call", {
    name: "logs",
    arguments: { command: logsFallbackCommand, maxLines: 10, maxBytes: 4096 },
  });
  assert.ok(logsFallback.result, JSON.stringify(logsFallback));
  assert.equal(logsFallback.result._meta.exitCode, 0);
  assert.equal(logsFallback.result._meta.fallback, true);
  assert.match(logsFallback.result.content[0].text, /No error patterns found/);
  assert.match(logsFallback.result.content[0].text, /plain 29/);
  assert.doesNotMatch(logsFallback.result.content[0].text, /plain 0/);

  const jsErrorLogs = await request("tools/call", {
    name: "logs",
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
    name: "logs",
    arguments: { command: "noop", maxBlocks: 0 },
  });
  assert.equal(invalidLogsMaxBlocks.error.code, -32602);
  assert.match(invalidLogsMaxBlocks.error.message, /maxBlocks must be between 1 and 50/);

  const timedOutLogs = await request("tools/call", {
    name: "logs",
    arguments: {
      command: isPowerShellConfigured()
        ? `& ${shellQuote(process.execPath)} -e "setTimeout(() => {}, 1000)"`
        : `${shellQuote(process.execPath)} -e "setTimeout(() => {}, 1000)"`,
      timeoutMs: 100,
      maxBytes: 4096,
    },
  });
  assert.ok(timedOutLogs.result, JSON.stringify(timedOutLogs));
  assert.equal(timedOutLogs.result._meta.timedOut, true);
  assert.equal(timedOutLogs.result._meta.timeoutMs, 100);
  assert.match(timedOutLogs.result.content[0].text, /Command timed out/);

  if (configuredShell().includes("bash")) {
    const bashOnly = await request("tools/call", {
      name: "run",
      arguments: { command: "printf 'configured-bash-ok\\n'" },
    });
    assert.ok(bashOnly.result.content[0].text.startsWith("configured-bash-ok"));
  }

  if (configuredShell().includes("cmd")) {
    const cmdOnly = await request("tools/call", {
      name: "run",
      arguments: { command: "echo configured-cmd-ok" },
    });
    assert.ok(cmdOnly.result.content[0].text.startsWith("configured-cmd-ok"));
  }

  if (isPowerShellConfigured()) {
    const powershellOnly = await request("tools/call", {
      name: "run",
      arguments: { command: "Write-Output configured-powershell-ok" },
    });
    assert.ok(powershellOnly.result.content[0].text.startsWith("configured-powershell-ok"));
  }

  const failed = await request("tools/call", {
    name: "run",
    arguments: { command: isPowerShellConfigured() ? "exit 7" : `${shellQuote(process.execPath)} -e "process.exit(7)"` },
  });
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result._meta.exitCode, 7);

  const slow = request("tools/call", {
    name: "run",
    arguments: { command: isPowerShellConfigured() ? "Start-Sleep -Milliseconds 300; Write-Output slow" : `${shellQuote(process.execPath)} -e "setTimeout(() => console.log('slow'), 300)"` },
  });
  const listWhileRunning = await request("tools/list", {});
  assert.equal(listWhileRunning.result.tools.length, listed.result.tools.length);
  const slowResult = await slow;
  assert.ok(slowResult.result.content[0].text.startsWith("slow"));

  const read = await request("tools/call", {
    name: "read",
    arguments: { path: largeFile, maxLines: 20 },
  });
  assert.equal(read.result._meta.truncated, true);
  assertSavingsMeta(read.result._meta);
  assert.ok(read.result._meta.savedBytes > 0);
  assert.equal(read.result._meta.fileReadLimited, true);
  assert.match(read.result.content[0].text, /file line 0/);
  assert.match(read.result.content[0].text, /file line 299/);

  const readMany = await request("tools/call", {
    name: "read",
    arguments: { paths: [largeFile, dashFile], maxLinesPerFile: 20, maxTotalBytes: 4096 },
  });
  assert.equal(readMany.result._meta.filesRequested, 2);
  assert.equal(readMany.result._meta.filesRead, 2);
  assert.equal(readMany.result._meta.truncated, true);
  assert.ok(readMany.result._meta.savedBytes > 0);
  assert.equal(readMany.result._meta.files.length, 2);
  assert.match(readMany.result.content[0].text, /large\.txt/);
  assert.match(readMany.result.content[0].text, /dash\.txt/);
  assert.match(readMany.result.content[0].text, /-needle/);

  const readManyMaxFallback = await request("tools/call", {
    name: "read",
    arguments: { paths: [largeFile, dashFile], maxLines: 20, maxBytes: 4096, maxTotalLines: 20, maxTotalBytes: 4096 },
  });
  assert.equal(readManyMaxFallback.result._meta.maxTotalLines, 20);
  assert.equal(readManyMaxFallback.result._meta.files.length, 2);

  const invalidReadManyRange = await request("tools/call", {
    name: "read",
    arguments: { paths: [largeFile, dashFile], fromLine: 1 },
  });
  assert.equal(invalidReadManyRange.error.code, -32602);
  assert.match(invalidReadManyRange.error.message, /require path/);

  const singlePathArrayRange = await request("tools/call", {
    name: "read",
    arguments: { paths: [largeFile], fromLine: 291, toLine: 295, maxLinesPerFile: 20 },
  });
  assert.ok(singlePathArrayRange.result, JSON.stringify(singlePathArrayRange));
  assert.match(singlePathArrayRange.result.content[0].text, /file line 290/);
  assert.doesNotMatch(singlePathArrayRange.result.content[0].text, /file line 289/);

  const mergedReadPathAndPaths = await request("tools/call", {
    name: "read",
    arguments: { path: largeFile, paths: [dashFile, largeFile], maxLinesPerFile: 20, maxTotalBytes: 4096 },
  });
  assert.equal(mergedReadPathAndPaths.result._meta.filesRequested, 2);
  assert.equal(mergedReadPathAndPaths.result._meta.filesRead, 2);
  assert.match(mergedReadPathAndPaths.result.content[0].text, /large\.txt/);
  assert.match(mergedReadPathAndPaths.result.content[0].text, /dash\.txt/);

  const rangedMergedRead = await request("tools/call", {
    name: "read",
    arguments: { path: largeFile, paths: [dashFile], fromLine: 291, toLine: 295, maxLinesPerFile: 20, maxTotalBytes: 4096 },
  });
  assert.ok(rangedMergedRead.result, JSON.stringify(rangedMergedRead));
  assert.match(rangedMergedRead.result.content[0].text, /large\.txt/);
  assert.match(rangedMergedRead.result.content[0].text, /file line 290/);
  assert.doesNotMatch(rangedMergedRead.result.content[0].text, /file line 289/);
  assert.match(rangedMergedRead.result.content[0].text, /dash\.txt/);
  assert.match(rangedMergedRead.result.content[0].text, /-needle/);

  const invalidReadManyPaths = await request("tools/call", {
    name: "read",
    arguments: { paths: Array.from({ length: 21 }, (_, i) => `${i}.txt`) },
  });
  assert.equal(invalidReadManyPaths.error.code, -32602);
  assert.match(invalidReadManyPaths.error.message, /at most 20/);

  const limitedRead = await request("tools/call", {
    name: "read",
    arguments: { path: largeOneLineFile, maxLines: 20 },
  });
  assert.equal(limitedRead.result._meta.fileReadLimited, true);
  assert.equal(limitedRead.result._meta.truncated, true);
  assert.ok(limitedRead.result._meta.savedBytes > 0);
  assert.doesNotMatch(limitedRead.result.content[0].text, /�/);

  const byteLimitedRead = await request("tools/call", {
    name: "read",
    arguments: { path: largeOneLineFile, maxLines: 20, maxBytes: 1024 },
  });
  assert.equal(byteLimitedRead.result._meta.truncated, true);
  assert.ok(byteLimitedRead.result._meta.returnedBytes <= 1024);

  const rangeRead = await request("tools/call", {
    name: "read",
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
    name: "read",
    arguments: { path: largeFile, fromLine: 1, toLine: 50, maxLines: 10 },
  });
  assert.equal(limitedRangeRead.result._meta.truncated, true);
  assert.equal(limitedRangeRead.result._meta.rangeLimited, true);
  assert.equal(limitedRangeRead.result._meta.returnedLines, 10);

  const byteLimitedRangeRead = await request("tools/call", {
    name: "read",
    arguments: { path: hugeRangeFile, fromLine: 1, toLine: 1, maxLines: 20 },
  });
  assert.equal(byteLimitedRangeRead.result._meta.truncated, true);
  assert.equal(byteLimitedRangeRead.result._meta.fileReadLimited, true);
  assert.equal(byteLimitedRangeRead.result._meta.returnedLines, 1);
  assert.ok(byteLimitedRangeRead.result._meta.savedBytes > 0);
  assert.match(byteLimitedRangeRead.result.content[0].text, /^x+/);

  const scanLimitedRangeRead = await request("tools/call", {
    name: "read",
    arguments: { path: scanLimitedRangeFile, fromLine: 2, toLine: 2, maxLines: 20 },
  });
  assert.equal(scanLimitedRangeRead.result._meta.truncated, true);
  assert.equal(scanLimitedRangeRead.result._meta.scanLimited, true);
  assert.equal(scanLimitedRangeRead.result._meta.returnedLines, 0);

  const scanLimitedReadMany = await request("tools/call", {
    name: "read",
    arguments: { path: scanLimitedRangeFile, paths: [dashFile], fromLine: 2, toLine: 2, maxLinesPerFile: 20, maxTotalBytes: 4096 },
  });
  assert.equal(scanLimitedReadMany.result._meta.files[0].scanLimited, true);
  assert.equal(scanLimitedReadMany.result._meta.files[0].returnedLines, 0);
  assert.equal(typeof scanLimitedReadMany.result._meta.files[0].scannedBytes, "number");
  assert.equal(scanLimitedReadMany.result._meta.files[1].scanLimited, undefined);

  const newlineLimitedRangeRead = await request("tools/call", {
    name: "read",
    arguments: { path: manyByteLinesFile, fromLine: 1, toLine: 500, maxLines: 500 },
  });
  assert.equal(newlineLimitedRangeRead.result._meta.truncated, true);
  assert.equal(newlineLimitedRangeRead.result._meta.fileReadLimited, true);
  assert.ok(newlineLimitedRangeRead.result._meta.returnedBytes <= 2048);
  assert.ok(Buffer.byteLength(newlineLimitedRangeRead.result.content[0].text, "utf8") <= 2048);

  const invalidRangeRead = await request("tools/call", {
    name: "read",
    arguments: { path: largeFile, fromLine: 5, toLine: 1 },
  });
  assert.equal(invalidRangeRead.error.code, -32602);
  assert.match(invalidRangeRead.error.message, /toLine must be greater/);

  const invalidRangeTypeRead = await request("tools/call", {
    name: "read",
    arguments: { path: largeFile, fromLine: "1" },
  });
  assert.equal(invalidRangeTypeRead.error.code, -32602);
  assert.match(invalidRangeTypeRead.error.message, /fromLine must be an integer/);

  const largerRangeRead = await request("tools/call", {
    name: "read",
    arguments: { path: manyShortLinesFile, fromLine: 1, toLine: 300, maxLines: 500 },
  });
  assert.equal(largerRangeRead.result._meta.truncated, false);
  assert.equal(largerRangeRead.result._meta.returnedLines, 300);

  const invalidReadMaxLines = await request("tools/call", {
    name: "read",
    arguments: { path: largeFile, maxLines: 201 },
  });
  assert.ok(invalidReadMaxLines.result, JSON.stringify(invalidReadMaxLines));

  const invalidReadMaxLinesTooHigh = await request("tools/call", {
    name: "read",
    arguments: { path: largeFile, maxLines: 501 },
  });
  assert.equal(invalidReadMaxLinesTooHigh.error.code, -32602);
  assert.match(invalidReadMaxLinesTooHigh.error.message, /maxLines must be between 10 and 500/);

  const invalidReadMaxBytes = await request("tools/call", {
    name: "read",
    arguments: { path: largeFile, maxBytes: 1023 },
  });
  assert.equal(invalidReadMaxBytes.error.code, -32602);
  assert.match(invalidReadMaxBytes.error.message, /maxBytes must be between 1024/);

  const rgPath = await findRgForTest();
  if (rgPath) {
    const searched = await request("tools/call", {
      name: "search",
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
      name: "search",
      arguments: { pattern: "-needle", path: dashFile, maxMatches: 5 },
    });
    assert.ok(dashPattern.result, JSON.stringify(dashPattern));
    assert.match(dashPattern.result.content[0].text, /-needle/);

    const grepContext = await request("tools/call", {
      name: "search",
      arguments: { pattern: "file line 29", path: largeFile, contextLines: 1, maxMatches: 3 },
    });
    assert.ok(grepContext.result, JSON.stringify(grepContext));
    assert.match(grepContext.result.content[0].text, /file line 29/);
    assert.equal(typeof grepContext.result._meta.rgPath, "string");

    const byteLimitedSearch = await request("tools/call", {
      name: "search",
      arguments: { pattern: "x", path: hugeRangeFile, maxMatches: 5, maxLines: 20, maxBytes: 1024 },
    });
    assert.ok(byteLimitedSearch.result, JSON.stringify(byteLimitedSearch));
    assert.equal(byteLimitedSearch.result._meta.truncated, true);
    assert.ok(byteLimitedSearch.result._meta.returnedBytes <= 1024);

    const noMatchSearch = await request("tools/call", {
      name: "search",
      arguments: { pattern: "does-not-exist", path: largeFile, maxMatches: 5 },
    });
    assert.equal(noMatchSearch.result.content[0].text, "(no matches)");
    assert.equal(noMatchSearch.result._meta.totalBytes, noMatchSearch.result._meta.returnedBytes);

    const noMatchGrepContext = await request("tools/call", {
      name: "search",
      arguments: { pattern: "does-not-exist", path: largeFile, maxMatches: 5 },
    });
    assert.equal(noMatchGrepContext.result.content[0].text, "(no matches)");
    assert.equal(noMatchGrepContext.result._meta.totalBytes, noMatchGrepContext.result._meta.returnedBytes);
  }

  const invalidSearchMaxMatches = await request("tools/call", {
    name: "search",
    arguments: { pattern: "anything", maxMatches: 0 },
  });
  assert.equal(invalidSearchMaxMatches.error.code, -32602);
  assert.match(invalidSearchMaxMatches.error.message, /maxMatches must be between 1 and 1000/);

  const invalidSearchMaxBytes = await request("tools/call", {
    name: "search",
    arguments: { pattern: "anything", maxBytes: MAX_BYTES + 1 },
  });
  assert.equal(invalidSearchMaxBytes.error.code, -32602);
  assert.match(invalidSearchMaxBytes.error.message, /maxBytes must be between 1024/);

  const missingRgRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    const { callTool } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "src", "tools.js")).href)});
    let payload;
    try {
      await callTool('search', { pattern: 'needle', path: '.' });
      payload = { ok: true };
    } catch (error) {
      payload = { ok: false, code: error.code, message: error.message };
    }
    console.log(JSON.stringify(payload));
  `], {
    cwd: tempDir,
    timeout: 5_000,
    env: {
      ...process.env,
      PATH: "",
      Path: "",
      HOME: join(tempDir, "missing-rg-home"),
      USERPROFILE: join(tempDir, "missing-rg-home"),
      SIMPLE_CONTEXT_LIMITER_RG_PATH: "",
    },
  });
  assert.equal(missingRgRun.code, 0, missingRgRun.stderr);
  const missingRgPayload = JSON.parse(missingRgRun.stdout.trim());
  assert.equal(missingRgPayload.ok, false);
  assert.equal(missingRgPayload.code, -32000);
  assert.match(missingRgPayload.message, /ripgrep was not found/);

  const missingAstLanguage = await request("tools/call", {
    name: "search",
    arguments: { engine: "ast", pattern: "assert.equal($A, $B)", path: "smoke-test.js" },
  });
  assert.equal(missingAstLanguage.error.code, -32602);
  assert.match(missingAstLanguage.error.message, /language is required/);

  const astGrepPath = await findAstGrepForTest();
  if (astGrepPath) {
    const astSearch = await request("tools/call", {
      name: "search",
      arguments: { engine: "ast", pattern: "assert.equal($A, $B)", language: "javascript", path: "smoke-test.js", maxMatches: 5 },
    });
    assert.ok(astSearch.result, JSON.stringify(astSearch));
    assert.equal(astSearch.result._meta.engine, "ast");
    assert.equal(astSearch.result._meta.language, "javascript");
    assert.equal(astSearch.result._meta.shownMatches, 5);
    assert.match(astSearch.result.content[0].text, /smoke-test\.js:/);
    assert.match(astSearch.result.content[0].text, /assert\.equal/);

    const astNoMatches = await request("tools/call", {
      name: "search",
      arguments: { engine: "ast", pattern: "definitelyNoSuchCall($A)", language: "javascript", path: "smoke-test.js", maxMatches: 5 },
    });
    assert.equal(astNoMatches.result.content[0].text, "(no matches)");
    assert.equal(astNoMatches.result._meta.engine, "ast");
    assert.equal(astNoMatches.result._meta.shownMatches, 0);
  }

  const missingAstGrepRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    const { callTool } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "src", "tools.js")).href)});
    let payload;
    try {
      await callTool('search', { engine: 'ast', pattern: 'foo($A)', language: 'javascript', path: '.' });
      payload = { ok: true };
    } catch (error) {
      payload = { ok: false, code: error.code, message: error.message };
    }
    console.log(JSON.stringify(payload));
  `], {
    cwd: tempDir,
    timeout: 5_000,
    env: {
      ...process.env,
      PATH: "",
      Path: "",
      HOME: join(tempDir, "missing-ast-home"),
      USERPROFILE: join(tempDir, "missing-ast-home"),
      SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH: "",
    },
  });
  assert.equal(missingAstGrepRun.code, 0, missingAstGrepRun.stderr);
  const missingAstPayload = JSON.parse(missingAstGrepRun.stdout.trim());
  assert.equal(missingAstPayload.ok, false);
  assert.equal(missingAstPayload.code, -32000);
  assert.match(missingAstPayload.message, /ast-grep was not found/);

  const html = `<html><body>${Array.from({ length: 300 }, (_, i) => `<p>line ${i}</p>`).join("")}</body></html>`;
  const fetched = await request("tools/call", {
    name: "fetch",
    arguments: { url: `data:text/html,${encodeURIComponent(html)}`, force: true, maxLines: 20 },
  });
  assert.ok(fetched.result, JSON.stringify(fetched));
  assert.equal(fetched.result._meta.truncated, true);
  assertSavingsMeta(fetched.result._meta);
  assert.ok(fetched.result._meta.savedBytes > 0);
  assert.equal(fetched.result._meta.downloadLimited, true);
  assert.match(fetched.result.content[0].text, /lines omitted/);

  const fetchedAgain = await request("tools/call", {
    name: "fetch",
    arguments: { url: `data:text/html,${encodeURIComponent(html)}`, maxLines: 20 },
  });
  assert.equal(fetchedAgain.result._meta.cached, false);
  assert.equal(fetchedAgain.result._meta.downloadLimited, true);

  const entityFetch = await request("tools/call", {
    name: "fetch",
    arguments: { url: `data:text/html,${encodeURIComponent("<p>A&#8212;B &#x2014; C</p>")}`, force: true, maxLines: 20 },
  });
  assert.match(entityFetch.result.content[0].text, /A.B . C/s);
  assert.doesNotMatch(entityFetch.result.content[0].text, /&#/);

  const invalidForce = await request("tools/call", {
    name: "fetch",
    arguments: { url: "data:text/plain,ok", force: "false" },
  });
  assert.equal(invalidForce.error.code, -32602);
  assert.match(invalidForce.error.message, /force must be a boolean/);

  const invalidFetchMaxLines = await request("tools/call", {
    name: "fetch",
    arguments: { url: "data:text/plain,ok", maxLines: "20" },
  });
  assert.equal(invalidFetchMaxLines.error.code, -32602);
  assert.match(invalidFetchMaxLines.error.message, /maxLines must be an integer/);

  const invalidFetchMaxBytes = await request("tools/call", {
    name: "fetch",
    arguments: { url: "data:text/plain,ok", maxBytes: "1024" },
  });
  assert.equal(invalidFetchMaxBytes.error.code, -32602);
  assert.match(invalidFetchMaxBytes.error.message, /maxBytes must be an integer/);

  const invalidFetchUrl = await request("tools/call", {
    name: "fetch",
    arguments: { url: "not a url" },
  });
  assert.equal(invalidFetchUrl.error.code, -32602);
  assert.match(invalidFetchUrl.error.message, /valid URL/);

  const blockedProtocolRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    const { callTool } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "src", "tools.js")).href)});
    let payload;
    try {
      await callTool('fetch', { url: 'data:text/plain,ok' });
      payload = { ok: true };
    } catch (error) {
      payload = { ok: false, code: error.code, message: error.message };
    }
    console.log(JSON.stringify(payload));
  `], {
    cwd: import.meta.dirname,
    timeout: 5_000,
    env: {
      ...process.env,
      SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH: "",
      HOME: join(tempDir, "blocked-protocol-home"),
      USERPROFILE: join(tempDir, "blocked-protocol-home"),
    },
  });
  assert.equal(blockedProtocolRun.code, 0, blockedProtocolRun.stderr);
  const blockedProtocolPayload = JSON.parse(blockedProtocolRun.stdout.trim());
  assert.equal(blockedProtocolPayload.ok, false);
  assert.equal(blockedProtocolPayload.code, -32602);
  assert.match(blockedProtocolPayload.message, /only allows http and https/);

  const limitedFetch = await request("tools/call", {
    name: "fetch",
    arguments: { url: `data:text/plain,${encodeURIComponent("🙂".repeat(2048))}`, force: true, maxLines: 20 },
  });
  assert.equal(limitedFetch.result._meta.downloadLimited, true);
  assert.equal(limitedFetch.result._meta.truncated, true);
  assert.doesNotMatch(limitedFetch.result.content[0].text, /�/);

  const cacheUrl = `data:text/plain,${encodeURIComponent(`cache-${Date.now()}`)}`;
  const uncachedFetch = await request("tools/call", {
    name: "fetch",
    arguments: { url: cacheUrl, force: true },
  });
  assert.equal(uncachedFetch.result._meta.cached, false);
  assertSavingsMeta(uncachedFetch.result._meta);
  const cachedFetch = await request("tools/call", {
    name: "fetch",
    arguments: { url: cacheUrl },
  });
  assert.equal(cachedFetch.result._meta.cached, true);

  const cacheRace = await runProcess(process.execPath, ["--input-type=module", "-e", `
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const { callTool } = await import('./src/tools.js');
    const urls = Array.from({ length: 20 }, (_, i) => 'data:text/plain,' + encodeURIComponent('cache-race-' + i));
    await Promise.all(urls.map((url) => callTool('fetch', { url, force: true })));
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
    const first = await callTool('fetch', { url: one, force: true });
    const second = await callTool('fetch', { url: two, force: true });
    const firstAgain = await callTool('fetch', { url: one });
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
    await writeFile(join(gitDir, "untracked.txt"), "new\n", "utf8");

    const diffRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
      const { callTool } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "src", "tools.js")).href)});
      const diff = await callTool('diff', { maxFiles: 1, maxHunks: 1, maxBytes: 4096 });
      const blankPathDiff = await callTool('diff', { path: '', maxBytes: 4096 });
      const changedFiles = await callTool('diff', { mode: 'status', maxBytes: 4096 });
      const history = await callTool('diff', { mode: 'history', maxFiles: 5, maxBytes: 4096 });
      const noStagedStatus = await callTool('diff', { mode: 'status', staged: true, maxBytes: 4096 });
      const noStagedDiff = await callTool('diff', { staged: true, maxBytes: 4096 });
      console.log(JSON.stringify({ diff: { text: diff.content[0].text, meta: diff._meta }, blankPathDiff: { text: blankPathDiff.content[0].text, meta: blankPathDiff._meta }, changedFiles: { text: changedFiles.content[0].text, meta: changedFiles._meta }, history: { text: history.content[0].text, meta: history._meta }, noStagedStatus: { text: noStagedStatus.content[0].text, meta: noStagedStatus._meta }, noStagedDiff: { text: noStagedDiff.content[0].text, meta: noStagedDiff._meta } }));
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
    assert.doesNotMatch(diffPayload.changedFiles.text, /untracked\.txt/);
    assert.equal(diffPayload.changedFiles.meta.changedFiles, 2);
    assert.equal(diffPayload.changedFiles.meta.staged, false);
    assert.match(diffPayload.history.text, /Commit history:/);
    assert.match(diffPayload.history.text, /Subject: initial/);
    assert.match(diffPayload.history.text, /a\.txt/);
    assert.equal(diffPayload.history.meta.mode, "history");
    assert.equal(diffPayload.history.meta.commitsShown, 1);
    assert.equal(diffPayload.history.meta.maxCommits, 5);
    assert.equal(diffPayload.noStagedStatus.text, "(no changed files)");
    assert.equal(diffPayload.noStagedStatus.meta.staged, true);
    assert.equal(diffPayload.noStagedStatus.meta.changedFiles, 0);
    assert.equal(diffPayload.noStagedDiff.text, "(no diff)");
    assert.equal(diffPayload.noStagedDiff.meta.staged, true);
    assert.equal(diffPayload.noStagedDiff.meta.truncated, false);

    await git(["add", "a.txt"]);
    const stagedStatusRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
      const { callTool } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "src", "tools.js")).href)});
      const status = await callTool('diff', { mode: 'status', staged: true, maxBytes: 4096 });
      const unstagedStatus = await callTool('diff', { mode: 'status', staged: false, maxBytes: 4096 });
      console.log(JSON.stringify({ staged: { text: status.content[0].text, meta: status._meta }, unstaged: { text: unstagedStatus.content[0].text, meta: unstagedStatus._meta } }));
    `], {
      cwd: gitDir,
      timeout: 5_000,
      env: {
        ...process.env,
        HOME: join(tempDir, "diff-home"),
        USERPROFILE: join(tempDir, "diff-home"),
      },
    });
    assert.equal(stagedStatusRun.code, 0, stagedStatusRun.stderr);
    const stagedStatusPayload = JSON.parse(stagedStatusRun.stdout.trim());
    assert.match(stagedStatusPayload.staged.text, /a\.txt/);
    assert.doesNotMatch(stagedStatusPayload.staged.text, /b\.txt/);
    assert.doesNotMatch(stagedStatusPayload.staged.text, /untracked\.txt/);
    assert.equal(stagedStatusPayload.staged.meta.staged, true);
    assert.equal(stagedStatusPayload.staged.meta.changedFiles, 1);
    assert.match(stagedStatusPayload.unstaged.text, /b\.txt/);
    assert.doesNotMatch(stagedStatusPayload.unstaged.text, /a\.txt/);
    assert.doesNotMatch(stagedStatusPayload.unstaged.text, /untracked\.txt/);
    assert.equal(stagedStatusPayload.unstaged.meta.staged, false);
    assert.equal(stagedStatusPayload.unstaged.meta.changedFiles, 1);
  }

  const statsRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    const { callTool } = await import('./src/tools.js');
    await callTool('run', { command: ${JSON.stringify(`${shellQuote(process.execPath)} -e "console.log('x'.repeat(50000))"`)}, maxLines: 20 });
    await callTool('run', { command: ${JSON.stringify(`${shellQuote(process.execPath)} -e "console.log('ok')"`)}, maxLines: 20 });
    await callTool('fetch', { url: 'data:text/plain,' + encodeURIComponent('x'.repeat(2048)), force: true, maxLines: 20 });
    const stats = await callTool('usage', {});
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
  assert.match(statsPayload.text, /run: 2 calls/);
  assert.match(statsPayload.text, /fetch: 1 calls/);
  const parsedStats = statsPayload.meta;
  assert.equal(parsedStats.project, import.meta.dirname);
  assert.equal(parsedStats.calls, 3);
  assert.equal(parsedStats.byTool.run.calls, 2);
  assert.equal(parsedStats.byTool.fetch.calls, 1);
  assert.ok(parsedStats.returnedBytes <= parsedStats.totalBytes);
  assert.ok(parsedStats.byTool.run.returnedBytes <= parsedStats.byTool.run.totalBytes);
  assert.equal(typeof parsedStats.responseTotalBytes, "number");
  assert.equal(typeof parsedStats.responseReturnedBytes, "number");
  assert.equal(typeof parsedStats.responseSavedBytes, "number");
  assert.equal(typeof parsedStats.responseSavedPercent, "number");
  assert.equal(typeof parsedStats.responseEstimatedTokensSaved, "number");
  assert.ok(parsedStats.responseReturnedBytes <= parsedStats.responseTotalBytes);
  assert.ok(parsedStats.savedBytes > 0);
  assert.ok(parsedStats.estimatedTokensSaved > 0);

  const statsProjectRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const { callTool } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "src", "tools.js")).href)});
    await callTool('discover', { mode: 'tree', path: '.', maxDepth: 1, maxEntries: 10 });
    let projects = [];
    let usageExists = false;
    try {
      const stats = JSON.parse(await readFile(join(process.env.HOME, '.simple-context-limiter', 'stats.json'), 'utf8'));
      projects = Object.keys(stats.projects);
    } catch {}
    try { await readFile(join(process.env.HOME, '.simple-context-limiter', 'usage.jsonl'), 'utf8'); usageExists = true; } catch {}
    const report = await callTool('usage', { mode: 'report' });
    console.log(JSON.stringify({ projects, usageExists, reportText: report.content[0].text, reportMeta: report._meta }));
  `], {
    cwd: fallbackFilesDir,
    timeout: 5_000,
    env: {
      ...process.env,
      HOME: join(tempDir, "stats-project-home"),
      USERPROFILE: join(tempDir, "stats-project-home"),
    },
  });
  assert.equal(statsProjectRun.code, 0, statsProjectRun.stderr);
  const statsProjectPayload = JSON.parse(statsProjectRun.stdout.trim());
  assert.deepEqual(statsProjectPayload.projects, []);
  assert.equal(statsProjectPayload.usageExists, false);
  assert.match(statsProjectPayload.reportText, /markerless temp directory/);
  assert.equal(statsProjectPayload.reportMeta.ignoredProject, true);

  const usageRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const { callTool } = await import('./src/tools.js');
    for (let i = 0; i < 3; i++) {
      try { await callTool('run', { command: 'git log --oneline -1', maxLines: 20 }); } catch {}
    }
    await callTool('run', { command: ${JSON.stringify(isPowerShellConfigured() ? `& ${shellQuote(process.execPath)} -e "console.log('x'.repeat(50000))"` : `${shellQuote(process.execPath)} -e "console.log('x'.repeat(50000))"`)}, maxLines: 20 });
    const report = await callTool('usage', { mode: 'report', maxEvents: 20 });
    const guidance = await callTool('usage', { mode: 'guidance', maxEvents: 20 });
    const usageLog = await readFile(join(process.env.HOME, '.simple-context-limiter', 'usage.jsonl'), 'utf8');
    console.log(JSON.stringify({ text: report.content[0].text, guidance: guidance.content[0].text, meta: report._meta, guidanceMeta: guidance._meta, usageLog }));
  `], {
    cwd: import.meta.dirname,
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: join(tempDir, "usage-home"),
      USERPROFILE: join(tempDir, "usage-home"),
      SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "1",
    },
  });
  assert.equal(usageRun.code, 0, usageRun.stderr);
  const usagePayload = JSON.parse(usageRun.stdout.trim());
  assert.match(usagePayload.text, /Usage summary/);
  assert.match(usagePayload.text, /run:/);
  assert.match(usagePayload.text, /git-history:/);
  assert.match(usagePayload.text, /diff mode=history:/);
  assert.match(usagePayload.guidance, /Usage guidance/);
  assert.match(usagePayload.guidance, /diff mode=history:/);
  assert.equal(usagePayload.guidanceMeta.mode, "guidance");
  assert.equal(usagePayload.meta.loggingEnabled, true);
  assert.equal(usagePayload.meta.byCommandKind.some((entry) => entry.name === "git-history"), true);
  assert.equal(usagePayload.usageLog.includes("git log --oneline"), false);

  const usageProjectScopeRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const { callTool } = await import('./src/tools.js');
    const logDir = join(process.env.HOME, '.simple-context-limiter');
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, 'usage.jsonl'), JSON.stringify({
      ts: Date.now(),
      project: 'C:/other-project',
      tool: 'run',
      durationMs: 1,
      ok: true,
      truncated: true,
      totalBytes: 10000,
      returnedBytes: 100,
      savedBytes: 9900,
      commandKind: 'git-history',
    }) + '\\n', 'utf8');
    const report = await callTool('usage', { mode: 'report', maxEvents: 20 });
    console.log(JSON.stringify({ text: report.content[0].text, meta: report._meta }));
  `], {
    cwd: import.meta.dirname,
    timeout: 5_000,
    env: {
      ...process.env,
      HOME: join(tempDir, "usage-project-scope-home"),
      USERPROFILE: join(tempDir, "usage-project-scope-home"),
      SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "1",
    },
  });
  assert.equal(usageProjectScopeRun.code, 0, usageProjectScopeRun.stderr);
  const usageProjectScopePayload = JSON.parse(usageProjectScopeRun.stdout.trim());
  assert.match(usageProjectScopePayload.text, /No usage events found yet/);
  assert.doesNotMatch(usageProjectScopePayload.text, /git-history/);
  assert.equal(usageProjectScopePayload.meta.eventsRead, 1);
  assert.equal(usageProjectScopePayload.meta.projectEventsRead, 0);
  assert.equal(usageProjectScopePayload.meta.eventsAnalyzed, 0);

  const usagePruneRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    import { readFile, stat } from 'node:fs/promises';
    import { join } from 'node:path';
    const { callTool } = await import('./src/tools.js');
    const command = ${JSON.stringify(isPowerShellConfigured() ? `& ${shellQuote(process.execPath)} -e "console.log('ok')"` : `${shellQuote(process.execPath)} -e "console.log('ok')"`)};
    for (let i = 0; i < 40; i++) await callTool('run', { command });
    const file = join(process.env.HOME, '.simple-context-limiter', 'usage.jsonl');
    const fileStat = await stat(file);
    const text = await readFile(file, 'utf8');
    const valid = text.split(String.fromCharCode(10)).filter(Boolean).every((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    console.log(JSON.stringify({ size: fileStat.size, valid }));
  `], {
    cwd: import.meta.dirname,
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: join(tempDir, "usage-prune-home"),
      USERPROFILE: join(tempDir, "usage-prune-home"),
      SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "1",
      SIMPLE_CONTEXT_LIMITER_USAGE_LOG_MAX_BYTES: "2048",
    },
  });
  assert.equal(usagePruneRun.code, 0, usagePruneRun.stderr);
  const usagePrunePayload = JSON.parse(usagePruneRun.stdout.trim());
  assert.ok(usagePrunePayload.size <= 2048);
  assert.equal(usagePrunePayload.valid, true);

  const usageOptOutRun = await runProcess(process.execPath, ["--input-type=module", "-e", `
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const { callTool } = await import('./src/tools.js');
    await callTool('run', { command: ${JSON.stringify(isPowerShellConfigured() ? `& ${shellQuote(process.execPath)} -e "console.log('ok')"` : `${shellQuote(process.execPath)} -e "console.log('ok')"`)} });
    try { await readFile(join(process.env.HOME, '.simple-context-limiter', 'usage.jsonl'), 'utf8'); console.log('exists'); } catch { console.log('missing'); }
  `], {
    cwd: import.meta.dirname,
    timeout: 5_000,
    env: {
      ...process.env,
      HOME: join(tempDir, "usage-disabled-home"),
      USERPROFILE: join(tempDir, "usage-disabled-home"),
      SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "0",
    },
  });
  assert.equal(usageOptOutRun.code, 0, usageOptOutRun.stderr);
  assert.equal(usageOptOutRun.stdout.trim(), "missing");

  let streamingErrorClosed = false;
  let resolveStreamingErrorClosed;
  const streamingErrorClosedPromise = new Promise((resolve) => {
    resolveStreamingErrorClosed = resolve;
  });
  httpServer = createServer((req, res) => {
    if (req.url === "/large") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(50000));
      return;
    }

    if (req.url === "/stream-error") {
      res.writeHead(500, { "content-type": "text/plain" });
      let chunks = 0;
      const interval = setInterval(() => {
        chunks++;
        if (chunks > 1_000) {
          clearInterval(interval);
          res.end();
          return;
        }
        res.write("x".repeat(1024));
      }, 10);
      res.on("close", () => {
        streamingErrorClosed = true;
        clearInterval(interval);
        resolveStreamingErrorClosed();
      });
      return;
    }

    res.writeHead(418, { "content-type": "text/plain" });
    res.end("teapot");
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const byteLimitedFetch = await callTool("fetch", { url: `http://127.0.0.1:${port}/large`, force: true, maxLines: 20, maxBytes: 1024 });
  assert.equal(byteLimitedFetch._meta.truncated, true);
  assert.ok(byteLimitedFetch._meta.returnedBytes <= 1024);
  try {
    await callTool("fetch", { url: `http://127.0.0.1:${port}/missing`, force: true });
    assert.fail("expected fetch to reject HTTP errors");
  } catch (error) {
    const data = errorData(error);
    assert.equal(error.code, -32000);
    assert.equal(data.httpStatus, 418);
    assert.equal(data.httpStatusText, "I'm a Teapot");
    assert.match(data.url, /127\.0\.0\.1/);
  }
  try {
    await callTool("fetch", { url: `http://127.0.0.1:${port}/stream-error`, force: true });
    assert.fail("expected fetch to reject streaming HTTP errors");
  } catch (error) {
    const data = errorData(error);
    assert.equal(error.code, -32000);
    assert.equal(data.httpStatus, 500);
  }
  await Promise.race([
    streamingErrorClosedPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for streaming error body cleanup")), 1_000)),
  ]);
  assert.equal(streamingErrorClosed, true);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const error = new Error("network unavailable");
      error.code = "ETEST";
      throw error;
    };
    await callTool("fetch", { url: "https://example.test/unavailable", force: true });
    assert.fail("expected fetch to include URL for network errors");
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
