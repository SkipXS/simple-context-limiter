import { COMMAND_SHELL_NAME, MAX_BYTES } from "../constants.js";
import { formatOutput } from "../output.js";
import { runCommandResult } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, savingsForText, validateInteger } from "./shared.js";

export async function logsTool(args) {
  const {
    command,
    maxBlocks = 10,
    contextLines = 5,
    maxLines = 120,
    maxBytes = MAX_BYTES,
  } = args ?? {};

  if (typeof command !== "string" || command.trim() === "") {
    invalidParams("context_logs requires a non-empty command string");
  }

  const blockLimit = validateInteger(maxBlocks, "context_logs maxBlocks", 1, 50);
  const contextLimit = validateInteger(contextLines, "context_logs contextLines", 0, 20);
  const lineLimit = validateInteger(maxLines, "context_logs maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_logs maxBytes", 1024, MAX_BYTES);

  const result = await runCommandResult(command);
  const outputText = combinedCommandOutput(result.stdout, result.stderr);
  const extraction = extractLogBlocks(outputText, blockLimit, contextLimit, lineLimit);
  const statusLine = commandStatusLine(result);
  const originalText = [statusLine, outputText || "(no output)"].join("\n");
  const previewText = [statusLine, extraction.text].join("\n");
  const formatted = formatOutput(previewText, lineLimit, byteLimit);
  const logSavings = savingsForText(originalText, formatted.text);
  const meta = {
    totalLines: originalText.split("\n").length,
    totalBytes: logSavings.totalBytes,
    ...logSavings,
    truncated: extraction.truncated || formatted.truncated || result.outputTooLarge,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    outputTooLarge: result.outputTooLarge,
    durationMs: result.durationMs,
    shell: COMMAND_SHELL_NAME,
    blocksFound: extraction.blocksFound,
    blocksShown: extraction.blocksShown,
    fallback: extraction.fallback,
  };
  await recordStats("context_logs", meta);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: meta,
  };
}

function commandStatusLine(result) {
  const status = result.timedOut
    ? "timed out"
    : result.signal
      ? `signal ${result.signal}`
      : `exit ${result.code}`;
  return `Command ${status} in ${result.durationMs}ms`;
}

function combinedCommandOutput(stdout, stderr) {
  const parts = [];
  if (stdout) parts.push(stdout.trimEnd());
  if (stderr) {
    if (parts.length > 0) parts.push("", "stderr:");
    parts.push(stderr.trimEnd());
  }

  return parts.join("\n");
}

function extractLogBlocks(text, maxBlocks, contextLines, maxLines) {
  const lines = text ? text.split("\n") : [];
  if (lines.length === 0) {
    return { text: "(no output)", blocksFound: 0, blocksShown: 0, truncated: false, fallback: true };
  }

  const matches = [];
  for (const [index, line] of lines.entries()) {
    if (isInterestingLogLine(line)) matches.push(index);
  }

  if (matches.length === 0) {
    const tail = lines.slice(-maxLines);
    return {
      text: [`No error patterns found; showing last ${tail.length} lines:`, ...tail].join("\n"),
      blocksFound: 0,
      blocksShown: 0,
      truncated: lines.length > tail.length,
      fallback: true,
    };
  }

  const ranges = mergeLogRanges(matches.map((index) => ({
    start: Math.max(0, index - contextLines),
    end: Math.min(lines.length - 1, index + contextLines),
  })));
  const shownRanges = ranges.slice(0, maxBlocks);
  const output = [];

  for (const [rangeIndex, range] of shownRanges.entries()) {
    if (rangeIndex > 0) output.push("---");
    output.push(`Block ${rangeIndex + 1} (lines ${range.start + 1}-${range.end + 1}):`);
    output.push(...lines.slice(range.start, range.end + 1));
  }

  const limitedByBlocks = ranges.length > shownRanges.length;
  if (limitedByBlocks) output.push(`... ${ranges.length - shownRanges.length} more blocks omitted ...`);

  return {
    text: output.join("\n"),
    blocksFound: ranges.length,
    blocksShown: shownRanges.length,
    truncated: limitedByBlocks,
    fallback: false,
  };
}

function isInterestingLogLine(line) {
  return /\b(error|failed|failure|exception|assertion|fatal|panic|traceback|warning|warn)\b/i.test(line)
    || /\b(ERR!|ERROR|FAIL|FAILED|FATAL|WARN)\b/.test(line)
    || /\bTS\d{4}:/.test(line)
    || /^\s*at\s+.+:\d+:\d+\)?$/.test(line)
    || /^\s*\^+$/.test(line);
}

function mergeLogRanges(ranges) {
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}
