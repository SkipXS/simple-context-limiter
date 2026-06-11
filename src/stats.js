import * as fs from "node:fs";
import { STATS_FILE } from "./constants.js";
import { withFileLock, writeJsonAtomically } from "./storage.js";

let stats;
let statsUpdate = Promise.resolve();

function emptyStats() {
  return { version: 1, projects: {} };
}

export function emptyCounter() {
  return {
    calls: 0,
    totalBytes: 0,
    returnedBytes: 0,
    savedBytes: 0,
    estimatedTokensSaved: 0,
  };
}

export function normalizeCounter(value) {
  return {
    ...emptyCounter(),
    calls: Number.isFinite(value?.calls) ? value.calls : 0,
    totalBytes: Number.isFinite(value?.totalBytes) ? value.totalBytes : 0,
    returnedBytes: Number.isFinite(value?.returnedBytes) ? value.returnedBytes : 0,
    savedBytes: Number.isFinite(value?.savedBytes) ? value.savedBytes : 0,
    estimatedTokensSaved: Number.isFinite(value?.estimatedTokensSaved) ? value.estimatedTokensSaved : 0,
  };
}

function normalizeStats(value) {
  const nextStats = emptyStats();

  for (const [project, projectStats] of Object.entries(value?.projects ?? {})) {
    if (typeof project !== "string" || !project) continue;

    const normalizedProject = {
      ...normalizeCounter(projectStats),
      byTool: {},
    };

    for (const [toolName, toolStats] of Object.entries(projectStats?.byTool ?? {})) {
      if (typeof toolName !== "string" || !toolName) continue;
      normalizedProject.byTool[toolName] = normalizeCounter(toolStats);
    }

    nextStats.projects[project] = normalizedProject;
  }

  return nextStats;
}

async function loadStats() {
  try { return normalizeStats(JSON.parse(await fs.promises.readFile(STATS_FILE, "utf8"))); } catch {
    return emptyStats();
  }
}

async function saveStats(nextStats) {
  stats = normalizeStats(nextStats);
  const snapshot = stats;
  try {
    await writeJsonAtomically(STATS_FILE, snapshot);
  } catch {
    // Stats failures should not make context tools unusable.
  }
}

export async function getStats() {
  if (stats === undefined) stats = await loadStats();
  return stats;
}

function addCounter(target, meta) {
  const totalBytes = meta.totalBytes ?? 0;
  const returnedBytes = Math.min(meta.returnedBytes ?? 0, totalBytes);
  const savedBytes = Math.max(0, totalBytes - returnedBytes);

  target.calls++;
  target.totalBytes += totalBytes;
  target.returnedBytes += returnedBytes;
  target.savedBytes += savedBytes;
  target.estimatedTokensSaved += Math.ceil(savedBytes / 4);
}

export async function recordStats(toolName, meta) {
  statsUpdate = statsUpdate.catch(() => {}).then(async () => {
    try {
      await withFileLock(STATS_FILE, async () => {
        const currentStats = await loadStats();
        const project = process.cwd();
        const projectStats = currentStats.projects[project] ?? { ...emptyCounter(), byTool: {} };
        const toolStats = projectStats.byTool[toolName] ?? emptyCounter();

        addCounter(projectStats, meta);
        addCounter(toolStats, meta);

        projectStats.byTool[toolName] = toolStats;
        currentStats.projects[project] = projectStats;
        await saveStats(currentStats);
      });
    } catch {
      // Stats failures should not make context tools unusable.
    }
  });
  await statsUpdate;
}

export function withSavedPercent(counter) {
  return {
    ...counter,
    savedPercent: counter.totalBytes > 0 ? Math.round((counter.savedBytes / counter.totalBytes) * 100) : 0,
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatStatsLine(label, stats) {
  return `${label}: ${stats.calls} calls · saved ${formatBytes(stats.savedBytes)} (${stats.savedPercent}%) · returned ${formatBytes(stats.returnedBytes)} / ${formatBytes(stats.totalBytes)} · ~${formatNumber(stats.estimatedTokensSaved)} tokens`;
}

export function formatStatsReport(stats) {
  const lines = [
    stats.project,
    formatStatsLine("Total", stats),
  ];
  const tools = Object.entries(stats.byTool)
    .sort((a, b) => b[1].savedBytes - a[1].savedBytes || b[1].calls - a[1].calls);

  if (tools.length > 0) {
    lines.push("", "By tool:");
    for (const [toolName, toolStats] of tools) lines.push(formatStatsLine(toolName, toolStats));
  }

  return lines.join("\n");
}
