import { COMMAND_SHELL_NAME, DEFAULT_COMMAND_TIMEOUT_MS, MAX_BYTES, MAX_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS } from "../constants.js";
import { formatOutput } from "../output.js";
import { runCommandResult } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, savingsForText, validateInteger } from "./shared.js";

export async function logsTool(args) {
  return await logsResult(args, "context_logs");
}

export async function logsResult(args, toolName) {
  const {
    command,
    maxBlocks = 10,
    contextLines = 5,
    maxLines = 120,
    maxBytes = MAX_BYTES,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  } = args ?? {};

  if (typeof command !== "string" || command.trim() === "") {
    invalidParams(`${toolName} requires a non-empty command string`);
  }

  const blockLimit = validateInteger(maxBlocks, `${toolName} maxBlocks`, 1, 50);
  const contextLimit = validateInteger(contextLines, `${toolName} contextLines`, 0, 20);
  const lineLimit = validateInteger(maxLines, `${toolName} maxLines`, 10, 200);
  const byteLimit = validateInteger(maxBytes, `${toolName} maxBytes`, 1024, MAX_BYTES);
  const timeoutLimit = validateInteger(timeoutMs, `${toolName} timeoutMs`, MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);

  const result = await runCommandResult(command, { timeout: timeoutLimit });
  const outputText = combinedCommandOutput(result);
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
    timeoutMs: result.timeoutMs,
    shell: COMMAND_SHELL_NAME,
    blocksFound: extraction.blocksFound,
    blocksShown: extraction.blocksShown,
    fallback: extraction.fallback,
  };
  await recordStats(toolName, meta);

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

function combinedCommandOutput(result) {
  if (typeof result.output === "string") return result.output.trimEnd();

  const parts = [];
  const { stdout, stderr } = result;
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
    || /(?:\bERR!|\b(?:ERROR|FAIL|FAILED|FATAL|WARN)\b)/.test(line)
    || /\b[A-Z][A-Za-z0-9_]*(?:Error|Exception):/.test(line)
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
