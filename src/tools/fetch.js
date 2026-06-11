import { createHash } from "node:crypto";
import { ALLOW_NON_HTTP_FETCH, CACHE_TTL_MS, MAX_BYTES, MAX_FETCH_BYTES, MAX_LINES, SERVER_VERSION } from "../constants.js";
import { getCache, updateCache } from "../cache.js";
import { decodeUtf8, formatOutput } from "../output.js";
import { recordStats } from "../stats.js";
import { invalidParams, savingsMeta, validateInteger } from "./shared.js";

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|pre|table)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&(apos|mdash|ndash|hellip|copy|reg);/gi, decodeNamedHtmlEntity)
    .replace(/&#(x[0-9a-f]+|\d+);/gi, decodeNumericHtmlEntity)
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ +/g, " ")
    .replace(/^[ \t]+/gm, "")
    .trim();
}

function decodeNamedHtmlEntity(match, name) {
  const entities = {
    apos: "'",
    mdash: "\u2014",
    ndash: "\u2013",
    hellip: "\u2026",
    copy: "\u00a9",
    reg: "\u00ae",
  };

  return entities[name.toLowerCase()] ?? match;
}

function decodeNumericHtmlEntity(match, value) {
  const codePoint = value.toLowerCase().startsWith("x")
    ? Number.parseInt(value.slice(1), 16)
    : Number.parseInt(value, 10);

  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;

  return String.fromCodePoint(codePoint);
}

async function fetchUrl(url, force) {
  let parsed;
  try { parsed = new URL(url); } catch {
    invalidParams("context_fetch requires a valid URL");
  }
  if (!ALLOW_NON_HTTP_FETCH && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    invalidParams("context_fetch only allows http and https URLs by default; set SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH=1 to allow other schemes");
  }

  const key = createHash("sha256").update(url).digest("hex");
  const currentCache = await getCache();
  const cached = currentCache[key];
  if (!force && cached && !cached.limited && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { content: cached.content, cached: true, limited: cached.limited ?? false };
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": `simple-context-limiter/${SERVER_VERSION}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    const error = new Error(`Fetch failed: ${url}`);
    error.code = -32000;
    error.url = url;
    error.cause = cause;
    throw error;
  }

  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} ${res.statusText}`);
    error.code = -32000;
    error.httpStatus = res.status;
    error.httpStatusText = res.statusText;
    error.url = url;
    throw error;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const { text: raw, limited } = await readLimitedText(res, MAX_FETCH_BYTES);
  const text = contentType.includes("html") ? htmlToText(raw) : raw;

  await updateCache((cache) => {
    if (limited) delete cache[key];
    else cache[key] = { ts: Date.now(), content: text, limited };
  });
  return { content: text, cached: false, limited };
}

async function readLimitedText(res, maxBytes) {
  if (!res.body) return { text: await res.text(), limited: false };

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let limited = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        limited = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return { text: decodeUtf8(Buffer.concat(chunks), { trimEnd: limited }), limited };
}

export async function fetchTool(args) {
  const { url, force = false, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (force !== undefined && typeof force !== "boolean") {
    invalidParams("context_fetch force must be a boolean when provided");
  }
  const lineLimit = validateInteger(maxLines, "context_fetch maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_fetch maxBytes", 1024, MAX_BYTES);

  const data = await fetchUrl(url, force);
  const formatted = formatOutput(data.content, lineLimit, byteLimit);
  const meta = {
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: formatted.truncated || data.limited,
    cached: data.cached,
    downloadLimited: data.limited,
  };
  await recordStats("context_fetch", meta);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: meta,
  };
}
