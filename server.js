#!/usr/bin/env node

import { MAX_RPC_BATCH_CONCURRENCY, MAX_RPC_BATCH_SIZE, MAX_RPC_LINE_BYTES, MAX_RPC_TOOL_CONCURRENCY, SERVER_NAME, SERVER_VERSION } from "./src/constants.js";
import { tools, callTool } from "./src/tools.js";
import { commandErrorData, errorData } from "./src/process.js";

const PROTOCOL_VERSION = "2024-11-05";

function handleStdoutError(error) {
  if (error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED") process.exit(0);
  throw error;
}

process.stdout.on("error", handleStdoutError);

function send(message) {
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch (error) {
    handleStdoutError(error);
  }
}

function sendError(id, code, message, data) {
  send(errorResponse(id, code, message, data));
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function resultResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function isProtocolToolError(error) {
  return error?.code === -32601 || error?.code === -32602 || error?.code === -32002;
}

function toolErrorResult(error) {
  const diagnosticMeta = commandErrorData(error) ?? errorData(error) ?? {};
  const text = formatToolErrorText(error, Object.keys(diagnosticMeta).length > 0 ? diagnosticMeta : undefined);
  const returnedBytes = Buffer.byteLength(text, "utf8");
  return {
    content: [{ type: "text", text }],
    isError: true,
    _meta: {
      ...diagnosticMeta,
      truncated: false,
      response: {
        totalLines: text.split("\n").length,
        totalBytes: returnedBytes,
        returnedBytes,
        savedBytes: 0,
        savedPercent: 0,
        estimatedTokensSaved: 0,
        truncated: false,
      },
    },
  };
}

function formatToolErrorText(error, meta) {
  if (!meta || typeof meta !== "object") return error.message;

  const lines = [error.message];
  const details = [];
  for (const key of ["exitCode", "signal", "timedOut", "outputTooLarge", "timeoutMs", "httpStatus", "httpStatusText", "code", "errno", "address", "port", "url"]) {
    if (meta[key] !== undefined) details.push(`${key}: ${meta[key]}`);
  }
  if (details.length > 0) lines.push("", "details:", ...details);
  if (meta.stderr) lines.push("", "stderr:", meta.stderr);
  if (meta.stdout) lines.push("", "stdout:", meta.stdout);
  if (meta.cause?.message || meta.cause?.code) {
    lines.push("", "cause:", [meta.cause.code, meta.cause.message].filter(Boolean).join(" - "));
  }

  return lines.join("\n");
}

function isRequestObject(message) {
  return message !== null && typeof message === "object" && !Array.isArray(message);
}

function isValidRequestId(id) {
  return id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

function hasRequestId(message) {
  return Object.prototype.hasOwnProperty.call(message, "id");
}

function invalidParams(message) {
  const error = new Error(message);
  error.code = -32602;
  throw error;
}

function validateToolCallParams(params) {
  if (!isRequestObject(params)) invalidParams("tools/call params must be an object");

  const { name, arguments: args } = params;
  if (typeof name !== "string" || name.trim() === "") {
    invalidParams("tools/call params.name must be a non-empty string");
  }
  if (args !== undefined && !isRequestObject(args)) {
    invalidParams("tools/call params.arguments must be an object when provided");
  }

  return { name, args };
}

function validateInitializeParams(params) {
  if (params === undefined) return;
  if (!isRequestObject(params)) invalidParams("initialize params must be an object when provided");
  if (params.protocolVersion !== undefined && typeof params.protocolVersion !== "string") {
    invalidParams("initialize params.protocolVersion must be a string when provided");
  }
}

function rpcCode(error) {
  return Number.isInteger(error.code) ? error.code : -32000;
}

let activeToolCalls = 0;
const waitingToolCalls = [];

function acquireToolCallSlot() {
  if (activeToolCalls < MAX_RPC_TOOL_CONCURRENCY) {
    activeToolCalls++;
    return undefined;
  }
  return new Promise((resolve) => waitingToolCalls.push(resolve));
}

async function runToolCallLimited(fn) {
  await acquireToolCallSlot();
  try {
    return await fn();
  } finally {
    const next = waitingToolCalls.shift();
    if (next) next();
    else activeToolCalls--;
  }
}

const instructions = "Prefer these bounded tools to keep context small: run for shell stdout, logs for tests/builds/lints/logs, read for file previews, search for local text/AST search, discover before broad repo reads, fetch for readable web pages, diff for git status/diff/history, and usage for savings/guidance. "
  + "Use native client tools only when you need complete output, exact stderr/exit semantics, interactivity, raw HTML, or unsupported behavior. "
  + "After each call, check _meta.truncated or _meta.response.truncated; if true, retry with a narrower query/path/range or higher maxLines/maxBytes before falling back.";

let initializeAccepted = false;
let sessionInitialized = false;

function requireInitialized(method) {
  if (sessionInitialized) return;
  const error = new Error(`${method} requires initialize followed by notifications/initialized`);
  error.code = -32002;
  throw error;
}

async function handleMessage(msg) {
  if (!isRequestObject(msg)) return errorResponse(null, -32600, "Invalid Request");

  const hasId = hasRequestId(msg);
  const { id, method, params } = msg;
  if (hasId && !isValidRequestId(id)) return errorResponse(null, -32600, "Invalid Request");
  if (msg.jsonrpc !== "2.0") return errorResponse(hasId ? id : null, -32600, "Invalid Request");
  if (typeof method !== "string") return errorResponse(hasId ? id : null, -32600, "Invalid Request");

  try {
    if (method === "initialize") {
      validateInitializeParams(params);
      if (!hasId) return undefined;
      initializeAccepted = true;
      return resultResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions,
      });
    }

    if (method === "notifications/initialized") {
      if (initializeAccepted) sessionInitialized = true;
      return undefined;
    }

    if (method === "tools/list") {
      requireInitialized(method);
      if (!hasId) return undefined;
      return resultResponse(id, tools);
    }

    if (method === "tools/call") {
      requireInitialized(method);
      if (!hasId) return undefined;
      const { name, args } = validateToolCallParams(params);
      const result = await runToolCallLimited(() => callTool(name, args));
      return resultResponse(id, result);
    }

    if (!hasId) return undefined;
    return errorResponse(id, -32601, `Unknown method: ${method}`);
  } catch (e) {
    if (!hasId) return undefined;
    if (method === "tools/call" && !isProtocolToolError(e)) return resultResponse(id, toolErrorResult(e));
    return errorResponse(id, rpcCode(e), e.message, commandErrorData(e) ?? errorData(e));
  }
}

async function mapLimited(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function handleLine(line) {
  try {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      sendError(null, -32700, e.message);
      return;
    }

    if (Array.isArray(msg)) {
      if (msg.length === 0) {
        sendError(null, -32600, "Invalid Request");
        return;
      }
      if (msg.length > MAX_RPC_BATCH_SIZE) {
        sendError(null, -32600, `Batch size exceeds ${MAX_RPC_BATCH_SIZE}`);
        return;
      }

      const responses = (await mapLimited(msg, MAX_RPC_BATCH_CONCURRENCY, handleMessage)).filter(Boolean);
      if (responses.length > 0) send(responses);
      return;
    }

    const response = await handleMessage(msg);
    if (response) send(response);
  } catch (e) {
    sendError(null, rpcCode(e), e.message);
  }
}

let lineChunks = [];
let lineBytes = 0;
let discardingLine = false;

function resetLine() {
  lineChunks = [];
  lineBytes = 0;
}

function appendLinePart(part) {
  if (discardingLine || part.byteLength === 0) return;
  if (lineBytes + part.byteLength > MAX_RPC_LINE_BYTES) {
    resetLine();
    discardingLine = true;
    return;
  }

  lineChunks.push(part);
  lineBytes += part.byteLength;
}

function finishLine() {
  if (discardingLine) {
    sendError(null, -32600, `Request line exceeds ${MAX_RPC_LINE_BYTES} bytes`);
    discardingLine = false;
    return;
  }

  const line = Buffer.concat(lineChunks, lineBytes).toString("utf8").replace(/\r$/, "");
  resetLine();
  void handleLine(line);
}

process.stdin.on("data", (chunk) => {
  let offset = 0;

  for (;;) {
    const newline = chunk.indexOf(0x0a, offset);
    const end = newline === -1 ? chunk.length : newline;
    appendLinePart(chunk.subarray(offset, end));
    if (newline === -1) return;
    finishLine();
    offset = newline + 1;
  }
});

process.stdin.on("end", () => {
  if (lineBytes > 0 || discardingLine) finishLine();
});

process.stderr.write(`[${SERVER_NAME} v${SERVER_VERSION}] ready (stdio)\n`);
