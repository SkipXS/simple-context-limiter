process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const { spawn } = await import("node:child_process");
const { once } = await import("node:events");
const { describe, it } = await import("node:test");

await describe("server backpressure", async () => {
  await it("preserves request ids when pending request lines exceed the limit", async () => {
    const server = spawn(process.execPath, ["server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "0",
        SIMPLE_CONTEXT_LIMITER_STATS: "0",
        SIMPLE_CONTEXT_LIMITER_MAX_RPC_TOOL_CONCURRENCY: "1",
        SIMPLE_CONTEXT_LIMITER_MAX_RPC_TOOL_QUEUE: "10",
        SIMPLE_CONTEXT_LIMITER_MAX_RPC_PENDING_REQUESTS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutLines = collectJsonLines(server.stdout);
    const stderr = collectText(server.stderr);

    try {
      send(server, { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2024-11-05" } });
      await waitForResponse(stdoutLines, "init");
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });
      await waitForToolsReady(server, stdoutLines, 2_000);

      send(server, {
        jsonrpc: "2.0",
        id: "slow-pending",
        method: "tools/call",
        params: {
          name: "sc-run",
          arguments: { command: "node -e \"setTimeout(() => {}, 300)\"", timeoutMs: 2_000, maxLines: 10, maxBytes: 2_000 },
        },
      });
      send(server, { jsonrpc: "2.0", id: "overloaded-list", method: "tools/list" });

      const overloaded = await waitForResponse(stdoutLines, "overloaded-list", 2_000);
      assert.equal(overloaded.error?.code, -32003);
      assert.match(overloaded.error.message, /pending request limit/i);
      assert.equal(overloaded.id, "overloaded-list");

      const slow = await waitForResponse(stdoutLines, "slow-pending", 4_000);
      assert.ok(slow.result, `slow request did not complete: ${JSON.stringify(slow)}`);
    } finally {
      server.stdin.end();
      server.kill();
      await once(server, "close").catch(() => {});
    }

    assert.doesNotMatch(stderr.text, /UnhandledPromiseRejection|uncaughtException/i);
  });

  await it("bounds queued tool calls, returns JSON-RPC overload errors, and recovers", async () => {
    const server = spawn(process.execPath, ["server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SIMPLE_CONTEXT_LIMITER_USAGE_LOG: "0",
        SIMPLE_CONTEXT_LIMITER_STATS: "0",
        SIMPLE_CONTEXT_LIMITER_MAX_RPC_TOOL_CONCURRENCY: "1",
        SIMPLE_CONTEXT_LIMITER_MAX_RPC_TOOL_QUEUE: "1",
        SIMPLE_CONTEXT_LIMITER_MAX_RPC_PENDING_REQUESTS: "20",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutLines = collectJsonLines(server.stdout);
    const stderr = collectText(server.stderr);

    try {
      send(server, { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2024-11-05" } });
      await waitForResponse(stdoutLines, "init");
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });

      for (let i = 0; i < 6; i++) {
        send(server, {
          jsonrpc: "2.0",
          id: `slow-${i}`,
          method: "tools/call",
          params: {
            name: "sc-run",
            arguments: { command: "node -e \"setTimeout(() => {}, 250)\"", timeoutMs: 2_000, maxLines: 10, maxBytes: 2_000 },
          },
        });
      }

      const responses = await waitForIds(stdoutLines, Array.from({ length: 6 }, (_, i) => `slow-${i}`), 6_000);
      const overloads = responses.filter((response) => response.error?.code === -32003);
      const successes = responses.filter((response) => response.result);

      assert.ok(overloads.length >= 1, `expected overload errors, got ${JSON.stringify(responses)}`);
      assert.ok(successes.length >= 1, `expected accepted calls to complete, got ${JSON.stringify(responses)}`);
      for (const response of overloads) {
        assert.match(response.error.message, /overloaded/i);
        assert.equal(typeof response.id, "string");
      }

      send(server, { jsonrpc: "2.0", id: "after-drain", method: "tools/list" });
      const afterDrain = await waitForResponse(stdoutLines, "after-drain", 2_000);
      assert.ok(afterDrain.result?.tools?.length > 0, `server did not recover: ${JSON.stringify(afterDrain)}`);
    } finally {
      server.stdin.end();
      server.kill();
      await once(server, "close").catch(() => {});
    }

    assert.doesNotMatch(stderr.text, /UnhandledPromiseRejection|uncaughtException/i);
  });
});

function send(server, message) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitForToolsReady(server, stdoutLines, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  for (;;) {
    const id = `ready-barrier-${attempt++}`;
    send(server, { jsonrpc: "2.0", id, method: "tools/list" });
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Timed out waiting for tools/list readiness");

    let response;
    try {
      response = await waitForResponse(stdoutLines, id, Math.min(250, remaining));
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      continue;
    }

    if (response.result?.tools?.length > 0) return response;
    if (response.error?.code !== -32003 && response.error?.code !== -32002) {
      throw new Error(`server did not initialize: ${JSON.stringify(response)}`);
    }
    if (Date.now() >= deadline) throw new Error(`server did not initialize: ${JSON.stringify(response)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
  const responses = await waitForIds(collected, [id], timeoutMs);
  return responses[0];
}

async function waitForIds(collected, ids, timeoutMs) {
  const wanted = new Set(ids);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const matches = flattenResponses(collected.lines).filter((response) => wanted.has(response.id));
    if (matches.length >= wanted.size) return matches;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for ${[...wanted].join(", ")}; saw ${JSON.stringify(collected.lines)}`);
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
