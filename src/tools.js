import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import {
  ALLOW_NON_HTTP_FETCH,
  CACHE_MAX_ENTRIES,
  CACHE_DIR,
  CACHE_FILE,
  CACHE_TTL_MS,
  COMMAND_SHELL_NAME,
  MAX_FETCH_BYTES,
  MAX_LINES,
  MAX_READ_BYTES,
  RG_NAME,
} from "./constants.js";
import { formatOutput, normalizeLimit, normalizeMaxLines } from "./output.js";
import { commandError, runCommand, runProcessLines } from "./process.js";

fs.mkdirSync(CACHE_DIR, { recursive: true });

function loadCache() {
  try { return pruneCache(JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))); } catch {
    return {};
  }
}

function saveCache(nextCache) {
  cache = pruneCache(nextCache);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function pruneCache(cache) {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(cache ?? {})
      .filter(([, entry]) => entry && typeof entry.ts === "number" && now - entry.ts < CACHE_TTL_MS)
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, CACHE_MAX_ENTRIES),
  );
}

let cache = loadCache();

function pathEntries() {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  return raw.split(path.delimiter).filter(Boolean);
}

async function isExecutable(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findRg() {
  const candidates = [];

  if (process.env.MINI_SANDBOX_RG_PATH) candidates.push(process.env.MINI_SANDBOX_RG_PATH);

  for (const entry of pathEntries()) candidates.push(path.join(entry, RG_NAME));

  candidates.push(
    path.join(os.homedir(), ".cache", "opencode", "bin", RG_NAME),
    path.join(os.homedir(), ".pi", "agent", "bin", RG_NAME),
  );

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }

  return null;
}

async function runTool(args) {
  const { command, maxLines = MAX_LINES } = args ?? {};
  if (typeof command !== "string" || command.trim() === "") {
    const error = new Error("sandbox_run requires a non-empty command string");
    error.code = -32602;
    throw error;
  }

  const { stdout, durationMs } = await runCommand(command);
  const formatted = formatOutput(stdout, maxLines);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      totalLines: formatted.totalLines,
      totalBytes: formatted.totalBytes,
      truncated: formatted.truncated,
      durationMs,
      shell: COMMAND_SHELL_NAME,
    },
  };
}

async function readTool(args) {
  const { path: filePath, maxLines = MAX_LINES, fromLine, toLine } = args ?? {};
  if (typeof filePath !== "string" || filePath.trim() === "") {
    const error = new Error("sandbox_read requires a non-empty path string");
    error.code = -32602;
    throw error;
  }

  const resolved = path.resolve(filePath);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) {
    const error = new Error(`Not a file: ${filePath}`);
    error.code = -32602;
    throw error;
  }

  const rangeMode = fromLine !== undefined || toLine !== undefined;
  const range = rangeMode ? normalizeLineRange(fromLine, toLine) : undefined;
  const { text, limited, rangeLimited, returnedLines, scannedLines } = rangeMode
    ? await readLineRange(resolved, range.fromLine, range.toLine, maxLines)
    : await readLimitedFile(resolved, stat.size, MAX_READ_BYTES);
  const formatted = formatOutput(text, maxLines);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      path: resolved,
      sizeBytes: stat.size,
      totalLines: formatted.totalLines,
      totalBytes: formatted.totalBytes,
      truncated: formatted.truncated || rangeLimited,
      fileReadLimited: limited,
      fromLine: range?.fromLine,
      toLine: range?.toLine === Infinity ? undefined : range?.toLine,
      returnedLines,
      scannedLines,
      rangeLimited,
    },
  };
}

function normalizeLineRange(fromLine, toLine) {
  const from = fromLine === undefined ? 1 : Number(fromLine);
  const to = toLine === undefined ? Infinity : Number(toLine);

  if (!Number.isInteger(from) || from < 1) {
    const error = new Error("sandbox_read fromLine must be an integer >= 1");
    error.code = -32602;
    throw error;
  }
  if (to !== Infinity && (!Number.isInteger(to) || to < 1)) {
    const error = new Error("sandbox_read toLine must be an integer >= 1");
    error.code = -32602;
    throw error;
  }
  if (to < from) {
    const error = new Error("sandbox_read toLine must be greater than or equal to fromLine");
    error.code = -32602;
    throw error;
  }

  return { fromLine: from, toLine: to };
}

async function readLineRange(filePath, fromLine, toLine, maxLines) {
  const limit = normalizeMaxLines(maxLines);
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = [];
  const file = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  let rangeLimited = false;

  try {
    for await (const line of file) {
      lineNumber++;
      if (lineNumber < fromLine) continue;
      if (lineNumber > toLine) break;

      if (lines.length >= limit) {
        rangeLimited = true;
        break;
      }

      lines.push(line);
    }
  } finally {
    file.close();
    input.destroy();
  }

  return {
    text: lines.join("\n"),
    limited: false,
    rangeLimited,
    returnedLines: lines.length,
    scannedLines: lineNumber,
  };
}

async function readLimitedFile(filePath, size, maxBytes) {
  if (size <= maxBytes) {
    return { text: await fs.promises.readFile(filePath, "utf8"), limited: false, rangeLimited: false };
  }

  const headBytes = Math.floor(maxBytes * 0.4);
  const tailBytes = maxBytes - headBytes;
  const file = await fs.promises.open(filePath, "r");

  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const headRead = await file.read(head, 0, headBytes, 0);
    const tailRead = await file.read(tail, 0, tailBytes, size - tailBytes);

    return {
      text: [
        head.subarray(0, headRead.bytesRead).toString("utf8"),
        `╟── … file content omitted after ${(maxBytes / 1024).toFixed(1)} KB preview … ──╢`,
        tail.subarray(0, tailRead.bytesRead).toString("utf8"),
      ].join("\n"),
      limited: true,
      rangeLimited: false,
    };
  } finally {
    await file.close();
  }
}

async function searchTool(args) {
  const {
    pattern,
    path: searchPath = ".",
    include,
    maxMatches = 100,
    maxLines = MAX_LINES,
  } = args ?? {};

  if (typeof pattern !== "string" || pattern.trim() === "") {
    const error = new Error("sandbox_search requires a non-empty pattern string");
    error.code = -32602;
    throw error;
  }
  if (typeof searchPath !== "string" || searchPath.trim() === "") {
    const error = new Error("sandbox_search requires path to be a non-empty string when provided");
    error.code = -32602;
    throw error;
  }
  if (include !== undefined && typeof include !== "string") {
    const error = new Error("sandbox_search include must be a string when provided");
    error.code = -32602;
    throw error;
  }

  const rg = await findRg();
  if (!rg) {
    const error = new Error(
      "ripgrep was not found. Install rg, set MINI_SANDBOX_RG_PATH, or run from OpenCode/Pi after their rg helper has been installed.",
    );
    error.code = -32000;
    throw error;
  }

  const limit = normalizeLimit(maxMatches, 100, 1, 1000);
  const rgArgs = ["--line-number", "--with-filename", "--color", "never", "--no-heading"];
  if (include) rgArgs.push("--glob", include);
  rgArgs.push(pattern, searchPath);

  const result = await runProcessLines(rg, rgArgs, {
    cwd: process.cwd(),
    timeout: 120_000,
    maxLines: limit + 1,
    maxBytes: MAX_READ_BYTES,
  });
  if (result.code === 1) {
    return {
      content: [{ type: "text", text: "(no matches)" }],
      _meta: {
        rgPath: rg,
        totalMatches: 0,
        totalMatchesKnown: true,
        shownMatches: 0,
        truncated: false,
        durationMs: result.durationMs,
      },
    };
  }
  if (result.code !== 0 && !result.truncated && !result.outputTooLarge) {
    commandError(`rg ${rgArgs.join(" ")}`, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge);
  }

  const matches = result.lines;
  const shown = matches.slice(0, limit);
  const matchLimited = result.truncated || result.outputTooLarge || matches.length > limit;
  const text = matchLimited
    ? [...shown, `... more matches omitted ...`].join("\n")
    : matches.join("\n") || "(no matches)";
  const formatted = formatOutput(text, maxLines);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      rgPath: rg,
      totalMatches: matches.length,
      totalMatchesKnown: !matchLimited,
      shownMatches: shown.length,
      totalLines: formatted.totalLines,
      totalBytes: formatted.totalBytes,
      truncated: matchLimited || formatted.truncated,
      durationMs: result.durationMs,
    },
  };
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|pre|table)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ +/g, " ")
    .replace(/^[ \t]+/gm, "")
    .trim();
}

async function fetchUrl(url, force) {
  let parsed;
  try { parsed = new URL(url); } catch {
    const error = new Error("sandbox_fetch requires a valid URL");
    error.code = -32602;
    throw error;
  }
  if (!ALLOW_NON_HTTP_FETCH && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const error = new Error("sandbox_fetch only allows http and https URLs by default; set MINI_SANDBOX_ALLOW_NON_HTTP_FETCH=1 to allow other schemes");
    error.code = -32602;
    throw error;
  }

  const key = createHash("sha256").update(url).digest("hex");
  const cached = cache[key];
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { content: cached.content, cached: true, limited: cached.limited ?? false };
  }

  const res = await fetch(url, {
    headers: { "User-Agent": "mini-sandbox/1.0" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const contentType = res.headers.get("content-type") ?? "";
  const { text: raw, limited } = await readLimitedText(res, MAX_FETCH_BYTES);
  const text = contentType.includes("html") ? htmlToText(raw) : raw;

  cache[key] = { ts: Date.now(), content: text, limited };
  saveCache(cache);
  return { content: text, cached: false, limited };
}

async function readLimitedText(res, maxBytes) {
  if (!res.body) return { text: await res.text(), limited: false };

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let limited = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        limited = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return { text: Buffer.concat(chunks).toString("utf8"), limited };
}

async function fetchTool(args) {
  const { url, force = false, maxLines = MAX_LINES } = args ?? {};
  const data = await fetchUrl(url, force);
  const formatted = formatOutput(data.content, maxLines);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      totalLines: formatted.totalLines,
      totalBytes: formatted.totalBytes,
      truncated: formatted.truncated,
      cached: data.cached,
      downloadLimited: data.limited,
    },
  };
}

export const tools = {
  tools: [
    {
      name: "sandbox_run",
      description:
        "Run a shell command and return only stdout. Large output is automatically truncated to head+tail (default 60 lines). Use this instead of bash when you don't need every line of output.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "Max lines before truncation. Default: 60.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "sandbox_read",
      description:
        "Read a local UTF-8 text file and return truncated head+tail output. Use this instead of cat/type/Get-Content when the full file is not needed.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "Max lines before truncation. Default: 60.",
          },
          fromLine: {
            type: "integer",
            minimum: 1,
            description: "First 1-based line to read. Optional.",
          },
          toLine: {
            type: "integer",
            minimum: 1,
            description: "Last 1-based line to read. Optional.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "sandbox_search",
      description:
        "Search local files with ripgrep and return bounded filename:line:match output. Uses system rg, OpenCode's cached rg, or Pi's cached rg when available.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "File or directory to search. Default: ." },
          include: { type: "string", description: "File glob to include, for example *.js or *.{ts,tsx}" },
          maxMatches: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            description: "Maximum matches before truncation. Default: 100.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "Max output lines before head+tail truncation. Default: 60.",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "sandbox_fetch",
      description:
        "Fetch a URL and return its content as plain text (HTML is stripped to readable text). Large output is automatically truncated to head+tail. Results are cached for 1 hour; use force=true to bypass.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          force: { type: "boolean", description: "Skip cache. Default: false." },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "Max lines before truncation. Default: 60.",
          },
        },
        required: ["url"],
      },
    },
  ],
};

export async function callTool(name, args) {
  if (name === "sandbox_run") return await runTool(args);
  if (name === "sandbox_read") return await readTool(args);
  if (name === "sandbox_search") return await searchTool(args);
  if (name === "sandbox_fetch") return await fetchTool(args);

  const error = new Error(`Unknown tool: ${name}`);
  error.code = -32601;
  throw error;
}
