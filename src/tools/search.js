import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_BYTES, MAX_LINES, MAX_READ_BYTES, RG_NAME } from "../constants.js";
import { formatOutput } from "../output.js";
import { commandError, runProcessLines } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, savingsForText, savingsMeta, validateInteger } from "./shared.js";

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

export async function findRg() {
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

export async function searchTool(args) {
  const {
    pattern,
    path: searchPath = ".",
    include,
    maxMatches = 100,
    maxLines = MAX_LINES,
    maxBytes = MAX_BYTES,
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
  const byteLimit = validateInteger(maxBytes, "context_search maxBytes", 1024, MAX_BYTES);

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
    const text = "(no matches)";
    const totalBytes = Buffer.byteLength(text, "utf8");
    const meta = {
      rgPath: rg,
      totalMatches: 0,
      totalMatchesKnown: true,
      shownMatches: 0,
      totalBytes,
      returnedBytes: totalBytes,
      savedBytes: 0,
      savedPercent: 0,
      estimatedTokensSaved: 0,
      truncated: false,
      durationMs: result.durationMs,
    };
    await recordStats("context_search", meta);

    return {
      content: [{ type: "text", text }],
      _meta: meta,
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
  const formatted = formatOutput(text, lineLimit, byteLimit);
  const searchSavings = matchLimited ? savingsForText(originalText, formatted.text) : savingsMeta(formatted);
  const meta = {
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
  };
  await recordStats("context_search", meta);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: meta,
  };
}
