process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";
process.env.SIMPLE_CONTEXT_LIMITER_MAX_COMMAND_BYTES = "1024";

const assert = await import("node:assert/strict");
const { describe, it } = await import("node:test");
const { runCommand } = await import("../src/process.js");

await describe("runCommand output cap failures", async () => {
  await it("returns bounded capped output only when the command exits cleanly", async () => {
    const command = nodeScriptCommand(`
      process.stdout.write("x".repeat(4096));
      process.exit(0);
    `);

    const result = await runCommand(command, { timeout: 5_000, allowOutputTooLarge: true });

    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.outputTooLarge, true);
    assert.equal(result.stdout.length, 1024);
  });

  await it("rejects capped commands that exit non-zero instead of reporting success", async () => {
    const command = nodeScriptCommand(`
      process.stdout.write("x".repeat(4096));
      process.exit(7);
    `);

    await assert.rejects(
      () => runCommand(command, { timeout: 5_000, allowOutputTooLarge: true }),
      (error) => {
        assert.equal(error.outputTooLarge, true);
        assert.ok(error.status === 7 || error.signal, `expected exit 7 or signal, got status=${error.status} signal=${error.signal}`);
        return true;
      },
    );
  });

  await it("rejects capped commands terminated by signal instead of reporting success", async () => {
    const command = nodeScriptCommand(`
      process.stdout.write("x".repeat(4096));
      setInterval(() => {}, 1000);
    `);

    await assert.rejects(
      () => runCommand(command, { timeout: 5_000, allowOutputTooLarge: true }),
      (error) => {
        assert.equal(error.outputTooLarge, true);
        assert.ok(error.signal || error.status !== 0, `expected signal or non-zero exit, got status=${error.status} signal=${error.signal}`);
        return true;
      },
    );
  });
});

function nodeScriptCommand(source) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `${shellQuote(process.execPath)} --input-type=module --eval ${shellQuote(`eval(Buffer.from('${encoded}','base64').toString())`)}`;
}

function shellQuote(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replaceAll('"', '""')}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
}
