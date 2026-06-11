import { MAX_BYTES, MAX_LINES, COMMAND_SHELL_NAME } from "../constants.js";
import { formatOutput } from "../output.js";
import { runCommand } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, savingsMeta, validateInteger } from "./shared.js";

export async function runTool(args) {
  const { command, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (typeof command !== "string" || command.trim() === "") {
    invalidParams("context_run requires a non-empty command string");
  }
  const lineLimit = validateInteger(maxLines, "context_run maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_run maxBytes", 1024, MAX_BYTES);

  const { stdout, durationMs } = await runCommand(command);
  const formatted = formatOutput(stdout, lineLimit, byteLimit);
  const meta = {
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: formatted.truncated,
    durationMs,
    shell: COMMAND_SHELL_NAME,
  };
  await recordStats("context_run", meta);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: meta,
  };
}
