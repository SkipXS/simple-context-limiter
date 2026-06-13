process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const { spawn } = await import("node:child_process");
const { once } = await import("node:events");
const { describe, it } = await import("node:test");

await describe("server lifecycle", async () => {
  await it("responds to shutdown and exits on exit notification", async () => {
    const server = spawnServer();
    const stdoutLines = collectJsonLines(server.stdout);
    const stderr = collectText(server.stderr);

    try {
      await initialize(server, stdoutLines);

      send(server, { jsonrpc: "2.0", id: "shutdown", method: "shutdown" });
      const shutdown = await waitForResponse(stdoutLines, "shutdown", 2_000);
      assert.deepEqual(shutdown.result, null);

      send(server, { jsonrpc: "2.0", method: "notifications/exit" });
      await waitForClose(server, 2_000);
    } finally {
      cleanup(server);
    }

    assert.doesNotMatch(stderr.text, /UnhandledPromiseRejection|uncaughtException/i);
  });

  await it("exits when stdin ends", async () => {
    const server = spawnServer();
    const stdoutLines = collectJsonLines(server.stdout);
    const stderr = collectText(server.stderr);

    try {
      await initialize(server, stdoutLines);
      server.stdin.end();
      await waitForClose(server, 2_000);
    } finally {
      cleanup(server);
    }

    assert.doesNotMatch(stderr.text, /UnhandledPromiseRejection|uncaughtException/i);
  });

  await it("rejects requests after shutdown", async () => {
    const server = spawnServer();
    const stdoutLines = collectJsonLines(server.stdout);
    const stderr = collectText(server.stderr);

    try {
      await initialize(server, stdoutLines);

      send(server, { jsonrpc: "2.0", id: "shutdown", method: "shutdown" });
      const shutdown = await waitForResponse(stdoutLines, "shutdown", 2_000);
      assert.deepEqual(shutdown.result, null);

      send(server, { jsonrpc: "2.0", id: "after-shutdown", method: "tools/list" });
      const afterShutdown = await waitForResponse(stdoutLines, "after-shutdown", 500);
      assert.equal(afterShutdown.error?.code, -32000);
      assert.match(afterShutdown.error.message, /shutting down/i);
    } finally {
      cleanup(server);
      await once(server, "close").catch(() => {});
    }

    assert.doesNotMatch(stderr.text, /UnhandledPromiseRejection|uncaughtException/i);
  });

  await it("exits after SIGTERM", async () => {
    const server = spawnServer();
    const stdoutLines = collectJsonLines(server.stdout);
    const stderr = collectText(server.stderr);

    try {
      await initialize(server, stdoutLines);
      server.kill("SIGTERM");
      await waitForClose(server, 2_000);
    } finally {
      cleanup(server);
    }

    assert.doesNotMatch(stderr.text, /UnhandledPromiseRejection|uncaughtException/i);
  });
});

function spawnServer() {
  return spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "0",
      SIMPLE_CONTEXT_LIMITER_STATS: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function initialize(server, stdoutLines) {
  send(server, { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2024-11-05" } });
  await waitForResponse(stdoutLines, "init", 2_000);
  send(server, { jsonrpc: "2.0", method: "notifications/initialized" });
}

function send(server, message) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

function cleanup(server) {
  if (!server.killed) server.kill();
}

function collectJsonLines(stream) {
  const lines = [];
  const waiters = [];
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (raw.trim() === "") continue;
      lines.push(JSON.parse(raw));
    }
    while (waiters.length > 0) waiters.shift()();
  });

  return { lines, waiters };
}

function collectText(stream) {
  const result = { text: "" };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    result.text += chunk;
  });
  return result;
}

async function waitForResponse(collected, id, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const match = flattenResponses(collected.lines).find((response) => response.id === id);
    if (match) return match;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for ${id}; saw ${JSON.stringify(collected.lines)}`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, remaining);
      collected.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function waitForClose(server, timeoutMs) {
  let timer;
  await Promise.race([
    once(server, "close"),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for server close after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

function flattenResponses(lines) {
  return lines.flatMap((line) => Array.isArray(line) ? line : [line]);
}
