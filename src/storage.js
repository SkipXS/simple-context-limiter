import * as fs from "node:fs";
import * as path from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensurePrivateDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.promises.chmod(dirPath, PRIVATE_DIR_MODE).catch(() => {});
}

export async function chmodPrivateFile(filePath) {
  await fs.promises.chmod(filePath, PRIVATE_FILE_MODE).catch(() => {});
}

export async function writeJsonAtomically(filePath, value) {
  await ensurePrivateDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2), { mode: PRIVATE_FILE_MODE });
  await chmodPrivateFile(tempPath);
  await fs.promises.rename(tempPath, filePath);
  await chmodPrivateFile(filePath);
}

export async function withFileLock(filePath, callback) {
  await ensurePrivateDir(path.dirname(filePath));
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    let handle;
    try {
      handle = await fs.promises.open(lockPath, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(String(process.pid));
      await chmodPrivateFile(lockPath);
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
