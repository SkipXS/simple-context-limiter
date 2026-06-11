import { MAX_BYTES, MAX_LINES, MAX_READ_BYTES } from "../constants.js";
import { formatOutput } from "../output.js";
import { commandError, runProcessLines } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, savingsMeta, validateInteger } from "./shared.js";
import { findRg } from "./search.js";

export async function grepContextTool(args) {
  const { pattern, path: searchPath = ".", include, contextLines = 2, maxMatches = 50, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (typeof pattern !== "string" || pattern.trim() === "") invalidParams("context_grep_context requires a non-empty pattern string");
  if (typeof searchPath !== "string" || searchPath.trim() === "") invalidParams("context_grep_context path must be a non-empty string when provided");
  if (include !== undefined && typeof include !== "string") invalidParams("context_grep_context include must be a string when provided");
  const contextLimit = validateInteger(contextLines, "context_grep_context contextLines", 0, 10);
  const matchLimit = validateInteger(maxMatches, "context_grep_context maxMatches", 1, 500);
  const lineLimit = validateInteger(maxLines, "context_grep_context maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_grep_context maxBytes", 1024, MAX_BYTES);
  const rg = await findRg();
  if (!rg) {
    const error = new Error("ripgrep was not found. Install rg, set SIMPLE_CONTEXT_LIMITER_RG_PATH, or run from OpenCode/Pi after their rg helper has been installed.");
    error.code = -32000;
    throw error;
  }

  const started = Date.now();
  const rgArgs = ["--line-number", "--with-filename", "--color", "never", "--no-heading", "-C", String(contextLimit)];
  if (include) rgArgs.push("--glob", include);
  rgArgs.push("--", pattern, searchPath);
  const result = await runProcessLines(rg, rgArgs, { cwd: process.cwd(), timeout: 120_000, maxLines: matchLimit * (contextLimit * 2 + 3), maxBytes: MAX_READ_BYTES });
  if (result.code === 1) return await noMatches(rg, result.durationMs);
  if (result.code !== 0 && !result.truncated && !result.outputTooLarge) commandError(`rg ${rgArgs.join(" ")}`, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge);

  const text = result.lines.join("\n") || "(no matches)";
  const formatted = formatOutput(text, lineLimit, byteLimit);
  const meta = { rgPath: rg, linesRead: result.lines.length, totalLines: formatted.totalLines, totalBytes: formatted.totalBytes, ...savingsMeta(formatted), truncated: result.truncated || result.outputTooLarge || formatted.truncated, durationMs: Date.now() - started };
  await recordStats("context_grep_context", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

async function noMatches(rg, durationMs) {
  const text = "(no matches)";
  const totalBytes = Buffer.byteLength(text, "utf8");
  const meta = { rgPath: rg, linesRead: 0, totalLines: 1, totalBytes, returnedBytes: totalBytes, savedBytes: 0, savedPercent: 0, estimatedTokensSaved: 0, truncated: false, durationMs };
  await recordStats("context_grep_context", meta);
  return { content: [{ type: "text", text }], _meta: meta };
}
