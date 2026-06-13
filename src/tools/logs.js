import { COMMAND_SHELL_NAME, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_BYTES, MAX_BYTES, MAX_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS } from "../constants.js";
import { formatOutput } from "../output.js";
import { runCommandResult } from "../process.js";
import { recordStats } from "../stats.js";
import { formatTruncationReason, invalidParams, omission, savingsForText, toolTextResult, truncationMeta, validateCommandPolicy, validateInteger, withResponseMeta } from "./shared.js";

export async function logsTool(args) {
  return await logsResult(args, "logs");
}

export async function logsResult(args, toolName) {
  const {
    command,
    maxBlocks = 10,
    contextLines = 5,
    maxLines = 120,
    maxBytes = DEFAULT_BYTES,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  } = args ?? {};

  if (typeof command !== "string" || command.trim() === "") {
    invalidParams(`${toolName} requires a non-empty command string`);
  }

  const blockLimit = validateInteger(maxBlocks, `${toolName} maxBlocks`, 1, 50);
  const contextLimit = validateInteger(contextLines, `${toolName} contextLines`, 0, 20);
  const lineLimit = validateInteger(maxLines, `${toolName} maxLines`, 10, 500);
  const byteLimit = validateInteger(maxBytes, `${toolName} maxBytes`, 1024, MAX_BYTES);
  const timeoutLimit = validateInteger(timeoutMs, `${toolName} timeoutMs`, MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  validateCommandPolicy(command, toolName);

  const result = await runCommandResult(command, { timeout: timeoutLimit });
  const outputText = combinedCommandOutput(result);
  const extraction = extractLogBlocks(outputText, blockLimit, contextLimit, lineLimit);
  const statusLine = commandStatusLine(result);
  const originalText = [statusLine, outputText || "(no output)"].join("\n");
  const previewText = [statusLine, extraction.text].join("\n");
  const formatted = formatOutput(previewText, lineLimit, byteLimit);
  const logSavings = savingsForText(originalText, formatted.text);
  const accounting = accountForDiagnosticOverhead(logSavings);
  const truncated = extraction.truncated || formatted.truncated || result.outputTooLarge;
  const meta = withResponseMeta({
    totalLines: originalText.split("\n").length,
    ...accounting,
    truncated,
    ...truncationMeta(truncated, logsTruncationReason(extraction, formatted, result, lineLimit, byteLimit), "Increase maxBlocks/contextLines/maxLines/maxBytes or rerun command directly."),
    empty: outputText === "",
    emptyReason: outputText === "" ? "no_output" : undefined,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    outputTooLarge: result.outputTooLarge,
    durationMs: result.durationMs,
    timeoutMs: result.timeoutMs,
    shell: COMMAND_SHELL_NAME,
    blocksFound: extraction.blocksFound,
    blocksShown: extraction.blocksShown,
    blockOrder: extraction.fallback ? undefined : "severity_then_line",
    fallback: extraction.fallback,
  });
  await recordStats(toolName, meta);

  return toolTextResult(formatted.text, meta, byteLimit);
}

function accountForDiagnosticOverhead(savings) {
  const totalBytes = Math.max(savings.totalBytes, savings.returnedBytes);
  const savedBytes = Math.max(0, totalBytes - savings.returnedBytes);
  return {
    sourceBytes: savings.totalBytes,
    outputOverheadBytes: Math.max(0, savings.returnedBytes - savings.totalBytes),
    totalBytes,
    returnedBytes: savings.returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
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
      truncationReason: lines.length > tail.length ? "tail_limit" : undefined,
      fallback: true,
    };
  }

  const ranges = mergeLogRanges(matches.map((index) => ({
    start: Math.max(0, index - contextLines),
    end: Math.min(lines.length - 1, index + contextLines),
    severity: logLineSeverity(lines[index]),
  })));
  const prioritizedRanges = prioritizeLogRanges(ranges);
  const shownRanges = prioritizedRanges.slice(0, maxBlocks);
  const output = shownRanges.length > 1 ? ["Blocks sorted by severity, then line."] : [];

  for (const [rangeIndex, range] of shownRanges.entries()) {
    if (rangeIndex > 0) output.push("---");
    const rangeLabel = formatRangeLabel(range);
    output.push(shownRanges.length === 1 ? `${capitalize(rangeLabel)}:` : `Block ${rangeIndex + 1} (${rangeLabel}):`);
    output.push(...lines.slice(range.start, range.end + 1));
  }

  const limitedByBlocks = ranges.length > shownRanges.length;
  if (limitedByBlocks) output.push(omission("blocks", ranges.length - shownRanges.length));

  return {
    text: output.join("\n"),
    blocksFound: ranges.length,
    blocksShown: shownRanges.length,
    truncated: limitedByBlocks,
    truncationReason: limitedByBlocks ? "block_limit" : undefined,
    fallback: false,
  };
}

function formatRangeLabel(range) {
  const start = range.start + 1;
  const end = range.end + 1;
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function logsTruncationReason(extraction, formatted, result, maxLines, maxBytes) {
  const reasons = [];
  if (result.outputTooLarge) reasons.push("command_output_cap");
  if (extraction.truncationReason) reasons.push(extraction.truncationReason);
  if (formatted.truncated) reasons.push(formatTruncationReason(formatted, maxLines, maxBytes));
  return reasons.filter(Boolean).join("+") || "format_limit";
}

function isInterestingLogLine(line) {
  return logLineSeverity(line) > 0;
}

function logLineSeverity(line) {
  if (isFailureLogLine(line)) return 4;
  if (isSupportLogLine(line)) return 3;
  if (isWarningLogLine(line)) return 2;
  return 0;
}

function isFailureLogLine(line) {
  return /\b(error|failed|failure|exception|assertion|fatal|panic|traceback)\b/i.test(line)
    || /(?:\bERR!|\b(?:ERROR|FAIL|FAILED|FATAL)\b)/.test(line)
    || /\b[A-Z][A-Za-z0-9_]*(?:Error|Exception):/.test(line)
    || /\bTS\d{4}:/.test(line);
}

function isWarningLogLine(line) {
  return /\b(warning|warn)\b/i.test(line)
    || /\bWARN\b/.test(line);
}

function isSupportLogLine(line) {
  return /^\s*at\s+.+:\d+:\d+\)?$/.test(line)
    || /^\s*\^+$/.test(line);
}

function prioritizeLogRanges(ranges) {
  return [...ranges].sort((left, right) => {
    if (right.severity !== left.severity) return right.severity - left.severity;
    return left.start - right.start;
  });
}

function mergeLogRanges(ranges) {
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1 && shouldMergeLogRanges(previous, range)) {
      previous.end = Math.max(previous.end, range.end);
      previous.severity = Math.max(previous.severity ?? 0, range.severity ?? 0);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function shouldMergeLogRanges(previous, range) {
  if (range.start <= previous.end) return true;
  if (previous.severity === range.severity) return true;
  return previous.severity >= 3 && range.severity >= 3;
}
