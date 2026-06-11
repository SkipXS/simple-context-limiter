import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_BYTES, MAX_LINES } from "../constants.js";
import { formatOutput } from "../output.js";
import { runProcess } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, savingsMeta, validateInteger } from "./shared.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export async function filesTool(args) {
  const { path: inputPath = ".", include, maxFiles = 500, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (typeof inputPath !== "string" || inputPath.trim() === "") invalidParams("context_files path must be a non-empty string when provided");
  if (include !== undefined && typeof include !== "string") invalidParams("context_files include must be a string when provided");
  const fileLimit = validateInteger(maxFiles, "context_files maxFiles", 1, 5000);
  const lineLimit = validateInteger(maxLines, "context_files maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_files maxBytes", 1024, MAX_BYTES);

  const started = Date.now();
  const files = await listFiles(inputPath);
  let matcher;
  try {
    matcher = include ? new RegExp(include) : undefined;
  } catch {
    invalidParams("context_files include must be a valid regular expression");
  }
  const filtered = matcher ? files.filter((file) => matcher.test(file)) : files;
  const shown = filtered.slice(0, fileLimit);
  const text = filtered.length > shown.length
    ? [...shown, `... ${filtered.length - shown.length} more files omitted ...`].join("\n")
    : shown.join("\n") || "(no files)";
  const formatted = formatOutput(text, lineLimit, byteLimit);
  const meta = {
    totalFiles: filtered.length,
    shownFiles: shown.length,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: filtered.length > shown.length || formatted.truncated,
    durationMs: Date.now() - started,
  };
  await recordStats("context_files", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

async function listFiles(inputPath) {
  try {
    const git = await runProcess("git", ["ls-files", "--", inputPath], { cwd: process.cwd(), timeout: 30_000 });
    if (git.code === 0) return git.stdout.split("\n").filter(Boolean);
  } catch {}

  const root = process.cwd();
  const start = path.resolve(inputPath);
  return await walkFiles(root, start);
}

async function walkFiles(root, current) {
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, entryPath));
    else if (entry.isFile()) files.push(path.relative(root, entryPath).replaceAll(path.sep, "/"));
  }
  return files;
}
