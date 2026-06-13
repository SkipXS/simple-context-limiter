process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { describe, it } = await import("node:test");
const { callTool } = await import("../src/tools.js");

await describe("sc-discover", async () => {
  await it("summarizes package metadata and README context", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);

      const result = await callTool("sc-discover", { mode: "summary", maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Project:/);
      assert.match(text, /Name: demo-project/);
      assert.match(text, /Node: >=22/);
      assert.match(text, /README:/);
      assert.equal(result._meta.mode, "summary");
      assert.equal(result._meta.truncated, false);
    });
  });

  await it("lists and trees project files with bounds metadata", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);

      const files = await callTool("sc-discover", { mode: "files", path: ".", maxFiles: 10, maxLines: 80, maxBytes: 8192 });
      const tree = await callTool("sc-discover", { mode: "tree", path: ".", maxDepth: 2, maxEntries: 20, maxLines: 80, maxBytes: 8192 });

      assert.match(files.content[0].text, /package\.json/);
      assert.match(files.content[0].text, /src\/main\.js/);
      assert.equal(files._meta.mode, "files");
      assert.equal(files._meta.totalFilesKnown, true);
      assert.match(tree.content[0].text, /src\//);
      assert.match(tree.content[0].text, /main\.js/);
      assert.equal(tree._meta.mode, "tree");
      assert.equal(tree._meta.truncated, false);
    });
  });

  await it("extracts a lightweight source outline", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);

      const result = await callTool("sc-discover", { mode: "outline", path: path.join(dir, "src", "main.js"), maxSymbols: 10, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /function greet/);
      assert.match(text, /class Greeter/);
      assert.match(text, /const answer/);
      assert.equal(result._meta.mode, "outline");
      assert.equal(result._meta.symbolsShown, 3);
    });
  });
});

async function withTempProject(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-discover-test-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    return await callback(dir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function seedProject(dir) {
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "demo-project",
    version: "1.0.0",
    type: "module",
    main: "src/main.js",
    engines: { node: ">=22" },
    scripts: { test: "node --test" },
  }, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "README.md"), "# Demo Project\n\nA tiny demo for discovery tests.\n", "utf8");
  await fs.writeFile(path.join(dir, "src", "main.js"), `
export function greet(name) {
  return \`hello \${name}\`;
}

export class Greeter {}

export const answer = 42;
`, "utf8");
}
