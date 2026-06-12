import { MAX_BYTES, MAX_LINES, projectKey } from "../constants.js";
import { formatOutput } from "../output.js";
import { emptyCounter, formatStatsReport, getStats, normalizeCounter, withSavedPercent } from "../stats.js";
import { usageReport } from "../usage.js";
import { invalidParams, savingsMeta, validateInteger } from "./shared.js";

export async function usageTool(args) {
  const { mode = "stats", maxEvents = 1000, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (mode !== "stats" && mode !== "report" && mode !== "guidance") invalidParams("context_usage mode must be \"stats\", \"report\", or \"guidance\"");

  const lineLimit = validateInteger(maxLines, "context_usage maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_usage maxBytes", 1024, MAX_BYTES);
  if (mode === "stats") return statsResult(lineLimit, byteLimit);

  const eventLimit = validateInteger(maxEvents, "context_usage maxEvents", 1, 10000);
  const started = Date.now();
  const report = await usageReport({ maxEvents: eventLimit });
  const text = mode === "guidance" ? formatGuidance(report.meta) : report.text;
  const formatted = formatOutput(text, lineLimit, byteLimit);
  const meta = {
    mode,
    ...report.meta,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: formatted.truncated,
    durationMs: Date.now() - started,
  };

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

function formatGuidance(report) {
  if (report.eventsAnalyzed === 0) {
    const lines = [
      `Usage guidance for ${report.project}`,
      `Log file: ${report.logFile}`,
    ];
    if (report.ignoredProject) lines.push("Current working directory is a markerless temp directory; usage is ignored.");
    else lines.push("No usage events found yet.");
    return lines.join("\n");
  }

  const lines = [
    `Usage guidance for ${report.project}`,
    `Events analyzed: ${report.eventsAnalyzed} (${report.projectEventsRead} for this project, ${report.eventsRead} read)`,
    `Truncated calls: ${report.truncatedCalls}`,
    `Failed calls: ${report.failedCalls}`,
  ];

  lines.push("", "Recommended tools/modes:");
  if (report.recommendations.length > 0) {
    for (const recommendation of report.recommendations.slice(0, 10)) {
      lines.push(`${recommendation.toolName}: ${recommendation.evidence} - ${recommendation.reason}`);
    }
  } else {
    lines.push("No strong candidates yet.");
  }

  const noisyTools = report.byTool
    .filter((summary) => summary.failed > 0 || summary.truncated > 0)
    .slice(0, 10);
  if (noisyTools.length > 0) {
    lines.push("", "High-signal tool patterns:");
    for (const summary of noisyTools) {
      lines.push(`${summary.name}: ${summary.calls} calls, ${summary.truncated} truncated, ${summary.failed} failed`);
    }
  }

  lines.push("", "Practical guidance:");
  lines.push("Use context_diff mode=history instead of raw git log for compact commit history.");
  lines.push("Use context_read path with fromLine/toLine for targeted ranges; use paths for additional non-ranged files.");
  lines.push("When _meta.truncated is true, retry with a narrower path/range/query before using raw shell output.");

  return lines.join("\n");
}

async function statsResult(maxLines, maxBytes) {
  const started = Date.now();
  const currentStats = await getStats();
  const project = projectKey() ?? process.cwd();
  const projectStats = currentStats.projects[project] ?? { ...emptyCounter(), byTool: {} };
  const byTool = Object.fromEntries(
    Object.entries(projectStats.byTool ?? {}).map(([toolName, toolStats]) => [toolName, withSavedPercent(normalizeCounter(toolStats))]),
  );
  const stats = {
    mode: "stats",
    project,
    ...withSavedPercent(normalizeCounter(projectStats)),
    byTool,
  };
  const formatted = formatOutput(formatStatsReport(stats), maxLines, maxBytes);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      ...stats,
      totalLines: formatted.totalLines,
      responseTotalBytes: formatted.totalBytes,
      responseReturnedBytes: formatted.returnedBytes,
      responseSavedBytes: formatted.savedBytes,
      responseSavedPercent: formatted.savedPercent,
      responseEstimatedTokensSaved: formatted.estimatedTokensSaved,
      truncated: formatted.truncated,
      durationMs: Date.now() - started,
    },
  };
}
