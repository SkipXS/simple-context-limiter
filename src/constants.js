import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export const SERVER_NAME = "simple-context-limiter";
export const SERVER_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const MAX_LINES = 60;
export const MAX_BYTES = 32 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MIN_COMMAND_TIMEOUT_MS = 100;
export const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
export const MAX_COMMAND_BYTES = normalizeByteLimit(process.env.SIMPLE_CONTEXT_LIMITER_MAX_COMMAND_BYTES, 10 * 1024 * 1024);
export const MAX_FETCH_BYTES = normalizeByteLimit(process.env.SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES, 10 * 1024 * 1024);
export const MAX_READ_BYTES = normalizeByteLimit(process.env.SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES, 10 * 1024 * 1024);
export const MAX_RPC_LINE_BYTES = normalizeIntegerLimit(process.env.SIMPLE_CONTEXT_LIMITER_MAX_RPC_LINE_BYTES, 1024 * 1024, 1024, 100 * 1024 * 1024);
export const MAX_RPC_BATCH_SIZE = normalizeIntegerLimit(process.env.SIMPLE_CONTEXT_LIMITER_MAX_RPC_BATCH_SIZE, 50, 1, 10_000);
export const MAX_RPC_BATCH_CONCURRENCY = normalizeIntegerLimit(process.env.SIMPLE_CONTEXT_LIMITER_MAX_RPC_BATCH_CONCURRENCY, 4, 1, 1000);
export const MAX_RPC_TOOL_CONCURRENCY = normalizeIntegerLimit(process.env.SIMPLE_CONTEXT_LIMITER_MAX_RPC_TOOL_CONCURRENCY, MAX_RPC_BATCH_CONCURRENCY, 1, 1000);
export const READ_RANGE_TIMEOUT_MS = normalizeIntegerLimit(process.env.SIMPLE_CONTEXT_LIMITER_READ_RANGE_TIMEOUT_MS, 120_000, 1_000, 3_600_000);
export const CACHE_MAX_ENTRIES = normalizeIntegerLimit(process.env.SIMPLE_CONTEXT_LIMITER_CACHE_MAX_ENTRIES, 200, 1, 10_000);
export const CACHE_MAX_BYTES = normalizeByteLimit(process.env.SIMPLE_CONTEXT_LIMITER_CACHE_MAX_BYTES, 50 * 1024 * 1024);
export const USAGE_LOG_MAX_BYTES = normalizeByteLimit(process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG_MAX_BYTES, 10 * 1024 * 1024);
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
export const USAGE_LOG_FILE = path.join(CACHE_DIR, "usage.jsonl");
export const RG_NAME = process.platform === "win32" ? "rg.exe" : "rg";

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "deno.json", "deno.jsonc"];

export function projectKey() {
  const cwd = path.resolve(process.cwd());
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot) return projectRoot;
  return isTempPath(cwd) ? undefined : cwd;
}

function findProjectRoot(startDir) {
  let current = startDir;
  for (;;) {
    if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(current, marker)))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isTempPath(value) {
  const relative = path.relative(path.resolve(os.tmpdir()), value);
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function usageLogEnabled() {
  return !/^(0|false|no|off)$/i.test(process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG ?? "")
    && !/^(1|true|yes|on)$/i.test(process.env.SIMPLE_CONTEXT_LIMITER_DISABLE_USAGE_LOG ?? "");
}

export function statsEnabled() {
  return !/^(0|false|no|off)$/i.test(process.env.SIMPLE_CONTEXT_LIMITER_STATS ?? "")
    && !/^(1|true|yes|on)$/i.test(process.env.SIMPLE_CONTEXT_LIMITER_DISABLE_STATS ?? "");
}

export function normalizeByteLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

export function normalizeIntegerLimit(value, fallback, min, max) {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.max(min, Math.min(parsed, max));
}
