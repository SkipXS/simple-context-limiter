import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ALLOW_NON_HTTP_FETCH, CACHE_TTL_MS, DEFAULT_BYTES, FETCH_PUBLIC_ONLY, MAX_BYTES, MAX_FETCH_BYTES, MAX_LINES, SERVER_VERSION } from "../constants.js";
import { getCache, updateCache } from "../cache.js";
import { formatOutput } from "../output.js";
import { recordStats } from "../stats.js";
import { formatTruncationReason, invalidParams, savingsMeta, toolTextResult, truncationMeta, validateInteger, withResponseMeta } from "./shared.js";

function htmlToText(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(title|p|div|h[1-6]|li|tr|section|article|pre|table)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&(apos|mdash|ndash|hellip|copy|reg);/gi, decodeNamedHtmlEntity)
    .replace(/&#(x[0-9a-f]+|\d+);/gi, decodeNumericHtmlEntity)
    .replace(/&nbsp;/g, " ")
    .replace(/ +/g, " ");

  return normalizeHtmlText(text);
}

function normalizeHtmlText(text) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const deduped = [];
  for (const line of lines) {
    if (line !== deduped.at(-1)) deduped.push(line);
  }
  return deduped.join("\n");
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

async function fetchUrl(url, { force = false, cache: cacheArg } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch {
    invalidParams("fetch requires a valid URL");
  }
  if (!ALLOW_NON_HTTP_FETCH && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    invalidParams("fetch only allows http and https URLs by default; set SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH=1 to allow other schemes");
  }

  if (FETCH_PUBLIC_ONLY) await validatePublicFetchUrl(url);

  const key = createHash("sha256").update(url).digest("hex");
  const started = Date.now();
  const initialCachePolicy = await fetchCachePolicy(url, undefined, cacheArg);
  if (initialCachePolicy.read && !force) {
    const currentCache = await getCache();
    const cached = currentCache[key];
    const cachedCachePolicy = cached ? await fetchCachePolicy(url, cached.finalUrl ?? url, cacheArg) : initialCachePolicy;
    if (cachedCachePolicy.read && cached && !cached.limited && Date.now() - cached.ts < CACHE_TTL_MS) {
      if (FETCH_PUBLIC_ONLY) await validatePublicFetchUrl(cached.finalUrl ?? url);
      return {
        content: cached.content,
        cached: true,
        limited: cached.limited ?? false,
        url,
        finalUrl: cached.finalUrl ?? url,
        status: cached.status,
        statusText: cached.statusText,
        contentType: cached.contentType,
        charset: cached.charset,
        htmlStripped: cached.htmlStripped,
        transformed: cached.transformed,
        cacheEligible: cachedCachePolicy.write,
        cacheSkippedReason: cachedCachePolicy.reason,
        durationMs: Date.now() - started,
      };
    }
  }

  const res = await fetchWithPolicy(url);

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const error = new Error(`HTTP ${res.status} ${res.statusText}`);
    error.code = -32000;
    error.httpStatus = res.status;
    error.httpStatusText = res.statusText;
    error.url = url;
    throw error;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const contentInfo = classifyContentType(contentType);
  if (!contentInfo.textual) {
    await res.body?.cancel().catch(() => {});
    const error = new Error(`Fetch returned non-text content (${contentType || "unknown content-type"}); sc-fetch only returns readable text`);
    error.code = -32000;
    error.url = url;
    error.finalUrl = res.url || url;
    error.contentType = contentType;
    error.binary = true;
    throw error;
  }

  const htmlStripped = contentInfo.html;
  const { text: raw, limited } = await readLimitedText(res, MAX_FETCH_BYTES, contentInfo.charset);
  const text = htmlStripped ? htmlToText(raw) : raw;
  const finalUrl = res.url || url;
  const finalCachePolicy = await fetchCachePolicy(url, finalUrl, cacheArg);
  const metadata = {
    url,
    finalUrl,
    status: res.status,
    statusText: res.statusText,
    contentType,
    charset: contentInfo.charset,
    htmlStripped,
    transformed: htmlStripped,
  };

  if (finalCachePolicy.write || limited) {
    await updateCache((cache) => {
      if (limited || !finalCachePolicy.write) delete cache[key];
      else cache[key] = { ts: Date.now(), content: text, limited, ...metadata };
    });
  }
  return {
    content: text,
    cached: false,
    limited,
    ...metadata,
    cacheEligible: finalCachePolicy.write,
    cacheSkippedReason: finalCachePolicy.reason,
    durationMs: Date.now() - started,
  };
}

async function fetchCachePolicy(url, finalUrl, cacheArg) {
  if (cacheArg === false) return { read: false, write: false, reason: "per_call_disabled" };
  if (cacheArg === true) return { read: true, write: true, reason: undefined };

  const envMode = fetchCacheEnvMode();
  if (envMode === "off") return { read: false, write: false, reason: "env_disabled" };

  const skipReason = await fetchCacheSkipReason(url) ?? (finalUrl ? await fetchCacheSkipReason(finalUrl) : undefined);
  if (skipReason && envMode !== "all") return { read: false, write: false, reason: skipReason };

  return { read: true, write: true, reason: undefined };
}

async function fetchWithPolicy(url) {
  if (!FETCH_PUBLIC_ONLY) return await fetchOnce(url);

  let currentUrl = url;
  for (let redirects = 0; redirects <= 10; redirects++) {
    await validatePublicFetchUrl(currentUrl);
    const res = await fetchOnce(currentUrl, { redirect: "manual" });
    if (!isRedirectStatus(res.status)) return res;

    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!location) return res;
    currentUrl = new URL(location, currentUrl).href;
  }

  const error = new Error(`Fetch failed: ${url} (too many redirects)`);
  error.code = -32000;
  error.url = url;
  throw error;
}

async function fetchOnce(url, options = {}) {
  try {
    return await fetch(url, {
      headers: { "User-Agent": `simple-context-limiter/${SERVER_VERSION}` },
      signal: AbortSignal.timeout(30_000),
      ...options,
    });
  } catch (cause) {
    const error = new Error(`Fetch failed: ${url}`);
    error.code = -32000;
    error.url = url;
    error.cause = cause;
    throw error;
  }
}

async function validatePublicFetchUrl(url) {
  const reason = await fetchCacheSkipReason(url);
  if (!reason) return;
  const error = new Error(`Fetch blocked by SIMPLE_CONTEXT_LIMITER_FETCH_PUBLIC_ONLY: ${reason}`);
  error.code = -32602;
  error.url = url;
  throw error;
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function fetchCacheEnvMode() {
  const value = process.env.SIMPLE_CONTEXT_LIMITER_FETCH_CACHE;
  if (/^(0|false|no|off)$/i.test(value ?? "")) return "off";
  if (/^(all|private)$/i.test(value ?? "")) return "all";
  return "public";
}

export async function fetchCacheSkipReason(value, lookupHost = lookup) {
  let parsed;
  try { parsed = new URL(value); } catch { return undefined; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  const host = normalizeHostname(parsed.hostname);
  if (!host) return undefined;
  if (isPrivateLiteralHost(host)) return "private_address";
  if (isIP(host)) return undefined;

  let addresses;
  try {
    addresses = await lookupHost(host, { all: true, verbatim: true });
  } catch {
    return "unresolved_host";
  }

  return addresses.some((entry) => isPrivateLiteralHost(entry.address)) ? "private_address" : undefined;
}

function isPrivateLiteralHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);

  if (isIP(host) === 6) return isPrivateIpv6(host);
  return false;
}

function normalizeHostname(hostname) {
  let host = String(hostname ?? "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function parseIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => /^\d+$/.test(part) ? Number(part) : Number.NaN);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  return octets;
}

function isPrivateIpv4([a, b, c, d]) {
  return a === 0 // current network
    || a === 10 // RFC1918 private
    || a === 127 // loopback
    || (a === 100 && b >= 64 && b <= 127) // RFC6598 shared/CGNAT
    || (a === 169 && b === 254) // link-local
    || (a === 172 && b >= 16 && b <= 31) // RFC1918 private
    || (a === 192 && b === 0 && c === 0) // IETF protocol assignments
    || (a === 192 && b === 0 && c === 2) // TEST-NET-1
    || (a === 192 && b === 168) // RFC1918 private
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) // TEST-NET-2
    || (a === 203 && b === 0 && c === 113) // TEST-NET-3
    || a >= 224 // multicast/reserved/broadcast, including 255.255.255.255
    || (a === 255 && b === 255 && c === 255 && d === 255);
}

function isPrivateIpv6(host) {
  const bytes = ipv6ToBytes(host);
  if (!bytes) return false;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  const mappedPrefix = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mappedPrefix && isPrivateIpv4(bytes.slice(12, 16));
}

function ipv6ToBytes(host) {
  const zoneIndex = host.indexOf("%");
  const withoutZone = zoneIndex === -1 ? host : host.slice(0, zoneIndex);
  const [leftRaw, rightRaw = ""] = withoutZone.split("::");
  if (withoutZone.split("::").length > 2) return undefined;

  const left = parseIpv6Groups(leftRaw);
  const right = parseIpv6Groups(rightRaw);
  if (!left || !right) return undefined;

  const missing = 8 - left.length - right.length;
  if (withoutZone.includes("::") ? missing < 0 : missing !== 0) return undefined;
  const groups = [...left, ...Array(Math.max(0, missing)).fill(0), ...right];
  if (groups.length !== 8) return undefined;

  const bytes = [];
  for (const group of groups) bytes.push(group >> 8, group & 0xff);
  return bytes;
}

function parseIpv6Groups(value) {
  if (value === "") return [];
  const groups = [];
  for (const part of value.split(":")) {
    if (part.includes(".")) {
      const ipv4 = parseIpv4(part);
      if (!ipv4) return undefined;
      groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
    } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
      groups.push(Number.parseInt(part, 16));
    } else {
      return undefined;
    }
  }
  return groups;
}

function classifyContentType(contentType) {
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  const charset = parseCharset(contentType) ?? "utf-8";
  const textual = mediaType === ""
    || mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType.endsWith("+json")
    || mediaType === "application/xml"
    || mediaType.endsWith("+xml")
    || mediaType === "application/javascript"
    || mediaType === "application/x-javascript"
    || mediaType === "application/x-www-form-urlencoded"
    || mediaType === "image/svg+xml";

  return { textual, html: /\bhtml\b/i.test(mediaType), charset };
}

function parseCharset(contentType) {
  const match = /(?:^|;)\s*charset\s*=\s*("[^"]+"|'[^']+'|[^;\s]+)/i.exec(contentType);
  return match ? match[1].replace(/^['"]|['"]$/g, "").toLowerCase() : undefined;
}

async function readLimitedText(res, maxBytes, charset = "utf-8") {
  if (!res.body) return { text: decodeBytes(Buffer.from(await res.arrayBuffer()), charset), limited: false };

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
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
          total += remaining;
        }
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

  const buffer = Buffer.concat(chunks);
  return { text: decodeBytes(limited ? trimPartialUtf8(buffer, charset) : buffer, charset), limited };
}

function decodeBytes(buffer, charset) {
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch (cause) {
    const error = new Error(`Unsupported response charset: ${charset}`);
    error.code = -32000;
    error.cause = cause;
    throw error;
  }
}

function trimPartialUtf8(buffer, charset) {
  if (!/^utf-?8$/i.test(charset ?? "")) return buffer;
  return buffer.subarray(0, trimUtf8End(buffer));
}

function trimUtf8End(buffer) {
  if (buffer.length === 0) return 0;

  let leadIndex = buffer.length - 1;
  while (leadIndex > 0 && (buffer[leadIndex] & 0xc0) === 0x80) leadIndex--;

  const lead = buffer[leadIndex];
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buffer.length - leadIndex < expected ? leadIndex : buffer.length;
}

export async function fetchTool(args) {
  const { url, force = false, cache, maxLines = MAX_LINES, maxBytes = DEFAULT_BYTES } = args ?? {};
  if (force !== undefined && typeof force !== "boolean") {
    invalidParams("fetch force must be a boolean when provided");
  }
  if (cache !== undefined && typeof cache !== "boolean") {
    invalidParams("fetch cache must be a boolean when provided");
  }
  const lineLimit = validateInteger(maxLines, "fetch maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "fetch maxBytes", 1024, MAX_BYTES);

  const data = await fetchUrl(url, { force, cache });
  const responseByteLimit = Math.min(byteLimit, MAX_FETCH_BYTES);
  const formatted = formatOutput(formatFetchDisplayText(data), lineLimit, responseByteLimit);
  const truncated = formatted.truncated || data.limited;
  const meta = withResponseMeta({
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated,
    ...truncationMeta(truncated, data.limited ? "download_limit" : formatTruncationReason(formatted, lineLimit, byteLimit), data.limited ? "Fetch smaller content or raise the fetch byte cap." : "Increase maxLines/maxBytes."),
    empty: data.content === "",
    emptyReason: data.content === "" ? "empty_response" : undefined,
    url: data.url,
    finalUrl: data.finalUrl,
    status: data.status,
    statusText: data.statusText,
    contentType: data.contentType,
    charset: data.charset,
    htmlStripped: data.htmlStripped,
    transformed: data.transformed,
    cached: data.cached,
    cacheEligible: data.cacheEligible,
    cacheSkippedReason: data.cacheSkippedReason,
    downloadLimited: data.limited,
    durationMs: data.durationMs,
  });
  await recordStats("fetch", meta);

  return toolTextResult(formatted.text, meta, responseByteLimit);
}

function formatFetchDisplayText(data) {
  const source = data.finalUrl && data.finalUrl !== data.url
    ? `${compactTrace(data.url)} -> ${compactTrace(data.finalUrl)}`
    : compactTrace(data.url);
  const status = [data.status, data.statusText].filter((part) => part !== undefined && part !== "").join(" ") || "unknown status";
  const notes = [];
  if (data.htmlStripped) notes.push("HTML stripped");
  if (data.cached) notes.push("cached");
  if (data.cacheSkippedReason) notes.push(`cache skipped: ${data.cacheSkippedReason.replaceAll("_", " ")}`);
  const suffix = notes.length > 0 ? `${status}, ${notes.join(", ")}` : status;
  return [`Source: ${source} (${suffix})`, data.content].join("\n").trimEnd();
}

function compactTrace(value, maxLength = 160) {
  if (typeof value !== "string" || value.length <= maxLength) return value;
  const tailLength = Math.min(32, Math.floor(maxLength * 0.25));
  const headLength = maxLength - tailLength - 3;
  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}
