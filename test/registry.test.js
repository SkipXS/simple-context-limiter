process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const { describe, it } = await import("node:test");
const { callTool, tools } = await import("../src/tools.js");
const { COMMON_SCHEMA_DEFAULTS, registeredToolNamesForTest } = await import("../src/tools/registry.js");

await describe("tool registry", async () => {
  await it("exposes only prefixed public tool names with matching handlers", () => {
    const names = tools.tools.map((tool) => tool.name);

    assert.equal(names.length, 8);
    assert.ok(names.every((name) => name.startsWith("sc-")));
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual([...names].sort(), registeredToolNamesForTest().sort());
  });

  await it("keeps common advertised defaults centralized and machine-checkable", () => {
    const commonDefaultProperties = [];
    for (const tool of tools.tools) {
      for (const [propertyName, propertySchema] of Object.entries(tool.inputSchema.properties ?? {})) {
        if (propertyName === "maxLines" || propertyName === "maxBytes" || propertyName === "timeoutMs") {
          commonDefaultProperties.push([tool.name, propertyName, propertySchema]);
        }
      }
    }

    assert.ok(commonDefaultProperties.length >= tools.tools.length * 2);
    for (const [toolName, propertyName, propertySchema] of commonDefaultProperties) {
      assert.equal(typeof propertySchema.default, "number", `${toolName} ${propertyName} default is not machine-checkable`);
      assert.match(propertySchema.description, new RegExp(`Default: ${propertySchema.default}\\.`));
      if (propertyName === "maxLines") {
        assert.equal(propertySchema.minimum, 10);
        assert.equal(propertySchema.maximum, 500);
      }
      if (propertyName === "maxBytes") {
        assert.equal(propertySchema.default, COMMON_SCHEMA_DEFAULTS.maxBytes, `${toolName} maxBytes default drifted`);
        assert.equal(propertySchema.minimum, 1024);
        assert.ok(propertySchema.maximum >= propertySchema.default);
      }
      if (propertyName === "timeoutMs") {
        assert.equal(propertySchema.default, COMMON_SCHEMA_DEFAULTS.timeoutMs, `${toolName} timeoutMs default drifted`);
        assert.equal(propertySchema.minimum, 100);
        assert.equal(propertySchema.maximum, 1800000);
      }
    }
  });

  await it("keeps advertised sc-run timeout default aligned with handler behavior", async () => {
    const runSchema = tools.tools.find((tool) => tool.name === "sc-run").inputSchema.properties;
    const command = `${JSON.stringify(process.execPath)} -e "console.log('ok')"`;

    const result = await callTool("sc-run", { command });

    assert.equal(result.content[0].text.trim(), "ok");
    assert.equal(result._meta.timeoutMs, runSchema.timeoutMs.default);
  });

  await it("rejects unprefixed tool calls with a helpful migration hint", async () => {
    await assert.rejects(
      () => callTool("run", { command: "echo ok" }),
      /Unknown tool: run\. Tool names are prefixed; use sc-run\./,
    );
  });

  await it("rejects unknown arguments before executing a tool", async () => {
    await assert.rejects(
      () => callTool("sc-run", { command: "echo should-not-run", unexpected: true }),
      /Unknown argument for sc-run: unexpected/,
    );
  });

  await it("rejects schema type, range, enum, and required argument drift before executing tools", async () => {
    await assert.rejects(
      () => callTool("sc-run", {}),
      /Missing required argument for sc-run: command/,
    );
    await assert.rejects(
      () => callTool("sc-run", { command: "echo should-not-run", maxLines: 9 }),
      /run maxLines must be between 10 and 500/,
    );
    await assert.rejects(
      () => callTool("sc-fetch", { url: "http://example.test", cache: "no" }),
      /fetch cache must be a boolean/,
    );
    await assert.rejects(
      () => callTool("sc-diff", { mode: "patch" }),
      /diff mode must be one of: diff, status, history/,
    );
    await assert.rejects(
      () => callTool("sc-read", { paths: [] }),
      /sc-read paths must contain at least 1 item/,
    );
  });

  await it("rejects unknown prefixed tool names", async () => {
    await assert.rejects(
      () => callTool("sc-missing", {}),
      /Unknown tool: sc-missing/,
    );
  });
});
