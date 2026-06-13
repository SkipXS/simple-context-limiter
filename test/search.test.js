process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { describe, it } = await import("node:test");
const { callTool } = await import("../src/tools.js");
const { findRg } = await import("../src/tools/search.js");

await describe("sc-search", async () => {
  await it("finds bounded text matches with metadata", async (t) => {
    if (!await findRg()) return t.skip("rg not available");

    await withTempProject(async (dir) => {
      await seedSearchProject(dir);

      const result = await callTool("sc-search", { pattern: "needle", path: ".", include: "*.txt", maxMatches: 5, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Search: text/);
      assert.match(text, /a\.txt:1:alpha needle/);
      assert.match(text, /b\.txt:2:needle beta/);
      assert.equal(result._meta.totalMatches, 2);
      assert.equal(result._meta.totalMatchesKnown, true);
      assert.equal(result._meta.shownMatches, 2);
      assert.equal(result._meta.truncated, false);
    });
  });

  await it("reports no matches without treating rg exit 1 as an error", async (t) => {
    if (!await findRg()) return t.skip("rg not available");

    await withTempProject(async (dir) => {
      await seedSearchProject(dir);

      const result = await callTool("sc-search", { pattern: "missing-pattern", path: ".", include: "*.txt" });

      assert.equal(result.content[0].text, "(no matches)");
      assert.equal(result._meta.empty, true);
      assert.equal(result._meta.emptyReason, "no_matches");
      assert.equal(result._meta.totalMatches, 0);
    });
  });

  await it("line-limits text matches before collecting too many results", async (t) => {
    if (!await findRg()) return t.skip("rg not available");

    await withTempProject(async (dir) => {
      await fs.writeFile(path.join(dir, "many.txt"), Array.from({ length: 20 }, (_, index) => `needle ${index}`).join("\n"), "utf8");

      const result = await callTool("sc-search", { pattern: "needle", path: ".", maxMatches: 3, maxLines: 80, maxBytes: 8192 });

      assert.match(result.content[0].text, /\[truncated: match limit/);
      assert.equal(result._meta.shownMatches, 3);
      assert.equal(result._meta.totalMatchesKnown, false);
      assert.equal(result._meta.truncated, true);
      assert.equal(result._meta.truncation.reason, "match_limit");
    });
  });
});

async function withTempProject(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-search-test-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    return await callback(dir);
  } finally {
    process.chdir(previousCwd);
    await rmWithRetries(dir);
  }
}

async function rmWithRetries(target) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error.code !== "EBUSY" && error.code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  await fs.rm(target, { recursive: true, force: true });
}

async function seedSearchProject(dir) {
  await fs.writeFile(path.join(dir, "a.txt"), "alpha needle\nplain\n", "utf8");
  await fs.writeFile(path.join(dir, "b.txt"), "plain\nneedle beta\n", "utf8");
  await fs.writeFile(path.join(dir, "ignored.js"), "const needle = true;\n", "utf8");
}
