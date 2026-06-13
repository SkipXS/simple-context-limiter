process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const { spawn } = await import("node:child_process");
const { createServer } = await import("node:http");
const { describe, it } = await import("node:test");

await describe("server tool error bounding", async () => {
  await it("bounds MCP tool error text for a long failing sc-run command", async () => {
    const server = spawnServer();
    const stdoutLines = collectJsonLines(server.stdout);

    try {
      await initialize(server, stdoutLines);
      const command = `${shellQuote(process.execPath)} --input-type=module --eval ${shellQuote("process.exit(7)")} ${"x".repeat(5_000)}`;
      send(server, {
        jsonrpc: "2.0",
        id: "long-run-error",
        method: "tools/call",
        params: { name: "sc-run", arguments: { command, maxBytes: 1024, timeoutMs: 5_000 } },
      });

      const response = await waitForResponse(stdoutLines, "long-run-error", 5_000);
      assert.equal(response.result?.isError, true);
      assert.equal(response.result._meta.exitCode, 7);
      assert.ok(Buffer.byteLength(response.result.content[0].text, "utf8") <= 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") < 8_000);
      assert.doesNotMatch(response.result.content[0].text, new RegExp(`x{${1_000}}`));
    } finally {
      cleanup(server);
    }
  });

  await it("bounds MCP tool error text and metadata for a long failing sc-fetch URL", async () => {
    const httpServer = createServer((req, res) => {
      res.statusCode = 404;
      res.statusMessage = "Not Found";
      res.end("missing");
    });
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });

    const server = spawnServer();
    const stdoutLines = collectJsonLines(server.stdout);

    try {
      await initialize(server, stdoutLines);
      const { port } = httpServer.address();
      const url = `http://127.0.0.1:${port}/${"very-long-path/".repeat(100)}`;
      send(server, {
        jsonrpc: "2.0",
        id: "long-fetch-error",
        method: "tools/call",
        params: { name: "sc-fetch", arguments: { url, maxBytes: 1024 } },
      });

      const response = await waitForResponse(stdoutLines, "long-fetch-error", 5_000);
      assert.equal(response.result?.isError, true);
      assert.equal(response.result._meta.code, -32000);
      assert.ok(Buffer.byteLength(response.result.content[0].text, "utf8") <= 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") < 8_000);
      assert.ok(response.result._meta.url.length < url.length);
      assert.doesNotMatch(JSON.stringify(response), new RegExp(`very-long-path(/very-long-path){50}`));
    } finally {
      cleanup(server);
      await new Promise((resolve) => httpServer.close(resolve));
    }
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

function flattenResponses(lines) {
  return lines.flatMap((line) => Array.isArray(line) ? line : [line]);
}

function shellQuote(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replaceAll('"', '""')}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
}
