import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_BYTES, MAX_COMMAND_BYTES, MAX_COMMAND_TIMEOUT_MS, MAX_LINES, MIN_COMMAND_TIMEOUT_MS, COMMAND_SHELL_NAME } from "../constants.js";
import { formatOutput } from "../output.js";
import { runCommand } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, validateInteger, withResponseMeta } from "./shared.js";

export async function runTool(args) {
  const { command, maxLines = MAX_LINES, maxBytes = MAX_BYTES, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = args ?? {};
  if (typeof command !== "string" || command.trim() === "") {
    invalidParams("run requires a non-empty command string");
  }
  const lineLimit = validateInteger(maxLines, "run maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "run maxBytes", 1024, MAX_BYTES);
  const timeoutLimit = validateInteger(timeoutMs, "run timeoutMs", MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);

  const { stdout, durationMs, outputTooLarge, code, signal } = await runCommand(command, { timeout: timeoutLimit, allowOutputTooLarge: true });
  const formatted = formatOutput(stdout, lineLimit, byteLimit);
  const totalBytes = outputTooLarge ? Math.max(formatted.totalBytes, MAX_COMMAND_BYTES + 1) : formatted.totalBytes;
  const returnedBytes = formatted.returnedBytes;
  const savedBytes = Math.max(0, totalBytes - returnedBytes);
  const meta = withResponseMeta({
    totalLines: formatted.totalLines,
    totalBytes,
    totalBytesKnown: !outputTooLarge,
    returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
    truncated: formatted.truncated || outputTooLarge,
    empty: stdout === "",
    emptyReason: stdout === "" ? "no_output" : undefined,
    outputTooLarge,
    exitCode: outputTooLarge ? code : undefined,
    signal: outputTooLarge ? signal : undefined,
    durationMs,
    timeoutMs: timeoutLimit,
    shell: COMMAND_SHELL_NAME,
  });
  await recordStats("run", meta);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: meta,
  };
}
