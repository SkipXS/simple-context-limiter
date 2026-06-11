import * as fs from "node:fs";
import { CACHE_FILE, CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, CACHE_TTL_MS } from "./constants.js";
import { withFileLock, writeJsonAtomically } from "./storage.js";

let cache;
let cacheLoad;
let cacheWrite = Promise.resolve();

async function loadCache() {
  try { return pruneCache(JSON.parse(await fs.promises.readFile(CACHE_FILE, "utf8"))); } catch {
    return {};
  }
}

async function getLoadedCache() {
  if (cache !== undefined) return cache;
  cacheLoad ??= loadCache().then((loaded) => {
    cache = loaded;
    return cache;
  });
  return await cacheLoad;
}

export async function updateCache(mutator) {
  let result;
  cacheWrite = cacheWrite.catch(() => {}).then(async () => {
    try {
      await withFileLock(CACHE_FILE, async () => {
        const currentCache = await loadCache();
        result = await mutator(currentCache);
        cache = pruneCache(result ?? currentCache);
        await writeJsonAtomically(CACHE_FILE, cache);
      });
    } catch {
      // Cache failures should not make context_fetch unusable.
      const currentCache = await getLoadedCache();
      result = await mutator(currentCache);
      cache = pruneCache(result ?? currentCache);
    }
  });
  await cacheWrite;
  return result;
}

function pruneCache(cache) {
  const now = Date.now();
  const pruned = {};
  let totalBytes = 0;
  let entries = 0;

  for (const [key, entry] of Object.entries(cache ?? {})
    .filter(([, value]) => value && typeof value.ts === "number" && now - value.ts < CACHE_TTL_MS)
    .sort((a, b) => b[1].ts - a[1].ts)) {
    if (entries >= CACHE_MAX_ENTRIES) break;

    const entryBytes = Buffer.byteLength(entry.content ?? "", "utf8");
    if (entryBytes > CACHE_MAX_BYTES) continue;
    if (totalBytes + entryBytes > CACHE_MAX_BYTES) continue;

    pruned[key] = entry;
    totalBytes += entryBytes;
    entries++;
  }

  return pruned;
}

export async function getCache() {
  return await getLoadedCache();
}
