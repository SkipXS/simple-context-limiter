import { DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_BYTES, MAX_BYTES, MAX_COMMAND_BYTES, MAX_COMMAND_TIMEOUT_MS, MAX_LINES, MIN_COMMAND_TIMEOUT_MS, COMMAND_SHELL_NAME } from "../constants.js";
import { formatOutput } from "../output.js";
import { runCommand } from "../process.js";
import { recordStats } from "../stats.js";
import { formatTruncationReason, invalidParams, toolTextResult, truncationMeta, validateCommandPolicy, validateInteger, withResponseMeta } from "./shared.js";

export async function runTool(args) {
  const { command, maxLines = MAX_LINES, maxBytes = DEFAULT_BYTES, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = args ?? {};
  if (typeof command !== "string" || command.trim() === "") {
    invalidParams("run requires a non-empty command string");
  }
  const lineLimit = validateInteger(maxLines, "run maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "run maxBytes", 1024, MAX_BYTES);
  const timeoutLimit = validateInteger(timeoutMs, "run timeoutMs", MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  validateCommandPolicy(command, "run");

  const { stdout, stderrBytes = 0, durationMs, outputTooLarge, code, signal } = await runCommand(command, { timeout: timeoutLimit, allowOutputTooLarge: true });
  const formatted = formatOutput(stdout, lineLimit, byteLimit);
  const totalBytes = outputTooLarge ? Math.max(formatted.totalBytes, MAX_COMMAND_BYTES + 1) : formatted.totalBytes;
  const returnedBytes = formatted.returnedBytes;
  const savedBytes = Math.max(0, totalBytes - returnedBytes);
  const truncated = formatted.truncated || outputTooLarge;
  const truncationReason = outputTooLarge ? "command_output_cap" : formatTruncationReason(formatted, lineLimit, byteLimit);
  const meta = withResponseMeta({
    totalLines: formatted.totalLines,
    totalBytes,
    totalBytesKnown: !outputTooLarge,
    returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
    truncated,
    ...truncationMeta(truncated, truncationReason, runTruncationHint(outputTooLarge)),
    empty: stdout === "",
    emptyReason: stdout === "" ? "no_output" : undefined,
    outputTooLarge,
    exitCode: outputTooLarge ? code : undefined,
    signal: outputTooLarge ? signal : undefined,
    stderrOmitted: stderrBytes > 0 ? true : undefined,
    stderrBytes: stderrBytes > 0 ? stderrBytes : undefined,
    durationMs,
    timeoutMs: timeoutLimit,
    shell: COMMAND_SHELL_NAME,
  });
  await recordStats("run", meta);

  return toolTextResult(formatted.text, meta, byteLimit);
}

function runTruncationHint(outputTooLarge) {
  return outputTooLarge
    ? "Use a narrower command or raise SIMPLE_CONTEXT_LIMITER_MAX_COMMAND_BYTES."
    : "Increase maxLines/maxBytes.";
}
