import { MAX_BYTES, MAX_LINES } from "../constants.js";
import { formatOutput } from "../output.js";
import { commandError, runProcess } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, savingsForText, validateInteger } from "./shared.js";

export async function diffTool(args) {
  const {
    path: diffPath,
    mode = "diff",
    staged = false,
    stat = true,
    maxFiles = 20,
    maxHunks = 20,
    maxLines = MAX_LINES,
    maxBytes = MAX_BYTES,
  } = args ?? {};

  let normalizedDiffPath = diffPath;
  if (diffPath !== undefined) {
    if (typeof diffPath !== "string") invalidParams("context_diff path must be a string when provided");
    if (diffPath.trim() === "") normalizedDiffPath = undefined;
  }
  if (mode !== "diff" && mode !== "status" && mode !== "history") invalidParams("context_diff mode must be \"diff\", \"status\", or \"history\"");
  if (typeof staged !== "boolean") {
    invalidParams("context_diff staged must be a boolean when provided");
  }
  if (typeof stat !== "boolean") {
    invalidParams("context_diff stat must be a boolean when provided");
  }

  const fileLimit = validateInteger(maxFiles, "context_diff maxFiles", 1, 100);
  const hunkLimit = validateInteger(maxHunks, "context_diff maxHunks", 1, 200);
  const lineLimit = validateInteger(maxLines, "context_diff maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_diff maxBytes", 1024, MAX_BYTES);

  if (mode === "status") return await statusTool(normalizedDiffPath, staged, lineLimit, byteLimit);
  if (mode === "history") return await historyTool(normalizedDiffPath, fileLimit, lineLimit, byteLimit);

  const started = Date.now();
  const diffArgs = gitDiffArgs(staged, [], normalizedDiffPath);
  const statPromise = stat ? runGit(gitDiffArgs(staged, ["--stat"], normalizedDiffPath)) : undefined;
  const diffPromise = runGit(diffArgs);
  const [statResult, diffResult] = await Promise.all([statPromise, diffPromise]);
  const durationMs = Date.now() - started;

  const statText = statResult?.stdout.trimEnd() ?? "";
  const fullDiff = diffResult.stdout.trimEnd();
  const limitedDiff = limitDiff(fullDiff, fileLimit, hunkLimit);
  const originalText = composeDiffText(statText, fullDiff);
  const previewText = composeDiffText(statText, limitedDiff.text);
  const formatted = formatOutput(previewText, lineLimit, byteLimit);
  const diffSavings = savingsForText(originalText, formatted.text);
  const meta = {
    totalLines: originalText.split("\n").length,
    totalBytes: diffSavings.totalBytes,
    ...diffSavings,
    truncated: limitedDiff.filesLimited || limitedDiff.hunksLimited || formatted.truncated,
    mode,
    staged,
    stat,
    filesChanged: countDiffFiles(fullDiff),
    filesShown: limitedDiff.filesShown,
    filesLimited: limitedDiff.filesLimited,
    hunksChanged: countDiffHunks(fullDiff),
    hunksShown: limitedDiff.hunksShown,
    hunksLimited: limitedDiff.hunksLimited,
    durationMs,
  };
  await recordStats("context_diff", meta);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: meta,
  };
}

async function historyTool(diffPath, maxCommits, maxLines, maxBytes) {
  const started = Date.now();
  const args = [
    "log",
    `--max-count=${maxCommits}`,
    "--date=short",
    "--pretty=format:commit %h%nDate: %ad%nAuthor: %an%nSubject: %s",
    "--name-status",
  ];
  if (diffPath !== undefined) args.push("--", diffPath);
  const result = await runGit(args);
  const raw = result.stdout.trimEnd();
  const text = raw ? `Commit history:\n${raw}` : "(no commit history)";
  const formatted = formatOutput(text, maxLines, maxBytes);
  const historySavings = savingsForText(text, formatted.text);
  const meta = {
    mode: "history",
    path: diffPath,
    maxCommits,
    commitsShown: countHistoryCommits(raw),
    totalLines: text.split("\n").length,
    totalBytes: historySavings.totalBytes,
    ...historySavings,
    truncated: formatted.truncated,
    durationMs: Date.now() - started,
  };
  await recordStats("context_diff", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

async function statusTool(diffPath, staged, maxLines, maxBytes) {
  const started = Date.now();
  const args = ["status", "--porcelain=v1", "--untracked-files=no"];
  if (diffPath !== undefined) args.push("--", diffPath);
  const result = await runProcess("git", args, { cwd: process.cwd(), timeout: 30_000 });
  if (result.code !== 0 || result.timedOut || result.outputTooLarge) {
    commandError(`git ${args.join(" ")}`, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge, 30_000);
  }

  const lines = result.stdout.trimEnd().split("\n").filter(Boolean)
    .filter((line) => staged ? line[0] !== " " : line[1] !== " ")
    .map(formatStatusLine);
  const text = lines.join("\n") || "(no changed files)";
  const formatted = formatOutput(text, maxLines, maxBytes);
  const meta = {
    mode: "status",
    path: diffPath,
    staged,
    changedFiles: lines.length,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    returnedBytes: formatted.returnedBytes,
    savedBytes: formatted.savedBytes,
    savedPercent: formatted.savedPercent,
    estimatedTokensSaved: formatted.estimatedTokensSaved,
    truncated: formatted.truncated,
    durationMs: Date.now() - started,
  };
  await recordStats("context_diff", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

function formatStatusLine(line) {
  return `${line.slice(0, 2)} ${line.slice(3)}`;
}

function gitDiffArgs(staged, extraArgs, diffPath) {
  const args = ["diff"];
  if (staged) args.push("--cached");
  args.push(...extraArgs);
  if (diffPath !== undefined) args.push("--", diffPath);
  return args;
}

async function runGit(args) {
  const result = await runProcess("git", args, { cwd: process.cwd(), timeout: 120_000 });
  if (result.code !== 0 || result.timedOut || result.outputTooLarge) {
    commandError(`git ${args.join(" ")}`, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge);
  }

  return result;
}

function composeDiffText(statText, diffText) {
  const parts = [];
  if (statText) parts.push("Diff stat:", statText);
  if (diffText) {
    if (parts.length > 0) parts.push("");
    parts.push("Diff hunks:", diffText);
  }

  return parts.length > 0 ? parts.join("\n") : "(no diff)";
}

function countDiffFiles(diffText) {
  return diffText ? diffText.split("\n").filter((line) => line.startsWith("diff --git ")).length : 0;
}

function countDiffHunks(diffText) {
  return diffText ? diffText.split("\n").filter((line) => line.startsWith("@@ ")).length : 0;
}

function countHistoryCommits(historyText) {
  return historyText ? historyText.split("\n").filter((line) => line.startsWith("commit ")).length : 0;
}

function limitDiff(diffText, maxFiles, maxHunks) {
  if (!diffText) {
    return { text: "", filesShown: 0, hunksShown: 0, filesLimited: false, hunksLimited: false };
  }

  const lines = diffText.split("\n");
  const output = [];
  let filesShown = 0;
  let hunksShown = 0;
  let filesLimited = false;
  let hunksLimited = false;
  let includeFile = false;
  let includeHunk = false;
  let seenHunkInFile = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      includeHunk = false;
      seenHunkInFile = false;

      if (filesShown >= maxFiles) {
        filesLimited = true;
        includeFile = false;
        continue;
      }

      includeFile = true;
      filesShown++;
      output.push(line);
      continue;
    }

    if (!includeFile) continue;

    if (line.startsWith("@@ ")) {
      seenHunkInFile = true;
      if (hunksShown >= maxHunks) {
        hunksLimited = true;
        includeHunk = false;
        if (output.at(-1) !== "... more hunks omitted ...") output.push("... more hunks omitted ...");
        continue;
      }

      includeHunk = true;
      hunksShown++;
      output.push(line);
      continue;
    }

    if (!seenHunkInFile || includeHunk) output.push(line);
  }

  if (filesLimited) output.push("... more files omitted ...");

  return {
    text: output.join("\n"),
    filesShown,
    hunksShown,
    filesLimited,
    hunksLimited,
  };
}
