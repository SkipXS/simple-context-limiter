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

  await it("runs AST search through fake ast-grep JSON-stream output", async () => {
    await withTempProject(async (dir) => {
      await seedAstProject(dir);
      const fakeSg = await writeFakeAstGrep(dir);
      await withFakeAstGrep(fakeSg, { mode: "happy", expectedGlob: "*.js", expectedLang: "javascript", expectedContext: "1" }, async () => {
        const result = await callTool("sc-search", {
          engine: "ast",
          pattern: "console.log($$$ARGS)",
          path: ".",
          include: "*.js",
          language: "javascript",
          contextLines: 1,
          maxMatches: 5,
          maxLines: 80,
          maxBytes: 8192,
        });

        assert.match(result.content[0].text, /Search: ast "console\.log\(\$\$\$ARGS\)" in \.; include \*\.js; lang javascript; context 1; 2 matches shown/);
        assert.match(result.content[0].text, /src[/\\]one\.js:1:1: console\.log\("one"\)/);
        assert.match(result.content[0].text, /src[/\\]two\.js:3:3: console\.log\("two"\)/);
        assert.match(result.content[0].text, /> 3:   console\.log\("two"\);/);
        assert.equal(result._meta.engine, "ast");
        assert.equal(result._meta.language, "javascript");
        assert.equal(result._meta.totalMatches, 2);
        assert.equal(result._meta.totalMatchesKnown, true);
        assert.equal(result._meta.shownMatches, 2);
        assert.equal(result._meta.truncated, false);
      });
    });
  });

  await it("reports fake ast-grep non-zero failures as tool errors", async () => {
    await withTempProject(async (dir) => {
      await seedAstProject(dir);
      const fakeSg = await writeFakeAstGrep(dir);
      await withFakeAstGrep(fakeSg, { mode: "error" }, async () => {
        await assert.rejects(
          callTool("sc-search", { engine: "ast", pattern: "console.log($$$ARGS)", path: ".", language: "javascript" }),
          (error) => {
            assert.match(error.message, /Command failed: ast-grep run --pattern/);
            assert.match(error.message, /exited with code 2/);
            assert.equal(error.status, 2);
            assert.match(error.stderr, /fake ast-grep error/);
            return true;
          },
        );
      });
    });
  });

  await it("treats malformed AST JSON-stream lines as no matches", async () => {
    await withTempProject(async (dir) => {
      await seedAstProject(dir);
      const fakeSg = await writeFakeAstGrep(dir);
      await withFakeAstGrep(fakeSg, { mode: "malformed" }, async () => {
        const result = await callTool("sc-search", { engine: "ast", pattern: "console.log($$$ARGS)", path: ".", language: "javascript" });

        assert.equal(result.content[0].text, "(no matches)");
        assert.equal(result._meta.empty, true);
        assert.equal(result._meta.emptyReason, "no_matches");
        assert.equal(result._meta.totalMatches, 0);
        assert.equal(result._meta.totalMatchesKnown, true);
      });
    });
  });

  await it("limits AST matches and formatted output", async () => {
    await withTempProject(async (dir) => {
      await seedAstProject(dir);
      const fakeSg = await writeFakeAstGrep(dir);
      await withFakeAstGrep(fakeSg, { mode: "many" }, async () => {
        const result = await callTool("sc-search", {
          engine: "ast",
          pattern: "console.log($$$ARGS)",
          path: ".",
          include: "*.js",
          maxMatches: 2,
          maxLines: 10,
          maxBytes: 1024,
        });

        assert.match(result.content[0].text, /\[truncated: match limit; 2 matches shown/);
        assert.equal(result._meta.shownMatches, 2);
        assert.equal(result._meta.totalMatchesKnown, false);
        assert.equal(result._meta.truncated, true);
        assert.equal(result._meta.truncation.reason, "match_limit");

        const lineLimited = await callTool("sc-search", {
          engine: "ast",
          pattern: "console.log($$$ARGS)",
          path: ".",
          include: "*.js",
          maxMatches: 20,
          maxLines: 10,
          maxBytes: 8192,
        });
        assert.match(lineLimited.content[0].text, /\[truncated: 23 lines, 0\.7 KB; showing first 3 \+ last 5/);
        assert.equal(lineLimited._meta.truncated, true);
        assert.equal(lineLimited._meta.truncation.reason, "format_lines");
      });
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

async function seedAstProject(dir) {
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "one.js"), "console.log(\"one\");\n", "utf8");
  await fs.writeFile(path.join(dir, "src", "two.js"), "const value = 1;\n  console.log(\"two\");\n", "utf8");
}

async function writeFakeAstGrep(dir) {
  const scriptPath = path.join(dir, "fake-ast-grep.mjs");
  await fs.writeFile(scriptPath, fakeAstGrepSource(), "utf8");

  if (process.platform === "win32") {
    const commandPath = path.join(dir, "fake-ast-grep.cmd");
    await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return commandPath;
  }

  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

async function withFakeAstGrep(fakeSg, options, callback) {
  const previousPath = process.env.SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH;
  const previousMode = process.env.SIMPLE_CONTEXT_LIMITER_FAKE_AST_MODE;
  const previousGlob = process.env.SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_GLOB;
  const previousLang = process.env.SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_LANG;
  const previousContext = process.env.SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_CONTEXT;
  try {
    process.env.SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH = fakeSg;
    process.env.SIMPLE_CONTEXT_LIMITER_FAKE_AST_MODE = options.mode;
    setOptionalEnv("SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_GLOB", options.expectedGlob);
    setOptionalEnv("SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_LANG", options.expectedLang);
    setOptionalEnv("SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_CONTEXT", options.expectedContext);
    return await callback();
  } finally {
    restoreEnv("SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH", previousPath);
    restoreEnv("SIMPLE_CONTEXT_LIMITER_FAKE_AST_MODE", previousMode);
    restoreEnv("SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_GLOB", previousGlob);
    restoreEnv("SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_LANG", previousLang);
    restoreEnv("SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_CONTEXT", previousContext);
  }
}

function setOptionalEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fakeAstGrepSource() {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("ast-grep 0.0.0-fake");
  process.exit(0);
}
if (args[0] !== "run") {
  console.error("unexpected fake ast-grep command: " + args.join(" "));
  process.exit(2);
}
const expectedGlob = process.env.SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_GLOB;
if (expectedGlob && !hasFlagValue("--globs", expectedGlob)) {
  console.error("missing expected --globs " + expectedGlob + " in " + args.join(" "));
  process.exit(3);
}
const expectedLang = process.env.SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_LANG;
if (expectedLang && !hasFlagValue("--lang", expectedLang)) {
  console.error("missing expected --lang " + expectedLang + " in " + args.join(" "));
  process.exit(3);
}
const expectedContext = process.env.SIMPLE_CONTEXT_LIMITER_FAKE_AST_EXPECT_CONTEXT;
if (expectedContext && !hasFlagValue("--context", expectedContext)) {
  console.error("missing expected --context " + expectedContext + " in " + args.join(" "));
  process.exit(3);
}
const mode = process.env.SIMPLE_CONTEXT_LIMITER_FAKE_AST_MODE || "happy";
if (mode === "error") {
  console.error("fake ast-grep error");
  process.exit(2);
}
if (mode === "malformed") {
  console.log("not json");
  console.log(JSON.stringify(null));
  console.log("{bad");
  process.exit(0);
}
const count = mode === "many" ? 8 : 2;
for (let index = 0; index < count; index++) console.log(JSON.stringify(match(index)));

function hasFlagValue(flag, value) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] === value;
}
function match(index) {
  const line = index === 0 ? 0 : index + 1;
  const file = index === 0 ? "src/one.js" : "src/two.js";
  const text = index === 0 ? 'console.log("one")' : 'console.log("two")';
  return {
    text,
    file,
    range: { start: { line, column: index === 0 ? 0 : 2 }, end: { line, column: 20 } },
    lines: index === 0 ? 'console.log("one");\\n' : 'const value = 1;\\n  console.log("two");\\n',
  };
}
`;
}
