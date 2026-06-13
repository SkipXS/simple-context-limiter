process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const tempRoot = await import("node:os").then((os) => os.tmpdir());
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { createServer } = await import("node:http");
const { execFile } = await import("node:child_process");
const assert = await import("node:assert/strict");
const { describe, it, beforeEach, afterEach } = await import("node:test");

const testHome = await fs.mkdtemp(path.join(tempRoot, "scl-fetch-home-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const { callTool } = await import("../src/tools.js");
const { fetchCacheSkipReason } = await import("../src/tools/fetch.js");
const { CACHE_FILE } = await import("../src/constants.js");

const servers = new Set();

await describe("sc-fetch", async () => {
  beforeEach(async () => {
    delete process.env.SIMPLE_CONTEXT_LIMITER_FETCH_CACHE;
    await fs.rm(path.dirname(CACHE_FILE), { recursive: true, force: true });
  });

  afterEach(async () => {
    delete process.env.SIMPLE_CONTEXT_LIMITER_FETCH_CACHE;
    await Promise.all([...servers].map((server) => closeServer(server)));
    servers.clear();
  });

  await it("bypasses persistent cache by default for literal private hosts", async () => {
    let hits = 0;
    const { url } = await startServer(() => ({
      contentType: "text/plain; charset=utf-8",
      body: `secret-${++hits}`,
    }));

    const first = await callTool("sc-fetch", { url });
    const second = await callTool("sc-fetch", { url });

    assert.equal(first._meta.cached, false);
    assert.equal(first._meta.cacheEligible, false);
    assert.equal(first._meta.cacheSkippedReason, "private_address");
    assert.equal(second._meta.cached, false);
    assert.match(second.content[0].text, /secret-2/);
    assert.deepEqual(await readCache(), {});
  });

  await it("bypasses persistent cache by default for 0.0.0.0 local URLs", async () => {
    let hits = 0;
    const { url } = await startServer(() => ({
      contentType: "text/plain; charset=utf-8",
      body: `zero-host-secret-${++hits}`,
    }), { listenHost: "0.0.0.0", urlHost: "0.0.0.0" });

    const first = await callTool("sc-fetch", { url });
    const second = await callTool("sc-fetch", { url });

    assert.equal(first._meta.cached, false);
    assert.equal(first._meta.cacheEligible, false);
    assert.equal(first._meta.cacheSkippedReason, "private_address");
    assert.equal(second._meta.cached, false);
    assert.match(second.content[0].text, /zero-host-secret-2/);
    assert.deepEqual(await readCache(), {});
  });

  await it("classifies DNS names resolving to private or special-use addresses as cache-private", async () => {
    const privateReason = await fetchCacheSkipReason("http://internal.example.test/secret", async () => [
      { address: "10.0.0.5", family: 4 },
    ]);
    const cgnatReason = await fetchCacheSkipReason("http://cgnat.example.test/", async () => [
      { address: "100.64.0.1", family: 4 },
    ]);
    const benchmarkReason = await fetchCacheSkipReason("http://benchmark.example.test/", async () => [
      { address: "198.18.0.1", family: 4 },
    ]);
    const documentationReason = await fetchCacheSkipReason("http://docs.example.test/", async () => [
      { address: "192.0.2.1", family: 4 },
    ]);
    const publicReason = await fetchCacheSkipReason("http://public.example.test/", async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    const unresolvedReason = await fetchCacheSkipReason("http://missing.example.test/", async () => {
      const error = new Error("not found");
      error.code = "ENOTFOUND";
      throw error;
    });

    assert.equal(privateReason, "private_address");
    assert.equal(cgnatReason, "private_address");
    assert.equal(benchmarkReason, "private_address");
    assert.equal(documentationReason, "private_address");
    assert.equal(publicReason, undefined);
    assert.equal(unresolvedReason, "unresolved_host");
  });

  await it("supports explicit and environment cache opt-in for private literal hosts", async () => {
    let hits = 0;
    const { url } = await startServer(() => ({
      contentType: "text/plain; charset=utf-8",
      body: `cached-secret-${++hits}`,
    }));

    const first = await callTool("sc-fetch", { url, cache: true });
    const second = await callTool("sc-fetch", { url, cache: true });

    assert.equal(first._meta.cacheEligible, true);
    assert.equal(second._meta.cached, true);
    assert.match(second.content[0].text, /cached-secret-1/);
    assert.equal(hits, 1);

    let envHits = 0;
    const envServer = await startServer(() => ({
      contentType: "text/plain; charset=utf-8",
      body: `env-cached-secret-${++envHits}`,
    }));
    process.env.SIMPLE_CONTEXT_LIMITER_FETCH_CACHE = "all";
    const envFirst = await callTool("sc-fetch", { url: envServer.url });
    const envSecond = await callTool("sc-fetch", { url: envServer.url });

    assert.equal(envFirst._meta.cacheEligible, true);
    assert.equal(envSecond._meta.cached, true);
    assert.match(envSecond.content[0].text, /env-cached-secret-1/);
    assert.equal(envHits, 1);
  });

  await it("supports cache opt-out independent of force", async () => {
    let hits = 0;
    const { url } = await startServer(() => ({
      contentType: "text/plain; charset=utf-8",
      body: `fresh-${++hits}`,
    }));

    await callTool("sc-fetch", { url, cache: true });
    const refreshed = await callTool("sc-fetch", { url, force: true, cache: true });
    const cachedRefresh = await callTool("sc-fetch", { url, cache: true });
    const uncached = await callTool("sc-fetch", { url, cache: false });

    assert.equal(refreshed._meta.cached, false);
    assert.match(refreshed.content[0].text, /fresh-2/);
    assert.equal(cachedRefresh._meta.cached, true);
    assert.match(cachedRefresh.content[0].text, /fresh-2/);
    assert.equal(uncached._meta.cached, false);
    assert.equal(uncached._meta.cacheSkippedReason, "per_call_disabled");
    assert.match(uncached.content[0].text, /fresh-3/);
  });

  await it("rejects non-text/binary content types without returning garbage text", async () => {
    const { url } = await startServer(() => ({
      contentType: "application/octet-stream",
      body: Buffer.from([0, 159, 146, 150]),
    }));

    await assert.rejects(
      () => callTool("sc-fetch", { url }),
      /non-text content/i,
    );
    assert.deepEqual(await readCache(), {});
  });

  await it("decodes declared charsets and defaults to UTF-8 text", async () => {
    const latin1 = await startServer(() => ({
      contentType: "text/plain; charset=iso-8859-1",
      body: Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    }));
    const utf8 = await startServer(() => ({
      contentType: "text/plain",
      body: Buffer.from("snowman ☃", "utf8"),
    }));

    const latin1Result = await callTool("sc-fetch", { url: latin1.url });
    const utf8Result = await callTool("sc-fetch", { url: utf8.url });

    assert.match(latin1Result.content[0].text, /café/);
    assert.equal(latin1Result._meta.charset, "iso-8859-1");
    assert.match(utf8Result.content[0].text, /snowman ☃/);
    assert.equal(utf8Result._meta.charset, "utf-8");
  });

  await it("rejects unsupported declared charsets", async () => {
    const { url } = await startServer(() => ({
      contentType: "text/plain; charset=x-unsupported-test-charset",
      body: "ok",
    }));

    await assert.rejects(
      () => callTool("sc-fetch", { url }),
      /Unsupported response charset/i,
    );
  });

  await it("trims an incomplete UTF-8 lead byte at the download cap", async () => {
    const { url } = await startServer(() => ({
      contentType: "text/plain; charset=utf-8",
      body: Buffer.from([0x41, 0xe2, 0x82, 0xac]),
    }));

    const script = `
      process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
      process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";
      process.env.SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES = "2";
      const { callTool } = await import("./src/tools.js");
      const result = await callTool("sc-fetch", { url: ${JSON.stringify(url)} });
      process.stdout.write(JSON.stringify(result.content[0].text));
    `;
    const stdout = await execNode(script);
    const text = JSON.parse(stdout);

    assert.match(text, /\bA\b/);
    assert.doesNotMatch(text, /�/);
  });

  await it("threads small caller maxBytes into body download limiting", async () => {
    const totalBytes = 256 * 1024;
    const chunk = Buffer.alloc(512, 0x78);
    let sentBytes = 0;
    let requestClosed = false;
    const server = createServer(async (req, res) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      req.on("close", () => { requestClosed = true; });
      for (let offset = 0; offset < totalBytes && !res.destroyed; offset += chunk.byteLength) {
        sentBytes += chunk.byteLength;
        if (!res.write(chunk)) await onceDrainOrClose(res);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      res.end();
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    servers.add(server);
    const { port } = server.address();

    const result = await callTool("sc-fetch", { url: `http://127.0.0.1:${port}/large`, maxBytes: 1024 });

    assert.equal(result._meta.downloadLimited, true);
    assert.equal(result._meta.truncation.reason, "download_limit");
    assert.ok(result._meta.response.returnedBytes <= 1024);
    assert.ok(sentBytes < totalBytes, `expected early cancellation before ${totalBytes} bytes, sent ${sentBytes}`);
    assert.equal(requestClosed, true);
  });

  await it("accepts the cache schema option while rejecting unknown args", async () => {
    const { url } = await startServer(() => ({ contentType: "text/plain", body: "ok" }));

    await assert.doesNotReject(() => callTool("sc-fetch", { url, cache: false }));
    await assert.rejects(
      () => callTool("sc-fetch", { url, cacheMode: false }),
      /Unknown argument for sc-fetch: cacheMode/,
    );
  });
});

async function startServer(handler, { listenHost = "127.0.0.1", urlHost = listenHost } = {}) {
  const server = createServer((req, res) => {
    const response = handler(req);
    res.statusCode = response.status ?? 200;
    res.setHeader("content-type", response.contentType);
    res.end(response.body);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, listenHost, resolve);
  });
  servers.add(server);

  const { port } = server.address();
  return { server, url: `http://${urlHost}:${port}/secret` };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function onceDrainOrClose(stream) {
  await new Promise((resolve) => {
    const cleanup = () => {
      stream.off("drain", onDone);
      stream.off("close", onDone);
      stream.off("error", onDone);
      stream.off("finish", onDone);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    stream.once("drain", onDone);
    stream.once("close", onDone);
    stream.once("error", onDone);
    stream.once("finish", onDone);
  });
}

async function execNode(script) {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: testHome, USERPROFILE: testHome },
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

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}
