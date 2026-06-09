#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

const SERVER_NAME = "mini-sandbox";
const SERVER_VERSION = "1.0.0";
const MAX_LINES = 60;
const MAX_BYTES = 32 * 1024;
const MAX_COMMAND_BYTES = 100 * 1024 * 1024;
const MAX_FETCH_BYTES = normalizeByteLimit(process.env.MINI_SANDBOX_MAX_FETCH_BYTES, 10 * 1024 * 1024);
const MAX_READ_BYTES = normalizeByteLimit(process.env.MINI_SANDBOX_MAX_READ_BYTES, 10 * 1024 * 1024);
const COMMAND_SHELL = process.env.MINI_SANDBOX_SHELL || true;
const COMMAND_SHELL_NAME = typeof COMMAND_SHELL === "string"
  ? COMMAND_SHELL
  : process.platform === "win32"
    ? process.env.ComSpec || "cmd.exe"
    : process.env.SHELL || "/bin/sh";
const CACHE_TTL_MS = 3_600_000;

const CACHE_DIR = path.join(os.homedir(), ".mini-sandbox");
const CACHE_FILE = path.join(CACHE_DIR, "cache.json");
const RG_NAME = process.platform === "win32" ? "rg.exe" : "rg";

fs.mkdirSync(CACHE_DIR, { recursive: true });

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

let cache = loadCache();

function normalizeByteLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: "2.0", id, error });
}

function sendErrorIfRequest(hasId, id, code, message, data) {
  if (hasId) sendError(id, code, message, data);
}

function hasRequestId(message) {
  return Object.prototype.hasOwnProperty.call(message, "id");
}

function rpcCode(error) {
  return Number.isInteger(error.code) ? error.code : -32000;
}

function normalizeMaxLines(maxLines = MAX_LINES) {
  const numeric = Number(maxLines);
  const value = Number.isFinite(numeric) ? Math.trunc(numeric) : MAX_LINES;
  return Math.max(10, Math.min(value, 200));
}

function normalizeLimit(value, fallback, min, max) {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.max(min, Math.min(parsed, max));
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

function formatOutput(output, maxLines = MAX_LINES) {
  const limit = normalizeMaxLines(maxLines);
  const totalBytes = Buffer.byteLength(output, "utf8");
  const lines = output.split("\n");
  const totalLines = lines.length;

  if (totalLines <= limit && totalBytes <= MAX_BYTES) {
    return { text: output || "(no output)", totalLines, totalBytes, truncated: false };
  }

  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  const summary = [
    `╔══ ${totalLines} lines · ${(totalBytes / 1024).toFixed(1)} KB · showing first ${head} + last ${tail} ══╗`,
    ...lines.slice(0, head),
    `╟── … ${totalLines - head - tail} lines omitted … ──╢`,
    ...lines.slice(-tail),
    `╚${"═".repeat(58)}╝`,
  ].join("\n");

  return { text: summary, totalLines, totalBytes, truncated: true };
}

function commandErrorData(error) {
  const data = {};

  if (error.status !== null && error.status !== undefined) data.exitCode = error.status;
  if (error.signal) data.signal = error.signal;

  for (const stream of ["stdout", "stderr"]) {
    const value = error[stream];
    if (!value) continue;

    const output = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    data[stream] = formatOutput(output).text;
  }

  return Object.keys(data).length > 0 ? data : undefined;
}

function commandError(command, code, signal, stdout, stderr, timedOut = false, outputTooLarge = false) {
  const detail = outputTooLarge
    ? `output exceeded ${MAX_COMMAND_BYTES} bytes`
    : timedOut
      ? `timed out after 120000ms`
      : `exited with code ${code}`;
  const error = new Error(`Command failed: ${command} (${detail})`);

  error.status = code;
  error.signal = signal;
  error.stdout = stdout;
  error.stderr = stderr;
  throw error;
}

async function runProcess(file, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputTooLarge = false;

    function appendOutput(chunks, chunk) {
      if (outputTooLarge) return;

      const remaining = MAX_COMMAND_BYTES - outputBytes;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(chunk.slice(0, remaining));
        outputBytes = MAX_COMMAND_BYTES;
        outputTooLarge = true;
        child.kill();
        return;
      }

      chunks.push(chunk);
      outputBytes += chunk.byteLength;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeout ?? 120_000);

    child.stdout.on("data", (chunk) => appendOutput(stdout, chunk));
    child.stderr.on("data", (chunk) => appendOutput(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - started,
        timedOut,
        outputTooLarge,
      });
    });
  });
}

function errorData(error) {
  const data = {};
  for (const key of ["code", "errno", "address", "port"]) {
    if (typeof error[key] === "string" || typeof error[key] === "number") data[key] = error[key];
  }
  if (error.cause) {
    data.cause = {};
    for (const key of ["code", "errno", "address", "port"]) {
      if (typeof error.cause[key] === "string" || typeof error.cause[key] === "number") {
        data.cause[key] = error.cause[key];
      }
    }
  }

  return Object.keys(data).length > 0 ? data : undefined;
}

async function runCommand(command) {
  return await new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, {
      shell: COMMAND_SHELL,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputTooLarge = false;

    function appendOutput(chunks, chunk) {
      if (outputTooLarge) return;

      const remaining = MAX_COMMAND_BYTES - outputBytes;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(chunk.slice(0, remaining));
        outputBytes = MAX_COMMAND_BYTES;
        outputTooLarge = true;
        child.kill();
        return;
      }

      chunks.push(chunk);
      outputBytes += chunk.byteLength;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 120_000);

    child.stdout.on("data", (chunk) => appendOutput(stdout, chunk));
    child.stderr.on("data", (chunk) => appendOutput(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      const durationMs = Date.now() - started;

      if (code === 0 && !timedOut) {
        resolve({ stdout: stdoutText, durationMs });
        return;
      }

      try {
        commandError(command, code, signal, stdoutText, stderrText, timedOut, outputTooLarge);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function cmd(args) {
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

async function readFileTool(args) {
  const { path: filePath, maxLines = MAX_LINES } = args ?? {};
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

  const { text, limited } = await readLimitedFile(resolved, stat.size, MAX_READ_BYTES);
  const formatted = formatOutput(text, maxLines);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      path: resolved,
      sizeBytes: stat.size,
      totalLines: formatted.totalLines,
      totalBytes: formatted.totalBytes,
      truncated: formatted.truncated,
      fileReadLimited: limited,
    },
  };
}

async function readLimitedFile(filePath, size, maxBytes) {
  if (size <= maxBytes) {
    return { text: await fs.promises.readFile(filePath, "utf8"), limited: false };
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

  const result = await runProcess(rg, rgArgs, { cwd: process.cwd(), timeout: 120_000 });
  if (result.code === 1) {
    return {
      content: [{ type: "text", text: "(no matches)" }],
      _meta: { rgPath: rg, totalMatches: 0, shownMatches: 0, truncated: false, durationMs: result.durationMs },
    };
  }
  if (result.code !== 0) {
    commandError(`rg ${rgArgs.join(" ")}`, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge);
  }

  const output = result.stdout.trimEnd();
  const matches = output ? output.split("\n") : [];
  const shown = matches.slice(0, limit);
  const matchLimited = matches.length > limit;
  const text = matchLimited
    ? [...shown, `... ${matches.length - limit} matches omitted ...`].join("\n")
    : output || "(no matches)";
  const formatted = formatOutput(text, maxLines);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      rgPath: rg,
      totalMatches: matches.length,
      shownMatches: shown.length,
      totalLines: formatted.totalLines,
      totalBytes: formatted.totalBytes,
      truncated: matchLimited || formatted.truncated,
      durationMs: result.durationMs,
    },
  };
}

function htmlToText(html) {
  let text = html
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

  return text;
}

async function fetchUrl(url, force) {
  try { new URL(url); } catch {
    const error = new Error("sandbox_fetch requires a valid URL");
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
  const text = contentType.includes("html")
    ? htmlToText(raw)
    : raw;

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

const tools = {
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

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let id;
  let hasId = false;
  try {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      sendError(null, -32700, e.message);
      return;
    }

    hasId = hasRequestId(msg);
    ({ id } = msg);
    const { method, params } = msg;

    if (method === "initialize") {
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: `Use sandbox_run instead of bash/terminal for any command whose full output you don't need. Use sandbox_read instead of cat/type/Get-Content for local files whose full content you don't need. Use sandbox_search instead of raw rg/grep commands when you need bounded local search results. Use sandbox_fetch instead of web_fetch/webfetch for any page you don't need raw HTML from. Read the _meta field after each call: if truncated is true, you can re-run with higher maxLines, pre-filter, or fall back to the native tool.`,
        },
      });
    } else if (method === "notifications/initialized") {
      // no response needed
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: tools });
    } else if (method === "tools/call") {
      const { name, arguments: args } = params ?? {};
      if (name === "sandbox_run") {
        try {
          const result = await cmd(args);
          if (hasId) send({ jsonrpc: "2.0", id, result });
        } catch (e) {
          sendErrorIfRequest(hasId, id, rpcCode(e), e.message, commandErrorData(e));
        }
      } else if (name === "sandbox_read") {
        try {
          const result = await readFileTool(args);
          if (hasId) send({ jsonrpc: "2.0", id, result });
        } catch (e) {
          sendErrorIfRequest(hasId, id, rpcCode(e), e.message, errorData(e));
        }
      } else if (name === "sandbox_search") {
        try {
          const result = await searchTool(args);
          if (hasId) send({ jsonrpc: "2.0", id, result });
        } catch (e) {
          sendErrorIfRequest(hasId, id, rpcCode(e), e.message, commandErrorData(e) ?? errorData(e));
        }
      } else if (name === "sandbox_fetch") {
        try {
          const { url, force = false, maxLines = MAX_LINES } = args ?? {};
          const data = await fetchUrl(url, force);
          const formatted = formatOutput(data.content, maxLines);
          if (hasId) {
            send({
              jsonrpc: "2.0", id,
              result: {
                content: [{ type: "text", text: formatted.text }],
                _meta: {
                  totalLines: formatted.totalLines,
                  totalBytes: formatted.totalBytes,
                  truncated: formatted.truncated,
                  cached: data.cached,
                  downloadLimited: data.limited,
                },
              },
            });
          }
        } catch (e) {
          sendErrorIfRequest(hasId, id, rpcCode(e), e.message, errorData(e));
        }
      } else {
        sendErrorIfRequest(hasId, id, -32601, `Unknown tool: ${name}`);
      }
    } else {
      sendErrorIfRequest(hasId, id, -32601, `Unknown method: ${method}`);
    }
  } catch (e) {
    sendErrorIfRequest(hasId, id, rpcCode(e), e.message);
  }
});

process.stderr.write(`[${SERVER_NAME} v${SERVER_VERSION}] ready (stdio)\n`);
