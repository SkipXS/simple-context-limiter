#!/usr/bin/env node

import { createInterface } from "node:readline";
import { SERVER_NAME, SERVER_VERSION } from "./src/constants.js";
import { tools, callTool } from "./src/tools.js";
import { commandErrorData, errorData } from "./src/process.js";

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

function hasRequestId(message) {
  return Object.prototype.hasOwnProperty.call(message, "id");
}

function rpcCode(error) {
  return Number.isInteger(error.code) ? error.code : -32000;
}

const instructions = "Default to context_run, context_logs, context_read, context_search, context_discover, context_fetch, context_diff, and context_usage for exploratory commands, logs, file previews, searches, repo overview, tests, web pages, git previews, and usage stats. "
  + "Use context_run instead of bash/terminal for commands that may produce large output. "
  + "Use context_logs instead of context_run for tests, builds, lints, server logs, and other output where errors may appear in the middle. "
  + "Use context_read instead of cat/type/Get-Content for local file previews; pass paths when you need several known files. "
  + "Use context_search instead of raw rg/grep commands for bounded local search results; pass contextLines when you need surrounding lines. "
  + "Use context_discover for repo summaries, tracked-file lists, directory trees, and source outlines before broad file reads. "
  + "Use context_diff with mode=status before full diffs when you only need changed file names/status. "
  + "Use context_fetch instead of web_fetch/webfetch for pages you do not need as raw HTML. "
  + "Use context_diff instead of raw git diff when reviewing working tree or staged changes. "
  + "Use context_usage for aggregate savings stats or local usage-pattern reports. "
  + "Use native shell/read/fetch/diff tools only when you specifically need complete output, exact stderr/exit behavior, interactivity, or unsupported behavior. "
  + "Read the _meta field after each call: if truncated is true, retry with a narrower query/range or higher maxLines/maxBytes before falling back to native tools.";

const rl = createInterface({ input: process.stdin });

async function handleMessage(msg) {
  if (!isRequestObject(msg)) return errorResponse(null, -32600, "Invalid Request");

  const hasId = hasRequestId(msg);
  const { id, method, params } = msg;
  if (typeof method !== "string") return errorResponse(hasId ? id : null, -32600, "Invalid Request");

  try {
    if (method === "initialize") {
      if (!hasId) return undefined;
      return resultResponse(id, {
        protocolVersion: "2024-11-05",
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
      const { name, arguments: args } = params ?? {};
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

rl.on("line", async (line) => {
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

      const responses = (await Promise.all(msg.map(handleMessage))).filter(Boolean);
      if (responses.length > 0) send(responses);
      return;
    }

    const response = await handleMessage(msg);
    if (response) send(response);
  } catch (e) {
    sendError(null, rpcCode(e), e.message);
  }
});

process.stderr.write(`[${SERVER_NAME} v${SERVER_VERSION}] ready (stdio)\n`);
