import * as path from "node:path";

export function invalidParams(message) {
  const error = new Error(message);
  error.code = -32602;
  throw error;
}

function integerRange(min, max) {
  return max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
}

export function validateInteger(value, name, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalidParams(`${name} must be an integer ${integerRange(min, max)}`);
  }
  if (value < min || (max !== undefined && value > max)) {
    invalidParams(`${name} must be ${integerRange(min, max)}`);
  }
  return value;
}

export function savingsMeta(formatted) {
  return {
    returnedBytes: formatted.returnedBytes,
    savedBytes: formatted.savedBytes,
    savedPercent: formatted.savedPercent,
    estimatedTokensSaved: formatted.estimatedTokensSaved,
  };
}

const RESPONSE_META_KEYS = new Set([
  "totalLines",
  "totalBytes",
  "totalBytesKnown",
  "returnedBytes",
  "savedBytes",
  "savedPercent",
  "estimatedTokensSaved",
]);

export function responseMeta(meta) {
  return {
    totalLines: meta.totalLines,
    totalBytes: meta.totalBytes,
    totalBytesKnown: meta.totalBytesKnown,
    returnedBytes: meta.returnedBytes,
    savedBytes: meta.savedBytes,
    savedPercent: meta.savedPercent,
    estimatedTokensSaved: meta.estimatedTokensSaved,
    truncated: Boolean(meta.truncated),
  };
}

export function withResponseMeta(meta) {
  const compact = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!RESPONSE_META_KEYS.has(key)) compact[key] = value;
  }
  return { ...compact, response: responseMeta(meta) };
}

export function relativePath(filePath, root = process.cwd()) {
  if (typeof filePath !== "string" || filePath.trim() === "") return undefined;
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return resolvedPath;
  return relative.replaceAll(path.sep, "/");
}

export function omission(kind, count) {
  const amount = Number.isFinite(count) ? String(count) : "more";
  return `[omitted: ${amount} ${kind}]`;
}

export function savingsForText(originalText, returnedText) {
  const totalBytes = Buffer.byteLength(originalText, "utf8");
  const returnedBytes = Buffer.byteLength(returnedText, "utf8");
  const savedBytes = Math.max(0, totalBytes - returnedBytes);

  return {
    totalBytes,
    returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
  };
}
