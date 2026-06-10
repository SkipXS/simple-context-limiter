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
    return withSavings(output || "(no output)", totalLines, totalBytes, false);
  }

  if (totalLines <= limit) {
    return withSavings(formatByteSummary(output, totalBytes), totalLines, totalBytes, true);
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

  const text = Buffer.byteLength(summary, "utf8") <= MAX_BYTES ? summary : formatByteSummary(output, totalBytes);
  return withSavings(text, totalLines, totalBytes, true);
}

function withSavings(text, totalLines, totalBytes, truncated) {
  const savings = savingsForText(text, totalBytes);

  return {
    text,
    totalLines,
    totalBytes,
    returnedBytes: savings.returnedBytes,
    savedBytes: savings.savedBytes,
    savedPercent: savings.savedPercent,
    estimatedTokensSaved: savings.estimatedTokensSaved,
    truncated,
  };
}

function savingsForText(text, totalBytes) {
  const returnedBytes = Buffer.byteLength(text, "utf8");
  const savedBytes = Math.max(0, totalBytes - returnedBytes);

  return {
    text,
    returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
  };
}

export function decodeUtf8(buffer, { trimStart = false, trimEnd = false } = {}) {
  let start = 0;
  let end = buffer.length;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start, end));
    } catch {
      if (trimEnd && end > start) {
        end--;
      } else if (trimStart && start < end) {
        start++;
      } else {
        break;
      }
    }
  }

  return buffer.subarray(start, end).toString("utf8");
}

function formatByteSummary(output, totalBytes) {
  const buffer = Buffer.from(output, "utf8");
  const headBytes = Math.floor(MAX_BYTES * 0.4);
  const tailBytes = Math.floor(MAX_BYTES * 0.4);
  const tailStart = Math.max(headBytes, buffer.length - tailBytes);
  const omittedBytes = Math.max(0, totalBytes - headBytes - tailBytes);

  return [
    `╔══ ${(totalBytes / 1024).toFixed(1)} KB · showing first ${(headBytes / 1024).toFixed(1)} KB + last ${(tailBytes / 1024).toFixed(1)} KB ══╗`,
    decodeUtf8(buffer.subarray(0, headBytes), { trimEnd: true }),
    `╟── … ${(omittedBytes / 1024).toFixed(1)} KB omitted … ──╢`,
    decodeUtf8(buffer.subarray(tailStart), { trimStart: true }),
    `╚${"═".repeat(58)}╝`,
  ].join("\n");
}
