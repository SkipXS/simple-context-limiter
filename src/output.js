import { MAX_BYTES, MAX_LINES } from "./constants.js";

export function normalizeMaxLines(maxLines = MAX_LINES) {
  const numeric = Number(maxLines);
  const value = Number.isFinite(numeric) ? Math.trunc(numeric) : MAX_LINES;
  return Math.max(10, Math.min(value, 200));
}

export function normalizeLimit(value, fallback, min, max) {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.max(min, Math.min(parsed, max));
}

export function formatOutput(output, maxLines = MAX_LINES) {
  const limit = normalizeMaxLines(maxLines);
  const totalBytes = Buffer.byteLength(output, "utf8");
  const lines = output.split("\n");
  const totalLines = lines.length;

  if (totalLines <= limit && totalBytes <= MAX_BYTES) {
    return { text: output || "(no output)", totalLines, totalBytes, truncated: false };
  }

  if (totalLines <= limit) {
    return { text: formatByteSummary(output, totalBytes), totalLines, totalBytes, truncated: true };
  }

  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  const omittedLines = Math.max(0, totalLines - head - tail);
  const summary = [
    `╔══ ${totalLines} lines · ${(totalBytes / 1024).toFixed(1)} KB · showing first ${head} + last ${tail} ══╗`,
    ...lines.slice(0, head),
    `╟── … ${omittedLines} lines omitted … ──╢`,
    ...lines.slice(-tail),
    `╚${"═".repeat(58)}╝`,
  ].join("\n");

  return {
    text: Buffer.byteLength(summary, "utf8") <= MAX_BYTES ? summary : formatByteSummary(output, totalBytes),
    totalLines,
    totalBytes,
    truncated: true,
  };
}

function formatByteSummary(output, totalBytes) {
  const buffer = Buffer.from(output, "utf8");
  const headBytes = Math.floor(MAX_BYTES * 0.4);
  const tailBytes = Math.floor(MAX_BYTES * 0.4);
  const tailStart = Math.max(headBytes, buffer.length - tailBytes);
  const omittedBytes = Math.max(0, totalBytes - headBytes - tailBytes);

  return [
    `╔══ ${(totalBytes / 1024).toFixed(1)} KB · showing first ${(headBytes / 1024).toFixed(1)} KB + last ${(tailBytes / 1024).toFixed(1)} KB ══╗`,
    buffer.subarray(0, headBytes).toString("utf8"),
    `╟── … ${(omittedBytes / 1024).toFixed(1)} KB omitted … ──╢`,
    buffer.subarray(tailStart).toString("utf8"),
    `╚${"═".repeat(58)}╝`,
  ].join("\n");
}
