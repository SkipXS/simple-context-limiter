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
const COMMAND_SHELL = process.env.MINI_SANDBOX_SHELL || true;
const CACHE_TTL_MS = 3_600_000;

const CACHE_DIR = path.join(os.homedir(), ".mini-sandbox");
const CACHE_FILE = path.join(CACHE_DIR, "cache.json");

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

      if (code === 0 && !timedOut) {
        resolve(stdoutText);
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

  const stdout = await runCommand(command);

  const formatted = formatOutput(stdout, maxLines);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      totalLines: formatted.totalLines,
      totalBytes: formatted.totalBytes,
      truncated: formatted.truncated,
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
          instructions: `Use sandbox_run instead of bash/terminal for any command whose full output you don't need. Use sandbox_fetch instead of web_fetch/webfetch for any page you don't need raw HTML from. Read the _meta field after each call: if truncated is true, you can re-run with higher maxLines, pre-filter with grep, or fall back to bash.`,
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
