import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export const SERVER_NAME = "simple-context-limiter";
export const SERVER_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const MAX_LINES = 60;
export const MAX_BYTES = 32 * 1024;
export const MAX_COMMAND_BYTES = normalizeByteLimit(process.env.SIMPLE_CONTEXT_LIMITER_MAX_COMMAND_BYTES, 10 * 1024 * 1024);
export const MAX_FETCH_BYTES = normalizeByteLimit(process.env.SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES, 10 * 1024 * 1024);
export const MAX_READ_BYTES = normalizeByteLimit(process.env.SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES, 10 * 1024 * 1024);
export const READ_RANGE_TIMEOUT_MS = normalizeIntegerLimit(process.env.SIMPLE_CONTEXT_LIMITER_READ_RANGE_TIMEOUT_MS, 120_000, 1_000, 3_600_000);
export const CACHE_MAX_ENTRIES = normalizeIntegerLimit(process.env.SIMPLE_CONTEXT_LIMITER_CACHE_MAX_ENTRIES, 200, 1, 10_000);
export const CACHE_MAX_BYTES = normalizeByteLimit(process.env.SIMPLE_CONTEXT_LIMITER_CACHE_MAX_BYTES, 50 * 1024 * 1024);
export const CACHE_TTL_MS = 3_600_000;
export const ALLOW_NON_HTTP_FETCH = /^(1|true|yes)$/i.test(process.env.SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH ?? "");

export const COMMAND_SHELL = process.env.SIMPLE_CONTEXT_LIMITER_SHELL || true;
export const COMMAND_SHELL_NAME = typeof COMMAND_SHELL === "string"
  ? COMMAND_SHELL
  : process.platform === "win32"
    ? process.env.ComSpec || "cmd.exe"
    : process.env.SHELL || "/bin/sh";

export const CACHE_DIR = path.join(os.homedir(), ".simple-context-limiter");
export const CACHE_FILE = path.join(CACHE_DIR, "cache.json");
export const STATS_FILE = path.join(CACHE_DIR, "stats.json");
export const RG_NAME = process.platform === "win32" ? "rg.exe" : "rg";

export function normalizeByteLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

export function normalizeIntegerLimit(value, fallback, min, max) {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.max(min, Math.min(parsed, max));
}
