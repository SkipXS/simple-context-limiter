process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { execFile } = await import("node:child_process");
const { createHash } = await import("node:crypto");
const { describe, it } = await import("node:test");
const { pathToFileURL } = await import("node:url");

await describe("strict environment policies", async () => {
  await it("can disable command-executing tools", async () => {
    const output = await execNode(`
      const { callTool } = await import("./src/tools.js");
      const results = [];
      for (const name of ["sc-run", "sc-logs"]) {
        try {
          await callTool(name, { command: "node --version" });
          results.push({ name, ok: true });
        } catch (error) {
          results.push({ name, ok: false, code: error.code, message: error.message });
        }
      }
      process.stdout.write(JSON.stringify(results));
    `, { SIMPLE_CONTEXT_LIMITER_DISABLE_COMMAND_TOOLS: "1" });

    const results = JSON.parse(output);
    assert.deepEqual(results.map((entry) => entry.ok), [false, false]);
    assert.ok(results.every((entry) => entry.code === -32602));
    assert.ok(results.every((entry) => /disabled/.test(entry.message)));
  });

  await it("enforces a coarse command allowlist for run and logs", async () => {
    const allowedCommand = `${shellQuote(process.execPath)} --version`;
    const blockedCommand = `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('blocked')")}`;
    const output = await execNode(`
      const { callTool } = await import("./src/tools.js");
      const allowedRun = await callTool("sc-run", { command: ${JSON.stringify(allowedCommand)} });
      const allowedLogs = await callTool("sc-logs", { command: ${JSON.stringify(allowedCommand)} });
      let blocked;
      try {
        await callTool("sc-run", { command: ${JSON.stringify(blockedCommand)} });
        blocked = { ok: true };
      } catch (error) {
        blocked = { ok: false, code: error.code, message: error.message };
      }
      process.stdout.write(JSON.stringify({ allowedRun: allowedRun.content[0].text, allowedLogs: allowedLogs.content[0].text, blocked }));
    `, { SIMPLE_CONTEXT_LIMITER_COMMAND_ALLOWLIST: allowedCommand });

    const result = JSON.parse(output);
    assert.match(result.allowedRun, /^v?\d+\.\d+\.\d+/);
    assert.match(result.allowedLogs, /Command exit 0/);
    assert.equal(result.blocked.ok, false);
    assert.equal(result.blocked.code, -32602);
    assert.match(result.blocked.message, /COMMAND_ALLOWLIST/);
  });

  await it("does not treat allowlist entries as shell prefixes", async () => {
    const allowedCommand = `${shellQuote(process.execPath)} --version`;
    const chainedCommand = `${allowedCommand} && ${shellQuote(process.execPath)} --version`;
    const output = await execNode(`
      const { callTool } = await import("./src/tools.js");
      try {
        await callTool("sc-run", { command: ${JSON.stringify(chainedCommand)} });
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
      }
    `, { SIMPLE_CONTEXT_LIMITER_COMMAND_ALLOWLIST: allowedCommand });

    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.equal(result.code, -32602);
    assert.match(result.message, /COMMAND_ALLOWLIST/);
  });

  await it("blocks cached private fetches in public-only mode even with cache opt-in", async () => {
    const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "scl-policy-fetch-home-"));
    const url = "http://127.0.0.1:1/secret";
    const key = createHash("sha256").update(url).digest("hex");
    const cacheDir = path.join(testHome, ".simple-context-limiter");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "cache.json"), JSON.stringify({
      [key]: {
        ts: Date.now(),
        content: "cached private secret",
        limited: false,
        url,
        finalUrl: url,
        status: 200,
        statusText: "OK",
        contentType: "text/plain",
        charset: "utf-8",
        htmlStripped: false,
        transformed: false,
      },
    }), "utf8");

    const output = await execNode(`
      const { callTool } = await import("./src/tools.js");
      try {
        await callTool("sc-fetch", { url: ${JSON.stringify(url)}, cache: true });
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message, url: error.url }));
      }
    `, {
      HOME: testHome,
      USERPROFILE: testHome,
      SIMPLE_CONTEXT_LIMITER_FETCH_PUBLIC_ONLY: "1",
      SIMPLE_CONTEXT_LIMITER_FETCH_CACHE: "all",
    });

    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.equal(result.code, -32602);
    assert.match(result.message, /FETCH_PUBLIC_ONLY/);
  });

  await it("blocks private fetches in public-only mode", async () => {
    const output = await execNode(`
      const { callTool } = await import("./src/tools.js");
      try {
        await callTool("sc-fetch", { url: "http://127.0.0.1:1/" });
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message, url: error.url }));
      }
    `, { SIMPLE_CONTEXT_LIMITER_FETCH_PUBLIC_ONLY: "1" });

    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.equal(result.code, -32602);
    assert.match(result.message, /FETCH_PUBLIC_ONLY/);
    assert.equal(result.url, "http://127.0.0.1:1/");
  });

  await it("blocks pathless diff when cwd is outside configured roots", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scl-policy-diff-root-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "scl-policy-diff-cwd-"));
    const toolsUrl = pathToFileURL(path.join(process.cwd(), "src", "tools.js")).href;

    const output = await execNode(`
      const { callTool } = await import(${JSON.stringify(toolsUrl)});
      try {
        await callTool("sc-diff", { mode: "status" });
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
      }
    `, { SIMPLE_CONTEXT_LIMITER_PATH_ROOTS: allowedRoot }, { cwd });

    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.equal(result.code, -32602);
    assert.match(result.message, /PATH_ROOTS/);
  });

  await it("restricts local path tools to configured roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scl-policy-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "scl-policy-outside-"));
    const insideFile = path.join(root, "inside.txt");
    const outsideFile = path.join(outside, "outside.txt");
    await fs.writeFile(insideFile, "inside\n", "utf8");
    await fs.writeFile(outsideFile, "outside\n", "utf8");

    const output = await execNode(`
      const { callTool } = await import("./src/tools.js");
      const allowed = await callTool("sc-read", { path: ${JSON.stringify(insideFile)} });
      const denied = {};
      for (const [name, args] of Object.entries({
        read: ["sc-read", { path: ${JSON.stringify(outsideFile)} }],
        search: ["sc-search", { path: ${JSON.stringify(outside)}, pattern: "outside" }],
        discover: ["sc-discover", { path: ${JSON.stringify(outside)}, mode: "tree" }],
        diff: ["sc-diff", { path: ${JSON.stringify(outsideFile)} }],
      })) {
        try {
          await callTool(args[0], args[1]);
          denied[name] = { ok: true };
        } catch (error) {
          denied[name] = { ok: false, code: error.code, message: error.message };
        }
      }
      process.stdout.write(JSON.stringify({ allowed: allowed.content[0].text, denied }));
    `, { SIMPLE_CONTEXT_LIMITER_PATH_ROOTS: root });

    const result = JSON.parse(output);
    assert.match(result.allowed, /inside/);
    for (const denied of Object.values(result.denied)) {
      assert.equal(denied.ok, false);
      assert.equal(denied.code, -32602);
      assert.match(denied.message, /PATH_ROOTS/);
    }
  });
});

async function execNode(script, env = {}, options = {}) {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "--eval", `
        process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
        process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";
        ${script}
      `],
      {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, ...env },
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function shellQuote(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replaceAll('"', '""')}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
}
