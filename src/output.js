import { MAX_BYTES, MAX_LINES } from "./constants.js";

export function normalizeMaxLines(maxLines = MAX_LINES) {
  const numeric = Number(maxLines);
  const value = Number.isFinite(numeric) ? Math.trunc(numeric) : MAX_LINES;
  return Math.max(10, Math.min(value, 200));
}

export function normalizeMaxBytes(maxBytes = MAX_BYTES) {
  return normalizeLimit(maxBytes, MAX_BYTES, 1024, MAX_BYTES);
}

export function normalizeLimit(value, fallback, min, max) {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.max(min, Math.min(parsed, max));
}

export function formatOutput(output, maxLines = MAX_LINES, maxBytes = MAX_BYTES) {
  const limit = normalizeMaxLines(maxLines);
  const byteLimit = normalizeMaxBytes(maxBytes);
  const totalBytes = Buffer.byteLength(output, "utf8");
  const lines = output.split("\n");
  const totalLines = lines.length;

  if (output === "") {
    const placeholder = "(no output)";
    return withSavings(placeholder, totalLines, Buffer.byteLength(placeholder, "utf8"), false);
  }

  if (totalLines <= limit && totalBytes <= byteLimit) {
    return withSavings(output, totalLines, totalBytes, false);
  }

  if (totalLines <= limit) {
    return withSavings(formatByteSummary(output, totalBytes, byteLimit), totalLines, totalBytes, true);
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

  const text = Buffer.byteLength(summary, "utf8") <= byteLimit ? summary : formatByteSummary(output, totalBytes, byteLimit);
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

function formatByteSummary(output, totalBytes, maxBytes) {
  const buffer = Buffer.from(output, "utf8");
  let headBytes = Math.floor(maxBytes * 0.4);
  let tailBytes = Math.floor(maxBytes * 0.4);

  for (let attempt = 0; attempt < 8; attempt++) {
    const text = buildByteSummary(buffer, totalBytes, headBytes, tailBytes);
    const textBytes = Buffer.byteLength(text, "utf8");
    if (textBytes <= maxBytes) return text;

    const reduction = Math.ceil((textBytes - maxBytes) / 2) + 16;
    if (tailBytes >= headBytes && tailBytes > 0) {
      tailBytes = Math.max(0, tailBytes - reduction);
    } else {
      headBytes = Math.max(0, headBytes - reduction);
    }
  }

  const fallback = buildByteSummary(buffer, totalBytes, headBytes, tailBytes);
  return decodeUtf8(Buffer.from(fallback, "utf8").subarray(0, maxBytes), { trimEnd: true });
}

function buildByteSummary(buffer, totalBytes, headBytes, tailBytes) {
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
