import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { MAX_BYTES, MAX_LINES, MAX_READ_BYTES, READ_RANGE_TIMEOUT_MS } from "../constants.js";
import { decodeUtf8, formatOutput } from "../output.js";
import { recordStats } from "../stats.js";
import { invalidParams, validateInteger } from "./shared.js";

export async function readTool(args) {
  const result = await readFilePreview(args, "context_read");
  await recordStats("context_read", result._meta);

  return result;
}

export async function readManyTool(args) {
  const { paths, maxLinesPerFile = MAX_LINES, maxBytesPerFile = MAX_BYTES, maxTotalBytes = MAX_BYTES } = args ?? {};
  if (!Array.isArray(paths) || paths.length === 0) {
    invalidParams("context_read_many requires a non-empty paths array");
  }
  if (paths.length > 20) {
    invalidParams("context_read_many paths must contain at most 20 files");
  }

  const lineLimit = validateInteger(maxLinesPerFile, "context_read_many maxLinesPerFile", 10, 200);
  const byteLimit = validateInteger(maxBytesPerFile, "context_read_many maxBytesPerFile", 1024, MAX_BYTES);
  const totalLimit = validateInteger(maxTotalBytes, "context_read_many maxTotalBytes", 1024, MAX_BYTES);
  const results = [];

  for (const filePath of paths) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      invalidParams("context_read_many paths must contain non-empty strings");
    }
    results.push(await readFilePreview({ path: filePath, maxLines: lineLimit, maxBytes: byteLimit }, "context_read_many"));
  }

  const combined = results
    .map((result) => `--- ${result._meta.path} ---\n${result.content[0].text}`)
    .join("\n\n");
  const formatted = formatOutput(combined, 200, totalLimit);
  const totalBytes = results.reduce((sum, result) => sum + result._meta.totalBytes, 0);
  const contextSavings = savingsForReturnedBytes(totalBytes, formatted.returnedBytes);
  const meta = {
    filesRequested: paths.length,
    filesRead: results.length,
    totalLines: formatted.totalLines,
    totalBytes,
    ...contextSavings,
    truncated: formatted.truncated || results.some((result) => result._meta.truncated),
    files: results.map((result) => ({
      path: result._meta.path,
      sizeBytes: result._meta.sizeBytes,
      totalBytes: result._meta.totalBytes,
      returnedBytes: result._meta.returnedBytes,
      savedBytes: result._meta.savedBytes,
      truncated: result._meta.truncated,
      fileReadLimited: result._meta.fileReadLimited,
    })),
  };
  await recordStats("context_read_many", meta);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: meta,
  };
}

async function readFilePreview(args, toolName) {
  const { path: filePath, maxLines = MAX_LINES, maxBytes = MAX_BYTES, fromLine, toLine } = args ?? {};
  if (typeof filePath !== "string" || filePath.trim() === "") {
    invalidParams(`${toolName} requires a non-empty path string`);
  }
  const lineLimit = validateInteger(maxLines, `${toolName} maxLines`, 10, 200);
  const byteLimit = validateInteger(maxBytes, `${toolName} maxBytes`, 1024, MAX_BYTES);

  const resolved = path.resolve(filePath);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) {
    const error = new Error(`Not a file: ${filePath}`);
    error.code = -32602;
    throw error;
  }

  const rangeMode = fromLine !== undefined || toLine !== undefined;
  const range = rangeMode ? normalizeLineRange(fromLine, toLine) : undefined;
  const { text, limited, rangeLimited, returnedLines, scannedLines, scannedBytes, scanTimedOut } = rangeMode
    ? await readLineRange(resolved, range.fromLine, range.toLine, lineLimit, MAX_READ_BYTES, READ_RANGE_TIMEOUT_MS)
    : await readLimitedFile(resolved, stat.size, MAX_READ_BYTES);
  const formatted = formatOutput(text, lineLimit, byteLimit);
  const contextSavings = savingsForReturnedBytes(stat.size, formatted.returnedBytes);
  const meta = {
    path: resolved,
    sizeBytes: stat.size,
    totalLines: formatted.totalLines,
    totalBytes: stat.size,
    ...contextSavings,
    truncated: formatted.truncated || rangeLimited || limited || scanTimedOut,
    fileReadLimited: limited,
    fromLine: range?.fromLine,
    toLine: range?.toLine === Infinity ? undefined : range?.toLine,
    returnedLines,
    scannedLines,
    scannedBytes,
    rangeLimited,
    scanTimedOut,
  };
  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: meta,
  };
}

function savingsForReturnedBytes(totalBytes, returnedBytes) {
  const savedBytes = Math.max(0, totalBytes - returnedBytes);

  return {
    returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
  };
}

function normalizeLineRange(fromLine, toLine) {
  const from = fromLine === undefined ? 1 : validateInteger(fromLine, "context_read fromLine", 1);
  const to = toLine === undefined ? Infinity : validateInteger(toLine, "context_read toLine", 1);

  if (to < from) {
    invalidParams("context_read toLine must be greater than or equal to fromLine");
  }

  return { fromLine: from, toLine: to };
}

async function readLineRange(filePath, fromLine, toLine, maxLines, maxBytes, timeoutMs) {
  const input = fs.createReadStream(filePath);
  const decoder = new StringDecoder("utf8");
  const lines = [];
  let lineNumber = 0;
  let bytes = 0;
  let scannedBytes = 0;
  let limited = false;
  let rangeLimited = false;
  let scanTimedOut = false;
  let currentLine = "";
  const timer = setTimeout(() => {
    scanTimedOut = true;
    input.destroy(new Error("context_read range scan timed out"));
  }, timeoutMs);
  timer.unref();

  function shouldCollectCurrentLine() {
    const currentLineNumber = lineNumber + 1;
    return currentLineNumber >= fromLine && currentLineNumber <= toLine;
  }

  function appendToCurrentLine(text) {
    if (!shouldCollectCurrentLine()) return true;
    if (lines.length >= maxLines) {
      rangeLimited = true;
      return false;
    }

    const nextLine = currentLine + text;
    if (bytes + Buffer.byteLength(nextLine, "utf8") > maxBytes) {
      limited = true;
      const remaining = maxBytes - bytes;
      if (remaining > 0) {
        const clipped = decodeUtf8(Buffer.from(nextLine, "utf8").subarray(0, remaining), { trimEnd: true });
        if (clipped) {
          lines.push(clipped);
          bytes += Buffer.byteLength(clipped, "utf8");
          lineNumber++;
        }
      }
      currentLine = "";
      return false;
    }

    currentLine = nextLine;
    return true;
  }

  function finishCurrentLine() {
    const line = currentLine.endsWith("\r") ? currentLine.slice(0, -1) : currentLine;
    currentLine = "";
    lineNumber++;

    if (lineNumber < fromLine) return true;
    if (lineNumber > toLine) return false;

    lines.push(line);
    bytes += Buffer.byteLength(line, "utf8");

    if (lines.length >= maxLines && lineNumber < toLine) {
      rangeLimited = true;
      return false;
    }

    return true;
  }

  function processText(text) {
    let offset = 0;

    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const part = newline === -1 ? text.slice(offset) : text.slice(offset, newline);
      if (!appendToCurrentLine(part)) return false;
      if (newline === -1) return true;
      if (!finishCurrentLine()) return false;
      offset = newline + 1;
    }

    return true;
  }

  try {
    for await (const chunk of input) {
      scannedBytes += chunk.byteLength;
      if (!processText(decoder.write(chunk))) {
        input.destroy();
        break;
      }
    }

    if (!limited && !rangeLimited && !scanTimedOut && lineNumber < toLine) {
      processText(decoder.end());
      if (currentLine) finishCurrentLine();
    }
  } catch (error) {
    if (!scanTimedOut) throw error;
  } finally {
    clearTimeout(timer);
    input.destroy();
  }

  return {
    text: lines.join("\n"),
    limited,
    rangeLimited,
    returnedLines: lines.length,
    scannedLines: lineNumber,
    scannedBytes,
    scanTimedOut,
  };
}

async function readLimitedFile(filePath, size, maxBytes) {
  if (size <= maxBytes) {
    return { text: await fs.promises.readFile(filePath, "utf8"), limited: false, rangeLimited: false };
  }

  const headBytes = Math.floor(maxBytes * 0.4);
  const tailBytes = maxBytes - headBytes;
  const file = await fs.promises.open(filePath, "r");

  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const headRead = await file.read(head, 0, headBytes, 0);
    const tailRead = await file.read(tail, 0, tailBytes, size - tailBytes);

    return {
      text: [
        decodeUtf8(head.subarray(0, headRead.bytesRead), { trimEnd: true }),
        `╟── … file content omitted after ${(maxBytes / 1024).toFixed(1)} KB preview … ──╢`,
        decodeUtf8(tail.subarray(0, tailRead.bytesRead), { trimStart: true }),
      ].join("\n"),
      limited: true,
      rangeLimited: false,
    };
  } finally {
    await file.close();
  }
}
