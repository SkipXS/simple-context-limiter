import { formatStatsReport, getStats, normalizeCounter, emptyCounter, withSavedPercent } from "../stats.js";

export async function statsTool() {
  const currentStats = await getStats();
  const project = process.cwd();
  const projectStats = currentStats.projects[project] ?? { ...emptyCounter(), byTool: {} };
  const byTool = Object.fromEntries(
    Object.entries(projectStats.byTool ?? {}).map(([toolName, toolStats]) => [toolName, withSavedPercent(normalizeCounter(toolStats))]),
  );
  const result = {
    project,
    ...withSavedPercent(normalizeCounter(projectStats)),
    byTool,
  };

  return {
    content: [{ type: "text", text: formatStatsReport(result) }],
    _meta: result,
  };
}
