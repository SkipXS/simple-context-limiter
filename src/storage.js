import * as fs from "node:fs";
import * as path from "node:path";

export async function writeJsonAtomically(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2));
  await fs.promises.rename(tempPath, filePath);
}
