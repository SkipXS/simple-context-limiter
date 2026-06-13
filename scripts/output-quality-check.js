#!/usr/bin/env node

process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");

const { tools, callTool } = await import("../src/tools.js");
const { formatOutput } = await import("../src/output.js");

const MAX_TOOLS_LIST_BYTES = 9_000;
const MAX_TOOL_DESCRIPTION_CHARS = 140;
const MAX_PROPERTY_DESCRIPTION_CHARS = 100;
const BANNED_SCHEMA_KEYWORDS = ["oneOf", "allOf", "const", "not"];

function findTool(name) {
  const tool = tools.tools.find((entry) => entry.name === name);
  assert.ok(tool, `missing tool schema: ${name}`);
  return tool;
}

function schemaKeywordPath(value, banned, path = "inputSchema") {
  if (value === null || typeof value !== "object") return undefined;
  for (const key of Object.keys(value)) {
    const currentPath = `${path}.${key}`;
    if (banned.includes(key)) return currentPath;
    const nested = schemaKeywordPath(value[key], banned, currentPath);
    if (nested) return nested;
  }
  return undefined;
}

function assertCompactSchemas() {
  const toolsListBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
  assert.ok(toolsListBytes <= MAX_TOOLS_LIST_BYTES, `tools/list too large: ${toolsListBytes} > ${MAX_TOOLS_LIST_BYTES}`);
  assert.equal(tools.tools.length, 8);
  assert.equal(schemaKeywordPath(tools.tools.map((tool) => tool.inputSchema), BANNED_SCHEMA_KEYWORDS), undefined);

  for (const tool of tools.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} schema must reject unknown args`);
    assert.ok(tool.description.length <= MAX_TOOL_DESCRIPTION_CHARS, `${tool.name} description too long`);

    for (const [propertyName, property] of Object.entries(tool.inputSchema.properties ?? {})) {
      if (!property.description) continue;
      assert.ok(
        property.description.length <= MAX_PROPERTY_DESCRIPTION_CHARS,
        `${tool.name}.${propertyName} description too long: ${property.description.length}`,
      );
    }
  }
}

function assertSchemaWording() {
  for (const tool of tools.tools) {
    const maxLines = tool.inputSchema.properties?.maxLines;
    if (maxLines) assert.match(maxLines.description, /Content line cap/, `${tool.name}.maxLines should say content line cap`);
  }

  const read = findTool("sc-read");
  assert.match(read.description, /path\/fromLine\/toLine/);
  assert.match(read.inputSchema.properties.path.description, /Primary file/);
  assert.match(read.inputSchema.properties.paths.description, /Standalone list or extra files/);
  assert.match(read.inputSchema.properties.paths.description, /Ranges apply only/);

  const search = findTool("sc-search");
  assert.match(search.inputSchema.properties.pattern.description, /Regex for text/);
  assert.match(search.inputSchema.properties.include.description, /glob, not regex/);

  const discover = findTool("sc-discover");
  assert.match(discover.inputSchema.properties.include.description, /Regex filter/);

  assert.match(findTool("sc-run").description, /shell command/i);
  assert.match(findTool("sc-logs").description, /stdout\+stderr/);
  assert.match(findTool("sc-fetch").description, /Lightweight HTML stripping; no JS rendering/);
  assert.match(findTool("sc-diff").description, /Untracked files are excluded/);
}

function assertFormatterGoldens() {
  const lineInput = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  const lineLimited = formatOutput(lineInput, 10, 32768);
  assert.equal(lineLimited.text, [
    "[truncated: 20 lines, 0.1 KB; showing first 3 + last 5; raise maxLines/maxBytes]",
    "line 0",
    "line 1",
    "line 2",
    "[omitted: 12 lines]",
    "line 15",
    "line 16",
    "line 17",
    "line 18",
    "line 19",
  ].join("\n"));
  assert.equal(lineLimited.text.split("\n").length, 10);

  const byteLimited = formatOutput("x".repeat(8192), 60, 1024);
  assert.equal(byteLimited.truncated, true);
  assert.ok(Buffer.byteLength(byteLimited.text, "utf8") <= 1024);
  assert.equal((byteLimited.text.match(/\[truncated:/g) ?? []).length, 1);
  assert.equal((byteLimited.text.match(/\[omitted:/g) ?? []).length, 1);
  assert.match(byteLimited.text, /raise maxLines\/maxBytes/);
  assert.doesNotMatch(byteLimited.text, /\[retry:/);
}

function configuredShell() {
  return (process.env.SIMPLE_CONTEXT_LIMITER_SHELL ?? "").toLowerCase();
}

function isBashConfigured() {
  return configuredShell().includes("bash");
}

function isPowerShellConfigured() {
  const shell = configuredShell();
  return shell.includes("powershell") || shell.includes("pwsh");
}

function shellPath(value) {
  return process.platform === "win32" && isBashConfigured() ? value.replaceAll("\\", "/") : value;
}

function shellQuote(value) {
  const text = shellPath(String(value));
  if (isPowerShellConfigured()) return `'${text.replaceAll("'", "''")}'`;
  if (isBashConfigured() || process.platform !== "win32") return `'${text.replaceAll("'", "'\\''")}'`;
  return JSON.stringify(text);
}

function commandForNodeScript(scriptPath) {
  const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  return isPowerShellConfigured() ? `& ${command}` : command;
}

function normalizeDuration(text) {
  return text.replace(/in \d+ms/g, "in <ms>");
}

function normalizePath(text, filePath, replacement) {
  return text
    .replaceAll(filePath, replacement)
    .replaceAll(filePath.replaceAll("\\", "/"), replacement);
}

async function assertToolOutputGoldens() {
  let tempDir;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "simple-context-limiter-quality-"));

    const logScript = join(tempDir, "log-case.mjs");
    await writeFile(logScript, [
      "console.error('start');",
      "console.error('warn: maybe bad');",
      "console.error('Error: boom');",
      "console.error('    at test.js:1:2');",
      "process.exit(1);",
    ].join("\n"), "utf8");

    const logs = await callTool("sc-logs", {
      command: commandForNodeScript(logScript),
      maxBlocks: 5,
      contextLines: 1,
      maxBytes: 4096,
    });
    assert.equal(logs._meta.blocksFound, 1);
    assert.equal(logs._meta.blocksShown, 1);
    assert.equal(normalizeDuration(logs.content[0].text), [
      "Command exit 1 in <ms>",
      "Lines 1-4:",
      "start",
      "warn: maybe bad",
      "Error: boom",
      "    at test.js:1:2",
    ].join("\n"));

    const samplePath = join(tempDir, "sample.txt");
    await writeFile(samplePath, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const rangedRead = await callTool("sc-read", {
      path: samplePath,
      fromLine: 2,
      toLine: 3,
      lineNumbers: true,
      maxBytes: 4096,
    });
    assert.equal(normalizePath(rangedRead.content[0].text, samplePath, "<tmp>/sample.txt"), [
      "--- <tmp>/sample.txt:2-3 ---",
      "2: beta",
      "3: gamma",
    ].join("\n"));
    assert.equal(rangedRead._meta.fromLine, 2);
    assert.equal(rangedRead._meta.toLine, 3);
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

assertCompactSchemas();
assertSchemaWording();
assertFormatterGoldens();
await assertToolOutputGoldens();

console.log("output quality checks passed");
