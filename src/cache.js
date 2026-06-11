import * as fs from "node:fs";
import { CACHE_DIR, CACHE_FILE, CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, CACHE_TTL_MS } from "./constants.js";

let cache;

async function loadCache() {
  try { return pruneCache(JSON.parse(await fs.promises.readFile(CACHE_FILE, "utf8"))); } catch {
    return {};
  }
}

export async function saveCache(nextCache) {
  cache = pruneCache(nextCache);
  try {
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    await fs.promises.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Cache failures should not make context_fetch unusable.
  }
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
  if (cache === undefined) cache = await loadCache();
  return cache;
}
