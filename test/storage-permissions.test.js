process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";
process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "1";
delete process.env.SIMPLE_CONTEXT_LIMITER_DISABLE_USAGE_LOG;

const tempRoot = await import("node:os").then((os) => os.tmpdir());
const fs = await import("node:fs/promises");
const path = await import("node:path");
const assert = await import("node:assert/strict");
const { describe, it, beforeEach, afterEach } = await import("node:test");

const testHome = await fs.mkdtemp(path.join(tempRoot, "scl-perms-home-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const { CACHE_FILE, USAGE_LOG_FILE } = await import("../src/constants.js");
const { writeJsonAtomically, withFileLock } = await import("../src/storage.js");
const { recordUsage, usageReport } = await import("../src/usage.js");

await describe("local state permissions", async () => {
  let previousCwd;
  let projectDir;

  beforeEach(async () => {
    await fs.rm(path.dirname(CACHE_FILE), { recursive: true, force: true });
    projectDir = await fs.mkdtemp(path.join(tempRoot, "scl-perms-project-"));
    await fs.writeFile(path.join(projectDir, "package.json"), "{}\n", "utf8");
    previousCwd = process.cwd();
    process.chdir(projectDir);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  await it("creates cache directory, json files, and lock files with private POSIX modes", async (t) => {
    if (skipOnWindows(t)) return;

    await withPermissiveUmask(async () => {
      await withFileLock(CACHE_FILE, async () => {
        const lockMode = await modeOf(`${CACHE_FILE}.lock`);
        assert.equal(lockMode & 0o077, 0, `lock mode ${lockMode.toString(8)} is not private`);
      });
      await writeJsonAtomically(CACHE_FILE, { ok: true });
    });

    const dirMode = await modeOf(path.dirname(CACHE_FILE));
    const fileMode = await modeOf(CACHE_FILE);
    assert.equal(dirMode & 0o077, 0, `dir mode ${dirMode.toString(8)} is not private`);
    assert.equal(fileMode & 0o077, 0, `file mode ${fileMode.toString(8)} is not private`);
  });

  await it("creates usage logs with private POSIX file mode", async (t) => {
    if (skipOnWindows(t)) return;

    await withPermissiveUmask(async () => {
      recordUsage("run", { command: "echo ok" }, { _meta: {} }, undefined, 1);
      await usageReport({ maxEvents: 10 });
    });

    const usageMode = await modeOf(USAGE_LOG_FILE);
    assert.equal(usageMode & 0o077, 0, `usage mode ${usageMode.toString(8)} is not private`);
  });
});

function skipOnWindows(t) {
  if (process.platform !== "win32") return false;
  t.skip("POSIX mode bits are not reliable on Windows");
  return true;
}

async function withPermissiveUmask(callback) {
  const previous = process.umask(0);
  try {
    return await callback();
  } finally {
    process.umask(previous);
  }
}

async function modeOf(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}
