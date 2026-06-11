import * as fs from "node:fs";
import * as path from "node:path";

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeJsonAtomically(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2));
  await fs.promises.rename(tempPath, filePath);
}

export async function withFileLock(filePath, callback) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    let handle;
    try {
      handle = await fs.promises.open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      try {
        return await callback();
      } finally {
        await handle.close().catch(() => {});
        await fs.promises.rm(lockPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.promises.rm(lockPath, { force: true }).catch(() => {});
      }
      if (error.code !== "EEXIST") throw error;

      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) await fs.promises.rm(lockPath, { force: true });
      } catch {}

      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${lockPath}`);
      await sleep(25 + Math.floor(Math.random() * 50));
    }
  }
}
