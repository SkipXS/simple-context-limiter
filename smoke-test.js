import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const child = spawn(process.execPath, ["server.js"], {
  cwd: import.meta.dirname,
  env: { ...process.env, MINI_SANDBOX_MAX_FETCH_BYTES: "1024", MINI_SANDBOX_MAX_READ_BYTES: "1024" },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let buffer = "";
const pending = new Map();
const unexpectedResponses = [];
let tempDir;

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
  tempDir = await mkdtemp(join(tmpdir(), "mini-sandbox-test-"));
  const largeFile = join(tempDir, "large.txt");
  await writeFile(largeFile, Array.from({ length: 300 }, (_, i) => `file line ${i}`).join("\n"), "utf8");

  const init = await request("initialize", {});
  assert.equal(init.result.serverInfo.name, "mini-sandbox");

  notification("notifications/initialized", {});
  notification("unknown/notification", {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(unexpectedResponses, []);

  const listed = await request("tools/list", {});
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["sandbox_run", "sandbox_read", "sandbox_search", "sandbox_fetch"]);

  const ok = await request("tools/call", {
    name: "sandbox_run",
    arguments: { command: `${shellQuote(process.execPath)} -e "console.log('ok')"` },
  });
  assert.equal(ok.result.content[0].text, "ok\n");
  assert.equal(ok.result._meta.truncated, false);
  assert.equal(typeof ok.result._meta.durationMs, "number");
  assert.equal(typeof ok.result._meta.shell, "string");

  if ((process.env.MINI_SANDBOX_SHELL ?? "").includes("bash")) {
    const bashOnly = await request("tools/call", {
      name: "sandbox_run",
      arguments: { command: "printf 'configured-bash-ok\\n'" },
    });
    assert.equal(bashOnly.result.content[0].text.trim(), "configured-bash-ok");
  }

  if ((process.env.MINI_SANDBOX_SHELL ?? "").toLowerCase().includes("cmd")) {
    const cmdOnly = await request("tools/call", {
      name: "sandbox_run",
      arguments: { command: "echo configured-cmd-ok" },
    });
    assert.equal(cmdOnly.result.content[0].text.trim(), "configured-cmd-ok");
  }

  const failed = await request("tools/call", {
    name: "sandbox_run",
    arguments: { command: `${shellQuote(process.execPath)} -e "process.exit(7)"` },
  });
  assert.equal(failed.error.code, -32000);
  assert.equal(failed.error.data.exitCode, 7);

  const slow = request("tools/call", {
    name: "sandbox_run",
    arguments: { command: `${shellQuote(process.execPath)} -e "setTimeout(() => console.log('slow'), 300)"` },
  });
  const listWhileRunning = await request("tools/list", {});
  assert.equal(listWhileRunning.result.tools.length, 4);
  const slowResult = await slow;
  assert.equal(slowResult.result.content[0].text, "slow\n");

  const read = await request("tools/call", {
    name: "sandbox_read",
    arguments: { path: largeFile, maxLines: 20 },
  });
  assert.equal(read.result._meta.truncated, true);
  assert.equal(read.result._meta.fileReadLimited, true);
  assert.match(read.result.content[0].text, /file line 0/);
  assert.match(read.result.content[0].text, /file line 299/);

  const rgPath = await findRgForTest();
  if (rgPath) {
    const searched = await request("tools/call", {
      name: "sandbox_search",
      arguments: { pattern: "file line 29", path: largeFile, maxMatches: 5 },
    });
    assert.ok(searched.result, JSON.stringify(searched));
    assert.match(searched.result.content[0].text, /file line 29/);
    assert.equal(typeof searched.result._meta.rgPath, "string");
  }

  const html = `<html><body>${Array.from({ length: 300 }, (_, i) => `<p>line ${i}</p>`).join("")}</body></html>`;
  const fetched = await request("tools/call", {
    name: "sandbox_fetch",
    arguments: { url: `data:text/html,${encodeURIComponent(html)}`, force: true, maxLines: 20 },
  });
  assert.ok(fetched.result, JSON.stringify(fetched));
  assert.equal(fetched.result._meta.truncated, true);
  assert.equal(fetched.result._meta.downloadLimited, true);
  assert.match(fetched.result.content[0].text, /lines omitted/);

  console.log("smoke tests passed");
} finally {
  if (typeof tempDir === "string") await rm(tempDir, { recursive: true, force: true });
  child.kill();
}
