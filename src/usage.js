import * as fs from "node:fs";
import * as path from "node:path";
import { usageLogEnabled, USAGE_LOG_FILE } from "./constants.js";

const MAX_REPORT_EVENTS = 10_000;
const REPORT_READ_BYTES = 5 * 1024 * 1024;

export async function recordUsage(toolName, args, result, error, durationMs) {
  if (!usageLogEnabled()) return;

  const meta = result?._meta ?? {};
  const event = {
    ts: Date.now(),
    project: process.cwd(),
    tool: toolName,
    durationMs,
    ok: !error,
    truncated: Boolean(meta.truncated),
    totalBytes: numberOrUndefined(meta.totalBytes),
    returnedBytes: numberOrUndefined(meta.returnedBytes),
    savedBytes: numberOrUndefined(meta.savedBytes),
    exitCode: numberOrUndefined(meta.exitCode ?? error?.status),
    errorCode: error?.code,
    commandKind: classifyCommand(args?.command),
    args: summarizeArgs(args),
  };

  try {
    await fs.promises.mkdir(path.dirname(USAGE_LOG_FILE), { recursive: true });
    await fs.promises.appendFile(USAGE_LOG_FILE, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Usage logging must never affect tool behavior.
  }
}

export async function usageReport({ maxEvents = 1000 } = {}) {
  const eventLimit = normalizeEventLimit(maxEvents);
  const entries = await readUsageEntries(eventLimit);
  const project = process.cwd();
  const projectEntries = entries.filter((entry) => entry.project === project);
  const sourceEntries = projectEntries.length > 0 ? projectEntries : entries;
  const report = summarizeUsage(sourceEntries, project, entries.length, projectEntries.length);

  return {
    text: formatUsageReport(report),
    meta: report,
  };
}

function normalizeEventLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1000;
  return Math.max(1, Math.min(Math.trunc(numeric), MAX_REPORT_EVENTS));
}

async function readUsageEntries(maxEvents) {
  let text;
  try {
    const stat = await fs.promises.stat(USAGE_LOG_FILE);
    if (stat.size > REPORT_READ_BYTES) {
      const file = await fs.promises.open(USAGE_LOG_FILE, "r");
      try {
        const buffer = Buffer.alloc(REPORT_READ_BYTES);
        await file.read(buffer, 0, REPORT_READ_BYTES, stat.size - REPORT_READ_BYTES);
        text = buffer.toString("utf8");
      } finally {
        await file.close();
      }
    } else {
      text = await fs.promises.readFile(USAGE_LOG_FILE, "utf8");
    }
  } catch {
    return [];
  }

  return text
    .split("\n")
    .filter(Boolean)
    .slice(-maxEvents)
    .map(parseUsageLine)
    .filter(Boolean);
}

function parseUsageLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed?.tool !== "string" || typeof parsed?.project !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function summarizeUsage(entries, project, eventsRead, projectEventsRead) {
  const byTool = new Map();
  const byCommandKind = new Map();
  let truncatedCalls = 0;
  let failedCalls = 0;

  for (const entry of entries) {
    if (entry.truncated) truncatedCalls++;
    if (entry.ok === false) failedCalls++;
    addSummary(byTool, entry.tool, entry);
    if (entry.commandKind) addSummary(byCommandKind, entry.commandKind, entry);
  }

  const toolSummaries = sortedSummaries(byTool);
  const commandSummaries = sortedSummaries(byCommandKind);

  return {
    project,
    logFile: USAGE_LOG_FILE,
    loggingEnabled: usageLogEnabled(),
    eventsRead,
    projectEventsRead,
    eventsAnalyzed: entries.length,
    truncatedCalls,
    failedCalls,
    byTool: toolSummaries,
    byCommandKind: commandSummaries,
    recommendations: recommendTools(commandSummaries, toolSummaries),
  };
}

function addSummary(map, key, entry) {
  if (!key) return;
  const summary = map.get(key) ?? { name: key, calls: 0, truncated: 0, failed: 0, totalBytes: 0, returnedBytes: 0, savedBytes: 0, totalDurationMs: 0 };
  summary.calls++;
  if (entry.truncated) summary.truncated++;
  if (entry.ok === false) summary.failed++;
  summary.totalBytes += numberOrZero(entry.totalBytes);
  summary.returnedBytes += numberOrZero(entry.returnedBytes);
  summary.savedBytes += numberOrZero(entry.savedBytes);
  summary.totalDurationMs += numberOrZero(entry.durationMs);
  map.set(key, summary);
}

function sortedSummaries(map) {
  return [...map.values()]
    .map((summary) => ({
      ...summary,
      avgDurationMs: summary.calls > 0 ? Math.round(summary.totalDurationMs / summary.calls) : 0,
      savedPercent: summary.totalBytes > 0 ? Math.round((summary.savedBytes / summary.totalBytes) * 100) : 0,
    }))
    .sort((a, b) => b.truncated - a.truncated || b.calls - a.calls || b.savedBytes - a.savedBytes);
}

function recommendTools(commandSummaries, toolSummaries) {
  const recommendations = [];
  const commandMap = new Map(commandSummaries.map((summary) => [summary.name, summary]));
  const toolMap = new Map(toolSummaries.map((summary) => [summary.name, summary]));

  addRecommendation(recommendations, commandMap.get("git-history"), "context_git_history", "Summarize git log/show/blame output compactly.");
  addRecommendation(recommendations, commandMap.get("dependencies"), "context_dependencies", "Summarize npm/pnpm/yarn dependency inspection output.");
  addRecommendation(recommendations, commandMap.get("infra-logs"), "context_infra_logs", "Extract relevant docker/kubectl log blocks.");
  addRecommendation(recommendations, commandMap.get("filesystem-discovery"), "context_size_or_find", "Provide bounded file finding and size summaries.");
  addRecommendation(recommendations, commandMap.get("file-read"), "context_read_guidance", "Improve instructions or add file-read conveniences.");

  const search = commandMap.get("search-discovery");
  const grepTool = toolMap.get("context_grep_context");
  if (search && (!grepTool || search.calls > grepTool.calls)) {
    addRecommendation(recommendations, search, "context_search_workflow", "Improve search plus surrounding file-context workflows.");
  }

  return recommendations;
}

function addRecommendation(recommendations, summary, toolName, reason) {
  if (!summary) return;
  if (summary.calls < 3 && summary.truncated === 0) return;
  recommendations.push({
    toolName,
    reason,
    evidence: `${summary.calls} ${summary.name} commands, ${summary.truncated} truncated, ${summary.failed} failed`,
    calls: summary.calls,
    truncated: summary.truncated,
  });
}

function formatUsageReport(report) {
  if (report.eventsAnalyzed === 0) {
    return [
      `Usage summary for ${report.project}`,
      `Log file: ${report.logFile}`,
      "No usage events found yet.",
    ].join("\n");
  }

  const lines = [
    `Usage summary for ${report.project}`,
    `Log file: ${report.logFile}`,
    `Events analyzed: ${report.eventsAnalyzed} (${report.projectEventsRead} for this project, ${report.eventsRead} read)`,
    `Truncated calls: ${report.truncatedCalls}`,
    `Failed calls: ${report.failedCalls}`,
  ];

  lines.push("", "By tool:");
  for (const summary of report.byTool.slice(0, 10)) lines.push(formatSummaryLine(summary));

  if (report.byCommandKind.length > 0) {
    lines.push("", "Command kinds:");
    for (const summary of report.byCommandKind.slice(0, 10)) lines.push(formatSummaryLine(summary));
  }

  if (report.recommendations.length > 0) {
    lines.push("", "Potential new tools:");
    for (const recommendation of report.recommendations.slice(0, 10)) {
      lines.push(`${recommendation.toolName}: ${recommendation.evidence} - ${recommendation.reason}`);
    }
  } else {
    lines.push("", "Potential new tools:", "No strong candidates yet.");
  }

  return lines.join("\n");
}

function formatSummaryLine(summary) {
  return `${summary.name}: ${summary.calls} calls, ${summary.truncated} truncated, ${summary.failed} failed, saved ${formatBytes(summary.savedBytes)} (${summary.savedPercent}%), avg ${summary.avgDurationMs}ms`;
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return {};
  const summary = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "command") {
      summary.hasCommand = typeof value === "string" && value.length > 0;
    } else if (key === "paths") {
      summary[key] = Array.isArray(value) ? `array:${value.length}` : typeof value;
    } else if (["path", "url", "include", "pattern"].includes(key)) {
      summary[key] = typeof value;
    } else if (["maxLines", "maxBytes", "maxLinesPerFile", "maxBytesPerFile", "maxTotalBytes", "maxMatches", "maxFiles", "maxHunks", "maxBlocks", "contextLines"].includes(key)) {
      summary[key] = numberOrUndefined(value);
    } else if (typeof value === "boolean") {
      summary[key] = value;
    }
  }
  return summary;
}

export function classifyCommand(command) {
  if (typeof command !== "string" || command.trim() === "") return undefined;
  const normalized = command.toLowerCase();

  if (/\bgit\s+(log|show|blame|reflog|shortlog)\b/.test(normalized)) return "git-history";
  if (/\bgit\s+(diff|status|stash|branch|remote)\b/.test(normalized)) return "git-review";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|lint|build)|check|lint|build)\b/.test(normalized)) return "test-build";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:ls|list|why|outdated|audit|info|view)\b/.test(normalized)) return "dependencies";
  if (/\b(?:docker|kubectl)\s+logs\b|\bkubectl\s+(?:get|describe)\b/.test(normalized)) return "infra-logs";
  if (/\b(?:rg|grep|ag)\b/.test(normalized)) return "search-discovery";
  if (/\b(?:find|fd|tree|du|ls)\b/.test(normalized)) return "filesystem-discovery";
  if (/\b(?:cat|type|get-content)\b/.test(normalized)) return "file-read";
  return "other";
}

function numberOrUndefined(value) {
  return Number.isFinite(value) ? value : undefined;
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
