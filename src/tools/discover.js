import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_BYTES, MAX_LINES, MAX_READ_BYTES } from "../constants.js";
import { decodeUtf8, formatOutput } from "../output.js";
import { runProcess, runProcessLines } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, omission, relativePath, savingsMeta, validateInteger, withResponseMeta } from "./shared.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export async function discoverTool(args) {
  const { mode = "summary" } = args ?? {};
  if (!["summary", "files", "tree", "outline"].includes(mode)) {
    invalidParams("discover mode must be \"summary\", \"files\", \"tree\", or \"outline\"");
  }

  if (mode === "summary") return await summaryMode(args);
  if (mode === "files") return await filesMode(args);
  if (mode === "tree") return await treeMode(args);
  return await outlineMode(args);
}

async function filesMode(args) {
  const { path: inputPath = ".", include, maxFiles = 500, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (typeof inputPath !== "string" || inputPath.trim() === "") invalidParams("discover path must be a non-empty string when provided");
  if (include !== undefined && typeof include !== "string") invalidParams("discover include must be a string when provided");
  const fileLimit = validateInteger(maxFiles, "discover maxFiles", 1, 5000);
  const lineLimit = validateInteger(maxLines, "discover maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "discover maxBytes", 1024, MAX_BYTES);

  const started = Date.now();
  let matcher;
  try {
    matcher = include ? new RegExp(include) : undefined;
  } catch {
    invalidParams("discover include must be a valid regular expression");
  }
  const { files, limited } = await listFiles(inputPath, matcher, fileLimit);
  const filtered = matcher && !limited ? files.filter((file) => matcher.test(file)) : files;
  const shown = filtered.slice(0, fileLimit);
  const text = limited
    ? [...shown, omission("files")].join("\n")
    : filtered.length > shown.length
    ? [...shown, omission("files", filtered.length - shown.length)].join("\n")
    : shown.join("\n") || "(no files)";
  const formatted = formatOutput(text, lineLimit, byteLimit);
  const meta = withResponseMeta({
    mode: "files",
    path: path.resolve(inputPath),
    relativePath: relativePath(inputPath),
    totalFiles: limited ? undefined : filtered.length,
    totalFilesKnown: !limited,
    shownFiles: shown.length,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: limited || filtered.length > shown.length || formatted.truncated,
    empty: filtered.length === 0,
    emptyReason: filtered.length === 0 ? "no_files" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("discover", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

async function listFiles(inputPath, matcher, maxFiles) {
  try {
    if (!matcher) {
      const git = await runProcessLines("git", ["ls-files", "--", inputPath], {
        cwd: process.cwd(),
        timeout: 30_000,
        maxLines: maxFiles + 1,
        maxBytes: MAX_READ_BYTES,
      });
      if (git.code === 0) {
        const limited = git.truncated || git.outputTooLarge || git.lines.length > maxFiles;
        return { files: git.lines.slice(0, maxFiles), limited };
      }
    } else {
      const git = await runProcess("git", ["ls-files", "--", inputPath], { cwd: process.cwd(), timeout: 30_000 });
      if (git.code === 0) return { files: git.stdout.split("\n").filter(Boolean), limited: false };
    }
  } catch {}

  const root = process.cwd();
  const start = path.resolve(inputPath);
  const stat = await fs.promises.stat(start);
  if (stat.isFile()) return { files: [path.relative(root, start).replaceAll(path.sep, "/")].filter((file) => !matcher || matcher.test(file)), limited: false };
  const state = { files: [], limited: false, matcher, limit: maxFiles + 1 };
  await walkFiles(root, start, state);
  const limited = state.limited || state.files.length > maxFiles;
  return { files: state.files.slice(0, maxFiles), limited };
}

async function walkFiles(root, current, state) {
  if (state.files.length >= state.limit) {
    state.limited = true;
    return;
  }
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (state.files.length >= state.limit) {
      state.limited = true;
      return;
    }
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) await walkFiles(root, entryPath, state);
    else if (entry.isFile()) {
      const file = path.relative(root, entryPath).replaceAll(path.sep, "/");
      if (!state.matcher || state.matcher.test(file)) state.files.push(file);
    }
  }
}

async function treeMode(args) {
  const { path: inputPath = ".", maxDepth = 3, maxEntries = 200, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (typeof inputPath !== "string" || inputPath.trim() === "") invalidParams("discover path must be a non-empty string when provided");
  const depthLimit = validateInteger(maxDepth, "discover maxDepth", 1, 10);
  const entryLimit = validateInteger(maxEntries, "discover maxEntries", 1, 2000);
  const lineLimit = validateInteger(maxLines, "discover maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "discover maxBytes", 1024, MAX_BYTES);

  const started = Date.now();
  const root = path.resolve(inputPath);
  const state = { entries: 0, omitted: 0, depthLimited: false };
  const lines = [relativePath(root) ?? (path.basename(root) || root)];
  await appendTree(root, "", 1, depthLimit, entryLimit, state, lines);
  if (state.omitted > 0) lines.push(omission("entries", state.omitted));

  const formatted = formatOutput(lines.join("\n"), lineLimit, byteLimit);
  const meta = withResponseMeta({
    mode: "tree",
    root,
    relativeRoot: relativePath(root),
    entriesShown: state.entries,
    entriesOmitted: state.omitted,
    entriesOmittedLowerBound: state.omitted,
    entriesOmittedKnown: state.omitted === 0,
    depthLimited: state.depthLimited,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: state.omitted > 0 || state.depthLimited || formatted.truncated,
    durationMs: Date.now() - started,
  });
  await recordStats("discover", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

async function appendTree(directory, prefix, depth, maxDepth, maxEntries, state, lines) {
  if (depth > maxDepth || state.entries >= maxEntries) return;
  const remaining = maxEntries - state.entries;
  const { entries, omitted } = await readTreeEntries(directory, remaining);
  state.omitted += omitted;

  for (const [index, entry] of entries.entries()) {
    if (state.entries >= maxEntries) {
      state.omitted += entries.length - index;
      return;
    }
    const last = omitted === 0 && index === entries.length - 1;
    lines.push(`${prefix}${last ? "└──" : "├──"} ${entry.name}${entry.isDirectory() ? "/" : ""}`);
    state.entries++;
    if (entry.isDirectory()) {
      if (depth >= maxDepth) state.depthLimited = true;
      else await appendTree(path.join(directory, entry.name), `${prefix}${last ? "    " : "│   "}`, depth + 1, maxDepth, maxEntries, state, lines);
    }
  }
}

async function readTreeEntries(directory, maxEntries) {
  const entries = [];
  let omitted = 0;
  const dir = await fs.promises.opendir(directory);

  try {
    for await (const entry of dir) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (entries.length >= maxEntries) {
        omitted++;
        break;
      }
      entries.push(entry);
    }
  } finally {
    await dir.close().catch(() => {});
  }

  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return { entries, omitted };
}

async function summaryMode(args) {
  const { maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  const lineLimit = validateInteger(maxLines, "discover maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "discover maxBytes", 1024, MAX_BYTES);
  const started = Date.now();
  const root = process.cwd();
  const lines = [`Project: ${relativePath(root)}`];

  const packageJson = await readJsonIfExists(path.join(root, "package.json"));
  if (packageJson) {
    lines.push(`Name: ${packageJson.name ?? "(unnamed)"}`);
    if (packageJson.version) lines.push(`Version: ${packageJson.version}`);
    if (packageJson.type) lines.push(`Module type: ${packageJson.type}`);
    if (packageJson.main) lines.push(`Entry: ${packageJson.main}`);
    if (packageJson.bin) lines.push(`Bin: ${typeof packageJson.bin === "string" ? packageJson.bin : Object.keys(packageJson.bin).join(", ")}`);
    if (packageJson.engines?.node) lines.push(`Node: ${packageJson.engines.node}`);
    if (packageJson.scripts) lines.push(`Scripts: ${Object.keys(packageJson.scripts).join(", ")}`);
    lines.push(`Dependencies: ${Object.keys(packageJson.dependencies ?? {}).length} runtime, ${Object.keys(packageJson.devDependencies ?? {}).length} dev`);
  }

  const readmeLines = await readReadmePreviewIfExists(path.join(root, "README.md"));
  if (readmeLines.length > 0) lines.push("", "README:", ...readmeLines);

  const configs = ["package.json", "tsconfig.json", "vite.config.js", "eslint.config.js", ".gitignore", "opencode.json", "opencode.jsonc"]
    .filter((name) => fs.existsSync(path.join(root, name)));
  if (configs.length > 0) lines.push("", `Config files: ${configs.join(", ")}`);

  try {
    const gitFiles = await runProcess("git", ["ls-files"], { cwd: root, timeout: 30_000 });
    if (gitFiles.code === 0) lines.push(`Tracked files: ${gitFiles.stdout.split("\n").filter(Boolean).length}`);
  } catch {}

  const formatted = formatOutput(lines.join("\n"), lineLimit, byteLimit);
  const meta = withResponseMeta({ mode: "summary", root, relativeRoot: relativePath(root), totalLines: formatted.totalLines, totalBytes: formatted.totalBytes, ...savingsMeta(formatted), truncated: formatted.truncated, durationMs: Date.now() - started });
  await recordStats("discover", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

async function readReadmePreviewIfExists(filePath) {
  let file;
  try {
    file = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(Math.min(MAX_READ_BYTES, 16 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const rawLines = decodeUtf8(buffer.subarray(0, bytesRead), { trimEnd: true }).split(/\r?\n/);
    const title = rawLines.find((line) => /^#\s+\S/.test(line.trim()));
    const paragraph = firstReadmeParagraph(rawLines);
    return [title, paragraph].filter(Boolean);
  } catch {
    return [];
  } finally {
    await file?.close().catch(() => {});
  }
}

function firstReadmeParagraph(lines) {
  const paragraph = [];
  let afterTitle = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!afterTitle) {
      if (/^#\s+\S/.test(line)) afterTitle = true;
      continue;
    }
    if (!line) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.startsWith("#") || line.startsWith("|")) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }

  return paragraph.join(" ");
}

async function readJsonIfExists(filePath) {
  try { return JSON.parse(await fs.promises.readFile(filePath, "utf8")); } catch { return undefined; }
}

async function outlineMode(args) {
  const { path: filePath, maxSymbols = 200, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (typeof filePath !== "string" || filePath.trim() === "") invalidParams("discover requires a non-empty path string for outline mode");
  const symbolLimit = validateInteger(maxSymbols, "discover maxSymbols", 1, 1000);
  const lineLimit = validateInteger(maxLines, "discover maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "discover maxBytes", 1024, MAX_BYTES);
  const resolved = path.resolve(filePath);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) invalidParams(`Not a file: ${filePath}`);
  if (stat.size > MAX_READ_BYTES) invalidParams(`File is too large for outline: ${filePath}`);

  const started = Date.now();
  const text = await fs.promises.readFile(resolved, "utf8");
  const outline = extractOutline(text);
  const symbols = outline.slice(0, symbolLimit);
  const output = symbols.length > 0 ? symbols.join("\n") : "(no outline symbols found)";
  const formatted = formatOutput(output, lineLimit, byteLimit);
  const meta = withResponseMeta({
    mode: "outline",
    path: resolved,
    relativePath: relativePath(resolved),
    sizeBytes: stat.size,
    symbolsFound: outline.length,
    symbolsShown: symbols.length,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: outline.length > symbols.length || formatted.truncated,
    empty: outline.length === 0,
    emptyReason: outline.length === 0 ? "no_symbols" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("discover", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

function extractOutline(text) {
  const patterns = [
    /^\s*import\s.+/,
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/,
    /^\s*(?:export\s+)?class\s+([\w$]+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=/,
  ];
  const symbols = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (patterns.some((pattern) => pattern.test(line))) symbols.push(`${index + 1}: ${line.trim()}`);
  }
  return symbols;
}
