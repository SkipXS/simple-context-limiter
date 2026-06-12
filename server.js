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
      if (hasId) {
        send({
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions,
          },
        });
      }
    } else if (method === "notifications/initialized") {
      // no response needed
    } else if (method === "tools/list") {
      if (hasId) send({ jsonrpc: "2.0", id, result: tools });
    } else if (method === "tools/call") {
      try {
        const { name, arguments: args } = params ?? {};
        const result = await callTool(name, args);
        if (hasId) send({ jsonrpc: "2.0", id, result });
      } catch (e) {
        sendErrorIfRequest(hasId, id, rpcCode(e), e.message, commandErrorData(e) ?? errorData(e));
      }
    } else {
      sendErrorIfRequest(hasId, id, -32601, `Unknown method: ${method}`);
    }
  } catch (e) {
    sendErrorIfRequest(hasId, id, rpcCode(e), e.message);
  }
});

process.stderr.write(`[${SERVER_NAME} v${SERVER_VERSION}] ready (stdio)\n`);
