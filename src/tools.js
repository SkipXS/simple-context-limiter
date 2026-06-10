import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  ALLOW_NON_HTTP_FETCH,
  CACHE_MAX_BYTES,
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
import { decodeUtf8, formatOutput } from "./output.js";
import { commandError, runCommand, runProcessLines } from "./process.js";

async function loadCache() {
  try { return pruneCache(JSON.parse(await fs.promises.readFile(CACHE_FILE, "utf8"))); } catch {
    return {};
  }
}

async function saveCache(nextCache) {
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

let cache;

async function getCache() {
  if (cache === undefined) cache = await loadCache();
  return cache;
}

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

  if (process.env.SIMPLE_CONTEXT_LIMITER_RG_PATH) candidates.push(process.env.SIMPLE_CONTEXT_LIMITER_RG_PATH);

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

function invalidParams(message) {
  const error = new Error(message);
  error.code = -32602;
  throw error;
}

function integerRange(min, max) {
  return max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
}

function validateInteger(value, name, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalidParams(`${name} must be an integer ${integerRange(min, max)}`);
  }
  if (value < min || (max !== undefined && value > max)) {
    invalidParams(`${name} must be ${integerRange(min, max)}`);
  }
  return value;
}

function savingsMeta(formatted) {
  return {
    returnedBytes: formatted.returnedBytes,
    savedBytes: formatted.savedBytes,
    estimatedTokensSaved: formatted.estimatedTokensSaved,
  };
}

function savingsForText(originalText, returnedText) {
  const totalBytes = Buffer.byteLength(originalText, "utf8");
  const returnedBytes = Buffer.byteLength(returnedText, "utf8");
  const savedBytes = Math.max(0, totalBytes - returnedBytes);

  return {
    totalBytes,
    returnedBytes,
    savedBytes,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
  };
}

async function runTool(args) {
  const { command, maxLines = MAX_LINES } = args ?? {};
  if (typeof command !== "string" || command.trim() === "") {
    invalidParams("context_run requires a non-empty command string");
  }
  const lineLimit = validateInteger(maxLines, "context_run maxLines", 10, 200);

  const { stdout, durationMs } = await runCommand(command);
  const formatted = formatOutput(stdout, lineLimit);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      totalLines: formatted.totalLines,
      totalBytes: formatted.totalBytes,
      ...savingsMeta(formatted),
      truncated: formatted.truncated,
      durationMs,
      shell: COMMAND_SHELL_NAME,
    },
  };
}

async function readTool(args) {
  const { path: filePath, maxLines = MAX_LINES, fromLine, toLine } = args ?? {};
  if (typeof filePath !== "string" || filePath.trim() === "") {
    invalidParams("context_read requires a non-empty path string");
  }
  const lineLimit = validateInteger(maxLines, "context_read maxLines", 10, 200);

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
    ? await readLineRange(resolved, range.fromLine, range.toLine, lineLimit, MAX_READ_BYTES)
    : await readLimitedFile(resolved, stat.size, MAX_READ_BYTES);
  const formatted = formatOutput(text, lineLimit);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      path: resolved,
      sizeBytes: stat.size,
      totalLines: formatted.totalLines,
      totalBytes: formatted.totalBytes,
      ...savingsMeta(formatted),
      truncated: formatted.truncated || rangeLimited || limited,
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
  const from = fromLine === undefined ? 1 : validateInteger(fromLine, "context_read fromLine", 1);
  const to = toLine === undefined ? Infinity : validateInteger(toLine, "context_read toLine", 1);

  if (to < from) {
    invalidParams("context_read toLine must be greater than or equal to fromLine");
  }

  return { fromLine: from, toLine: to };
}

async function readLineRange(filePath, fromLine, toLine, maxLines, maxBytes) {
  const input = fs.createReadStream(filePath);
  const decoder = new StringDecoder("utf8");
  const lines = [];
  let lineNumber = 0;
  let bytes = 0;
  let limited = false;
  let rangeLimited = false;
  let currentLine = "";

  function shouldCollectCurrentLine() {
    const currentLineNumber = lineNumber + 1;
    return currentLineNumber >= fromLine && currentLineNumber <= toLine;
  }

  function appendToCurrentLine(text) {
    if (!shouldCollectCurrentLine()) return true;
    if (lines.length >= maxLines) {
      rangeLimited = true;
      return false;
    }

    currentLine += text;
    if (bytes + Buffer.byteLength(currentLine, "utf8") > maxBytes) {
      limited = true;
      return false;
    }

    return true;
  }

  function finishCurrentLine() {
    const line = currentLine.endsWith("\r") ? currentLine.slice(0, -1) : currentLine;
    currentLine = "";
    lineNumber++;

    if (lineNumber < fromLine) return true;
    if (lineNumber > toLine) return false;

    lines.push(line);
    bytes += Buffer.byteLength(line, "utf8");

    if (lines.length >= maxLines && lineNumber < toLine) {
      rangeLimited = true;
      return false;
    }

    return true;
  }

  function processText(text) {
    let offset = 0;

    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const part = newline === -1 ? text.slice(offset) : text.slice(offset, newline);
      if (!appendToCurrentLine(part)) return false;
      if (newline === -1) return true;
      if (!finishCurrentLine()) return false;
      offset = newline + 1;
    }

    return true;
  }

  try {
    for await (const chunk of input) {
      if (!processText(decoder.write(chunk))) {
        input.destroy();
        break;
      }
    }

    if (!limited && !rangeLimited && lineNumber < toLine) {
      processText(decoder.end());
      if (currentLine) finishCurrentLine();
    }
  } finally {
    input.destroy();
  }

  return {
    text: lines.join("\n"),
    limited,
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
        decodeUtf8(head.subarray(0, headRead.bytesRead), { trimEnd: true }),
        `╟── … file content omitted after ${(maxBytes / 1024).toFixed(1)} KB preview … ──╢`,
        decodeUtf8(tail.subarray(0, tailRead.bytesRead), { trimStart: true }),
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
    invalidParams("context_search requires a non-empty pattern string");
  }
  if (typeof searchPath !== "string" || searchPath.trim() === "") {
    invalidParams("context_search requires path to be a non-empty string when provided");
  }
  if (include !== undefined && typeof include !== "string") {
    invalidParams("context_search include must be a string when provided");
  }
  const limit = validateInteger(maxMatches, "context_search maxMatches", 1, 1000);
  const lineLimit = validateInteger(maxLines, "context_search maxLines", 10, 200);

  const rg = await findRg();
  if (!rg) {
    const error = new Error(
      "ripgrep was not found. Install rg, set SIMPLE_CONTEXT_LIMITER_RG_PATH, or run from OpenCode/Pi after their rg helper has been installed.",
    );
    error.code = -32000;
    throw error;
  }

  const rgArgs = ["--line-number", "--with-filename", "--color", "never", "--no-heading"];
  if (include) rgArgs.push("--glob", include);
  rgArgs.push("--", pattern, searchPath);

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
        totalBytes: 0,
        returnedBytes: Buffer.byteLength("(no matches)", "utf8"),
        savedBytes: 0,
        estimatedTokensSaved: 0,
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
  const originalText = matches.join("\n");
  const text = matchLimited
    ? [...shown, `... more matches omitted ...`].join("\n")
    : originalText || "(no matches)";
  const formatted = formatOutput(text, lineLimit);
  const searchSavings = matchLimited ? savingsForText(originalText, formatted.text) : savingsMeta(formatted);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      rgPath: rg,
      totalMatches: matchLimited ? undefined : matches.length,
      totalMatchesKnown: !matchLimited,
      matchesRead: matchLimited ? matches.length : undefined,
      shownMatches: shown.length,
      totalLines: formatted.totalLines,
      totalBytes: searchSavings.totalBytes ?? formatted.totalBytes,
      ...searchSavings,
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
    .replace(/&#(x[0-9a-f]+|\d+);/gi, decodeNumericHtmlEntity)
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ +/g, " ")
    .replace(/^[ \t]+/gm, "")
    .trim();
}

function decodeNumericHtmlEntity(match, value) {
  const codePoint = value.toLowerCase().startsWith("x")
    ? Number.parseInt(value.slice(1), 16)
    : Number.parseInt(value, 10);

  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;

  return String.fromCodePoint(codePoint);
}

async function fetchUrl(url, force) {
  let parsed;
  try { parsed = new URL(url); } catch {
    invalidParams("context_fetch requires a valid URL");
  }
  if (!ALLOW_NON_HTTP_FETCH && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    invalidParams("context_fetch only allows http and https URLs by default; set SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH=1 to allow other schemes");
  }

  const key = createHash("sha256").update(url).digest("hex");
  const currentCache = await getCache();
  const cached = currentCache[key];
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { content: cached.content, cached: true, limited: cached.limited ?? false };
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "simple-context-limiter/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    const error = new Error(`Fetch failed: ${url}`);
    error.code = -32000;
    error.url = url;
    error.cause = cause;
    throw error;
  }

  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} ${res.statusText}`);
    error.code = -32000;
    error.httpStatus = res.status;
    error.httpStatusText = res.statusText;
    error.url = url;
    throw error;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const { text: raw, limited } = await readLimitedText(res, MAX_FETCH_BYTES);
  const text = contentType.includes("html") ? htmlToText(raw) : raw;

  currentCache[key] = { ts: Date.now(), content: text, limited };
  await saveCache(currentCache);
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

  return { text: decodeUtf8(Buffer.concat(chunks), { trimEnd: limited }), limited };
}

async function fetchTool(args) {
  const { url, force = false, maxLines = MAX_LINES } = args ?? {};
  if (force !== undefined && typeof force !== "boolean") {
    invalidParams("context_fetch force must be a boolean when provided");
  }
  const lineLimit = validateInteger(maxLines, "context_fetch maxLines", 10, 200);

  const data = await fetchUrl(url, force);
  const formatted = formatOutput(data.content, lineLimit);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      totalLines: formatted.totalLines,
      totalBytes: formatted.totalBytes,
      ...savingsMeta(formatted),
      truncated: formatted.truncated || data.limited,
      cached: data.cached,
      downloadLimited: data.limited,
    },
  };
}

export const tools = {
  tools: [
    {
      name: "context_run",
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
      name: "context_read",
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
      name: "context_search",
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
      name: "context_fetch",
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
  if (name === "context_run") return await runTool(args);
  if (name === "context_read") return await readTool(args);
  if (name === "context_search") return await searchTool(args);
  if (name === "context_fetch") return await fetchTool(args);

  const error = new Error(`Unknown tool: ${name}`);
  error.code = -32601;
  throw error;
}
