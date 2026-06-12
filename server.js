#!/usr/bin/env node

import { MAX_RPC_BATCH_CONCURRENCY, MAX_RPC_BATCH_SIZE, MAX_RPC_LINE_BYTES, SERVER_NAME, SERVER_VERSION } from "./src/constants.js";
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
  return error?.code === -32601 || error?.code === -32602;
}

function toolErrorResult(error) {
  const meta = commandErrorData(error) ?? errorData(error);
  const result = {
    content: [{ type: "text", text: error.message }],
    isError: true,
  };
  if (meta !== undefined) result._meta = meta;
  return result;
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

const instructions = "Default to run, logs, read, search, discover, fetch, diff, and usage for exploratory commands, logs, file previews, searches, repo overview, tests, web pages, git previews, and usage stats. "
  + "Use run instead of bash/terminal for commands that may produce large output. "
  + "Use logs instead of run for tests, builds, lints, server logs, and other output where errors may appear in the middle. "
  + "Use read instead of cat/type/Get-Content for local file previews; pass paths when you need several known files. "
  + "Use search instead of raw rg/grep commands for bounded local search results; pass contextLines when you need surrounding lines. "
  + "Use discover for repo summaries, tracked-file lists, directory trees, and source outlines before broad file reads. "
  + "Use diff with mode=status before full diffs when you only need changed file names/status, and mode=history instead of raw git log for compact commit history. "
  + "Use fetch instead of web_fetch/webfetch for pages you do not need as raw HTML. "
  + "Use diff instead of raw git diff when reviewing working tree or staged changes. "
  + "Use usage for aggregate savings stats, local usage-pattern reports, or mode=guidance suggestions. "
  + "Use native shell/read/fetch/diff tools only when you specifically need complete output, exact stderr/exit behavior, interactivity, or unsupported behavior. "
  + "Read the _meta field after each call: if truncated is true, retry with a narrower query/range or higher maxLines/maxBytes before falling back to native tools.";

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
      return resultResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions,
      });
    }

    if (method === "notifications/initialized") return undefined;

    if (method === "tools/list") {
      if (!hasId) return undefined;
      return resultResponse(id, tools);
    }

    if (method === "tools/call") {
      const { name, args } = validateToolCallParams(params);
      const result = await callTool(name, args);
      if (!hasId) return undefined;
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
