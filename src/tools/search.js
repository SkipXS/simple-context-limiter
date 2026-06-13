import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_BYTES, MAX_LINES, MAX_READ_BYTES, RG_NAME } from "../constants.js";
import { formatOutput } from "../output.js";
import { commandError, runProcessLines } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, omission, relativePath, savingsForText, savingsMeta, validateInteger, withResponseMeta } from "./shared.js";

const MATCH_SEPARATOR = "\x1f";
const CONTEXT_SEPARATOR = "\x1e";
const AST_LANGUAGE_BY_EXTENSION = new Map([
  [".c", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cs", "csharp"],
  [".css", "css"],
  [".go", "go"],
  [".html", "html"],
  [".java", "java"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".json", "json"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".php", "php"],
  [".py", "python"],
  [".rb", "ruby"],
  [".rs", "rust"],
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
]);

let astGrepCacheKey;
let astGrepCachePromise;

function pathEntries() {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  return raw.split(path.delimiter).filter(Boolean);
}

async function isExecutable(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    await fs.promises.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findRg() {
  const candidates = [];

  if (process.env.SIMPLE_CONTEXT_LIMITER_RG_PATH) candidates.push(process.env.SIMPLE_CONTEXT_LIMITER_RG_PATH);

  for (const entry of pathEntries()) candidates.push(path.join(entry, RG_NAME));

  candidates.push(
    path.join(os.homedir(), ".cache", "opencode", "bin", RG_NAME),
    path.join(os.homedir(), ".pi", "agent", "bin", RG_NAME),
  );

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }

  return null;
}

async function canRunAstGrep(candidate) {
  const result = await runProcessLines(candidate, ["--version"], { timeout: 5_000, maxLines: 2, maxBytes: 4096, windowsCommandShim: isWindowsCommandShim(candidate) });
  return result.code === 0;
}

export async function findAstGrep() {
  const cacheKey = astGrepDiscoveryKey();
  if (astGrepCacheKey === cacheKey && astGrepCachePromise) return await astGrepCachePromise;

  astGrepCacheKey = cacheKey;
  astGrepCachePromise = findAstGrepUncached();
  return await astGrepCachePromise;
}

async function findAstGrepUncached() {
  const names = process.platform === "win32" ? ["sg.exe", "ast-grep.exe", "sg.cmd", "ast-grep.cmd"] : ["sg", "ast-grep"];
  const candidates = [];

  if (process.env.SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH) candidates.push(process.env.SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH);
  for (const entry of pathEntries()) {
    for (const name of names) candidates.push(path.join(entry, name));
  }

  for (const candidate of candidates) {
    if (!await isExecutable(candidate)) continue;
    try {
      if (await canRunAstGrep(candidate)) return candidate;
    } catch {}
  }

  return null;
}

function astGrepDiscoveryKey() {
  return [
    process.platform,
    process.env.SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH ?? "",
    process.env.PATH ?? "",
    process.env.Path ?? "",
  ].join("\0");
}

function isWindowsCommandShim(filePath) {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(filePath);
}

export async function searchTool(args) {
  const {
    engine = "text",
    pattern,
    path: searchPath = ".",
    include,
    language,
    contextLines = 0,
    maxMatches = 100,
    maxLines = MAX_LINES,
    maxBytes = MAX_BYTES,
  } = args ?? {};

  if (engine !== "text" && engine !== "ast") {
    invalidParams("search engine must be \"text\" or \"ast\"");
  }
  if (typeof pattern !== "string" || pattern.trim() === "") {
    invalidParams("search requires a non-empty pattern string");
  }
  if (typeof searchPath !== "string" || searchPath.trim() === "") {
    invalidParams("search requires path to be a non-empty string when provided");
  }
  if (include !== undefined && typeof include !== "string") {
    invalidParams("search include must be a string when provided");
  }
  if (language !== undefined && typeof language !== "string") {
    invalidParams("search language must be a string when provided");
  }
  const contextLimit = validateInteger(contextLines, "search contextLines", 0, 10);
  const limit = validateInteger(maxMatches, "search maxMatches", 1, 1000);
  const lineLimit = validateInteger(maxLines, "search maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "search maxBytes", 1024, MAX_BYTES);

  const commandSearchPath = relativePath(searchPath);

  if (engine === "ast") {
    const astLanguage = normalizeAstLanguage(language, searchPath, include);
    if (!astLanguage) {
      invalidParams("search language is required when engine is ast unless it can be inferred from path or include");
    }
    return await astSearchTool(pattern, commandSearchPath, include, astLanguage, contextLimit, limit, lineLimit, byteLimit);
  }

  const rg = await findRg();
  if (!rg) {
    const error = new Error(
      "ripgrep was not found. Install rg, set SIMPLE_CONTEXT_LIMITER_RG_PATH, or run from OpenCode/Pi after their rg helper has been installed.",
    );
    error.code = -32000;
    throw error;
  }

  if (contextLimit > 0) {
    return await searchWithContext(rg, pattern, commandSearchPath, include, contextLimit, limit, lineLimit, byteLimit);
  }

  const rgArgs = ["--line-number", "--with-filename", "--color", "never", "--no-heading"];
  if (include) rgArgs.push("--glob", include);
  rgArgs.push("--", pattern, commandSearchPath);

  const result = await runProcessLines(rg, rgArgs, {
    cwd: process.cwd(),
    timeout: 120_000,
    maxLines: limit + 1,
    maxBytes: MAX_READ_BYTES,
  });
  if (result.code === 1) {
    const text = "(no matches)";
    const totalBytes = Buffer.byteLength(text, "utf8");
    const meta = withResponseMeta({
      rgPath: rg,
      totalMatches: 0,
      totalMatchesKnown: true,
      shownMatches: 0,
      totalLines: 1,
      totalBytes,
      returnedBytes: totalBytes,
      savedBytes: 0,
      savedPercent: 0,
      estimatedTokensSaved: 0,
      truncated: false,
      empty: true,
      emptyReason: "no_matches",
      durationMs: result.durationMs,
    });
    await recordStats("search", meta);

    return {
      content: [{ type: "text", text }],
      _meta: meta,
    };
  }
  if (result.code !== 0 && !result.truncated && !result.outputTooLarge) {
    commandError(`rg ${rgArgs.join(" ")}`, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge);
  }

  const matches = result.lines;
  const shown = matches.slice(0, limit);
  const matchLimited = result.truncated || result.outputTooLarge || matches.length > limit;
  const originalText = matches.join("\n");
  const text = matchLimited
    ? [...shown, omission("matches")].join("\n")
    : originalText || "(no matches)";
  const formatted = formatOutput(text, lineLimit, byteLimit);
  const searchSavings = matchLimited ? savingsForText(originalText, formatted.text) : savingsMeta(formatted);
  const meta = withResponseMeta({
    rgPath: rg,
    totalMatches: matchLimited ? undefined : matches.length,
    totalMatchesKnown: !matchLimited,
    matchesRead: matchLimited ? matches.length : undefined,
    shownMatches: shown.length,
    totalLines: formatted.totalLines,
    totalBytes: searchSavings.totalBytes ?? formatted.totalBytes,
    ...searchSavings,
    truncated: matchLimited || formatted.truncated,
    empty: !matchLimited && matches.length === 0,
    emptyReason: !matchLimited && matches.length === 0 ? "no_matches" : undefined,
    durationMs: result.durationMs,
  });
  await recordStats("search", meta);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: meta,
  };
}

function normalizeAstLanguage(language, searchPath, include) {
  if (typeof language === "string" && language.trim() !== "") return language.trim();
  return inferAstLanguage(searchPath) ?? inferAstLanguage(include);
}

function inferAstLanguage(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  const direct = AST_LANGUAGE_BY_EXTENSION.get(path.extname(normalized.replace(/[)}\]]+$/g, "")));
  if (direct) return direct;

  const extensions = new Set();
  for (const match of normalized.matchAll(/\.([a-z0-9]+)/g)) extensions.add(`.${match[1]}`);
  for (const brace of normalized.matchAll(/\{([^}]+)\}/g)) {
    for (const part of brace[1].split(",")) {
      const extension = part.trim().replace(/^\*?\.?/, "");
      if (extension) extensions.add(`.${extension}`);
    }
  }

  const languages = new Set([...extensions].map((extension) => AST_LANGUAGE_BY_EXTENSION.get(extension)).filter(Boolean));
  return languages.size === 1 ? [...languages][0] : undefined;
}

async function astSearchTool(pattern, searchPath, include, language, contextLines, maxMatches, maxLines, maxBytes) {
  const sg = await findAstGrep();
  if (!sg) {
    const error = new Error(
      "ast-grep was not found. Install @ast-grep/cli, install sg/ast-grep on PATH, or set SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH.",
    );
    error.code = -32000;
    throw error;
  }

  const started = Date.now();
  const sgArgs = ["run", "--pattern", pattern, "--lang", language, "--json=stream"];
  if (contextLines > 0) sgArgs.push("--context", String(contextLines));
  if (include) sgArgs.push("--globs", include);
  sgArgs.push(searchPath);

  const result = await runProcessLines(sg, sgArgs, {
    cwd: process.cwd(),
    timeout: 120_000,
    maxLines: maxMatches + 1,
    maxBytes: MAX_READ_BYTES,
    windowsCommandShim: isWindowsCommandShim(sg),
  });
  if (result.code !== 0 && !result.truncated && !result.outputTooLarge) {
    commandError(`ast-grep ${sgArgs.join(" ")}`, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge);
  }

  const matches = result.lines.map(parseAstGrepLine).filter(Boolean);
  const shown = matches.slice(0, maxMatches);
  const matchLimited = result.truncated || result.outputTooLarge || matches.length > maxMatches;
  const text = shown.length > 0
    ? formatAstMatches(shown, matchLimited)
    : "(no matches)";
  const formatted = formatOutput(text, maxLines, maxBytes);
  const meta = withResponseMeta({
    engine: "ast",
    astGrepPath: sg,
    language,
    contextLines,
    totalMatches: matchLimited ? undefined : matches.length,
    totalMatchesKnown: !matchLimited,
    matchesRead: matchLimited ? matches.length : undefined,
    shownMatches: shown.length,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: matchLimited || formatted.truncated,
    empty: shown.length === 0,
    emptyReason: shown.length === 0 ? "no_matches" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("search", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

function parseAstGrepLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function formatAstMatches(matches, limited) {
  const lines = matches.flatMap(formatAstMatch);
  if (limited) lines.push(omission("matches"));
  return lines.join("\n");
}

function formatAstMatch(match) {
  const file = typeof match.file === "string" ? relativePath(match.file) : "(unknown file)";
  const start = match.range?.start;
  const line = Number.isInteger(start?.line) ? start.line + 1 : 0;
  const column = Number.isInteger(start?.column) ? start.column + 1 : 0;
  const matchText = compactAstText(match.text);
  const header = `${file}:${line}:${column}: ${matchText}`;
  const context = formatAstContext(match, line);
  return context.length > 0 ? [header, ...context] : [header];
}

function compactAstText(text) {
  if (typeof text !== "string" || text.trim() === "") return "(match)";
  const compact = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ");
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function formatAstContext(match, startLine) {
  if (typeof match.lines !== "string" || match.lines.trim() === "") return [];
  const contextLines = match.lines.replace(/\r?\n$/, "").split(/\r?\n/);
  if (contextLines.length <= 1) return [];

  const needle = typeof match.text === "string" ? match.text.trim().split(/\r?\n/)[0]?.trim() : "";
  const matchIndex = Math.max(0, contextLines.findIndex((line) => needle && line.includes(needle)));
  const firstLine = startLine - matchIndex;

  return contextLines.map((line, index) => {
    const marker = index === matchIndex ? ">" : " ";
    return `${marker} ${firstLine + index}: ${line}`;
  });
}

async function searchWithContext(rg, pattern, searchPath, include, contextLines, maxMatches, maxLines, maxBytes) {
  const started = Date.now();
  const rgArgs = [
    "--line-number",
    "--with-filename",
    "--color",
    "never",
    "--no-heading",
    "-C",
    String(contextLines),
    "--field-match-separator",
    MATCH_SEPARATOR,
    "--field-context-separator",
    CONTEXT_SEPARATOR,
  ];
  if (include) rgArgs.push("--glob", include);
  rgArgs.push("--", pattern, searchPath);

  const result = await runProcessLines(rg, rgArgs, {
    cwd: process.cwd(),
    timeout: 120_000,
    maxLines: (maxMatches + 1) * (contextLines * 2 + 3) + 20,
    maxBytes: MAX_READ_BYTES,
  });
  if (result.code === 1) return await noMatches(rg, result.durationMs, contextLines);
  if (result.code !== 0 && !result.truncated && !result.outputTooLarge) {
    commandError(`rg ${rgArgs.join(" ")}`, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge);
  }

  const limited = limitRgContext(result.lines, maxMatches, contextLines);
  const text = limited.text || "(no matches)";
  const formatted = formatOutput(text, maxLines, maxBytes);
  const meta = withResponseMeta({
    rgPath: rg,
    contextLines,
    linesRead: result.lines.length,
    totalMatches: limited.matchLimited || result.truncated || result.outputTooLarge ? undefined : limited.matchesRead,
    totalMatchesKnown: !(limited.matchLimited || result.truncated || result.outputTooLarge),
    matchesRead: limited.matchLimited || result.truncated || result.outputTooLarge ? limited.matchesRead : undefined,
    shownMatches: limited.shownMatches,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: limited.matchLimited || result.truncated || result.outputTooLarge || formatted.truncated,
    empty: !limited.matchLimited && limited.shownMatches === 0,
    emptyReason: !limited.matchLimited && limited.shownMatches === 0 ? "no_matches" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("search", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

function limitRgContext(lines, maxMatches, contextLines) {
  const output = [];
  let pendingContext = [];
  let pendingSeparator = false;
  let lastAcceptedMatch;
  let matchesRead = 0;
  let shownMatches = 0;
  let matchLimited = false;

  for (const line of lines) {
    const parsed = parseRgContextLine(line);
    if (!parsed) continue;

    if (parsed.type === "separator") {
      pendingContext = [];
      pendingSeparator = output.length > 0 && output.at(-1) !== "--";
      lastAcceptedMatch = undefined;
    } else if (parsed.type === "match") {
      matchesRead++;
      if (shownMatches >= maxMatches) {
        matchLimited = true;
        break;
      }
      if (pendingSeparator) output.push("--");
      output.push(...pendingContext);
      pendingContext = [];
      pendingSeparator = false;
      lastAcceptedMatch = parsed;
      shownMatches++;
      output.push(formatRgContextLine(parsed, ":"));
    } else if (isAfterAcceptedMatchContext(parsed, lastAcceptedMatch, contextLines)) {
      pendingSeparator = false;
      output.push(formatRgContextLine(parsed, "-"));
    } else {
      pendingContext.push(formatRgContextLine(parsed, "-"));
    }
  }

  if (matchLimited) output.push(omission("matches"));
  return { text: output.join("\n"), matchesRead, shownMatches, matchLimited };
}

function isAfterAcceptedMatchContext(parsed, lastAcceptedMatch, contextLines) {
  if (!lastAcceptedMatch || parsed.type !== "context" || parsed.file !== lastAcceptedMatch.file) return false;
  const lineNumber = Number.parseInt(parsed.lineNumber, 10);
  const matchLineNumber = Number.parseInt(lastAcceptedMatch.lineNumber, 10);
  return Number.isInteger(lineNumber)
    && Number.isInteger(matchLineNumber)
    && lineNumber > matchLineNumber
    && lineNumber <= matchLineNumber + contextLines;
}

function parseRgContextLine(line) {
  if (line === "--") return { type: "separator" };
  const matchIndex = line.indexOf(MATCH_SEPARATOR);
  const contextIndex = line.indexOf(CONTEXT_SEPARATOR);
  const type = matchIndex !== -1 && (contextIndex === -1 || matchIndex < contextIndex) ? "match" : "context";
  const separator = type === "match" ? MATCH_SEPARATOR : CONTEXT_SEPARATOR;
  const first = line.indexOf(separator);
  if (first === -1) return undefined;
  const second = line.indexOf(separator, first + separator.length);
  if (second === -1) return undefined;

  return {
    type,
    file: line.slice(0, first),
    lineNumber: line.slice(first + separator.length, second),
    text: line.slice(second + separator.length),
  };
}

function formatRgContextLine(line, separator) {
  return `${relativePath(line.file)}${separator}${line.lineNumber}${separator}${line.text}`;
}

async function noMatches(rg, durationMs, contextLines) {
  const text = "(no matches)";
  const totalBytes = Buffer.byteLength(text, "utf8");
  const meta = withResponseMeta({
    rgPath: rg,
    contextLines,
    linesRead: 0,
    totalLines: 1,
    totalBytes,
    returnedBytes: totalBytes,
    savedBytes: 0,
    savedPercent: 0,
    estimatedTokensSaved: 0,
    truncated: false,
    empty: true,
    emptyReason: "no_matches",
    durationMs,
  });
  await recordStats("search", meta);

  return { content: [{ type: "text", text }], _meta: meta };
}
