import { MAX_BYTES } from "../constants.js";
import { discoverTool } from "./discover.js";
import { diffTool } from "./diff.js";
import { fetchTool } from "./fetch.js";
import { logsTool } from "./logs.js";
import { readTool } from "./read.js";
import { runTool } from "./run.js";
import { searchTool } from "./search.js";
import { usageTool } from "./usage.js";
import { recordUsage } from "../usage.js";

const TOOL_PREFIX = "sc-";

function internalToolName(name) {
  return typeof name === "string" && name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : undefined;
}

export const tools = {
  tools: [
    {
      name: "run",
      description:
        "Run a local shell command and return stdout only. Stderr is omitted on success; use sc-logs for stderr, exit diagnostics, or error blocks. Large stdout is bounded/truncated.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Local shell command to execute. Successful results return stdout only; stderr is counted in metadata, not included." },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Max lines before truncation. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 100,
            maximum: 1800000,
            description: "Command timeout in milliseconds. Default: 120000.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "logs",
      description:
        "Run a local shell command and extract stderr/error/warning blocks from combined output. Blocks are sorted by severity, then line. Non-zero exits return normal tool results with exit metadata.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Local shell command to execute. Combined stdout/stderr is scanned for error/log blocks." },
          maxBlocks: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Maximum error/log blocks to show. Default: 10.",
          },
          contextLines: {
            type: "integer",
            minimum: 0,
            maximum: 20,
            description: "Lines of context before and after each matched log line. Default: 5.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Max output lines before head+tail truncation. Default: 120. Logs allows up to 500 for CI/test output.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 100,
            maximum: 1800000,
            description: "Command timeout in milliseconds. Default: 120000.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "read",
      description:
        "Read one or more local UTF-8 text files and return bounded previews. Requires path or paths. Ranged reads include a compact path:line header.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Single file path to read. For fromLine/toLine with multiple files, this identifies the one ranged file." },
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: { type: "string" },
            description: "Multiple file paths to read. Max 20. If path is also provided, it is prepended and duplicates are ignored. With ranges, paths are extra non-ranged previews.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Max lines before truncation. Default: 60. With paths, defaults maxLinesPerFile.",
          },
          lineNumbers: { type: "boolean", description: "With fromLine/toLine, prefix returned lines with 1-based source line numbers. Default: false." },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768. With paths, used as maxBytesPerFile unless maxBytesPerFile is provided.",
          },
          fromLine: {
            type: "integer",
            minimum: 1,
            description: "First 1-based line to read. Use path to identify the ranged file when multiple files are provided.",
          },
          toLine: {
            type: "integer",
            minimum: 1,
            description: "Last 1-based line to read. Use path to identify the ranged file when multiple files are provided.",
          },
          maxLinesPerFile: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "For paths: max lines per file. Default: 60.",
          },
          maxBytesPerFile: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "For paths: max bytes per file. Default: 32768.",
          },
          maxTotalBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "For paths: max bytes for the combined response. Default: 32768.",
          },
          maxTotalLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "For paths: max combined response lines. Default: 200.",
          },
        },
        anyOf: [{ required: ["path"] }, { required: ["paths"] }],
      },
    },
    {
      name: "search",
      description:
        "Search local files with bounded output. engine=text treats pattern as a regex; engine=ast treats pattern as an ast-grep structural pattern.",
      inputSchema: {
        type: "object",
        properties: {
          engine: { type: "string", enum: ["text", "ast"], description: "Search engine. Default: text. Use ast for ast-grep structural patterns." },
          pattern: { type: "string", description: "Search pattern: regex for engine=text, ast-grep structural pattern for engine=ast." },
          path: { type: "string", description: "File or directory to search. Default: ." },
          include: { type: "string", description: "File glob to include, for example *.js or *.{ts,tsx}" },
          language: { type: "string", description: "ast-grep language, for example javascript, typescript, kotlin, rust. Optional for engine=ast when it can be inferred from path or include." },
          contextLines: { type: "integer", minimum: 0, maximum: 10, description: "Lines before and after each match. Default: 0." },
          maxMatches: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            description: "Maximum matches before truncation. Default: 100.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Max output lines before head+tail truncation. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "discover",
      description:
        "Discover repository structure and source outlines. Use mode=summary, files, tree, or outline before broad sc-read calls.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["summary", "files", "tree", "outline"], description: "Discovery mode. Default: summary." },
          path: { type: "string", description: "File or directory path to list. Default: . For mode=outline, this must be a single source file." },
          include: { type: "string", description: "Optional JavaScript regular expression used to filter returned file paths." },
          maxFiles: { type: "integer", minimum: 1, maximum: 5000, description: "files mode only: maximum files to show. Default: 500." },
          maxDepth: { type: "integer", minimum: 1, maximum: 10, description: "tree mode only: maximum directory depth. Default: 3." },
          maxEntries: { type: "integer", minimum: 1, maximum: 2000, description: "tree mode only: maximum entries to show. Default: 200." },
          maxSymbols: { type: "integer", minimum: 1, maximum: 1000, description: "outline mode only: maximum symbols to show. Default: 200." },
          maxLines: { type: "integer", minimum: 10, maximum: 500, description: "Max output lines before truncation. Default: 60." },
          maxBytes: { type: "integer", minimum: 1024, maximum: MAX_BYTES, description: "Max output bytes before truncation. Default: 32768." },
        },
      },
    },
    {
      name: "fetch",
      description:
        "Fetch an HTTP(S) URL reachable from this machine, including localhost/private networks, and return readable text. Non-HTTP is blocked by default; output is bounded and cached.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP(S) URL to fetch by default. Localhost/private addresses are reachable if this machine can access them." },
          force: { type: "boolean", description: "Skip cache. Default: false." },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Max lines before truncation. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "diff",
      description:
        "Show compact git diffs, tracked changed-file status, or commit history. Status/diff excludes untracked files unless they are staged.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional file or directory pathspec to diff or filter history. Blank values are treated as omitted." },
          mode: { type: "string", enum: ["diff", "status", "history"], description: "Return diff hunks, changed-file status, or commit history. Default: diff. Status shows unstaged tracked changes by default; staged=true shows staged changes." },
          staged: { type: "boolean", description: "For diff: use git diff --cached. For status: show staged instead of unstaged tracked changes. Default: false." },
          stat: { type: "boolean", description: "Include git diff --stat before hunks. Default: true." },
          maxFiles: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "diff mode only: maximum changed files with hunks to show. For history, prefer maxCommits. Default: 20.",
          },
          maxCommits: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "history mode only: maximum commits to show. Default: maxFiles for legacy compatibility, otherwise 20.",
          },
          maxHunks: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "diff mode only: maximum diff hunks to show. Default: 20.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Max output lines before head+tail truncation. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
        },
      },
    },
    {
      name: "usage",
      description:
        "Show aggregate savings stats, local usage telemetry, or usage guidance. Use mode=stats, mode=report, or mode=guidance.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["stats", "report", "guidance"], description: "Report type. Default: stats." },
          maxEvents: { type: "integer", minimum: 1, maximum: 10000, description: "Maximum recent usage events to analyze. Default: 1000." },
          maxLines: { type: "integer", minimum: 10, maximum: 500, description: "Max lines before truncation. Default: 60." },
          maxBytes: { type: "integer", minimum: 1024, maximum: MAX_BYTES, description: "Max output bytes before truncation. Default: 32768." },
        },
      },
    },
  ],
};

const handlers = {
  run: runTool,
  logs: logsTool,
  read: readTool,
  search: searchTool,
  discover: discoverTool,
  fetch: fetchTool,
  diff: diffTool,
  usage: usageTool,
};

for (const tool of tools.tools) {
  tool.name = `${TOOL_PREFIX}${tool.name}`;
  tool.inputSchema.additionalProperties = false;
}

const inputSchemas = new Map(tools.tools.map((tool) => [tool.name, tool.inputSchema]));

function suggestedPrefixedToolName(name) {
  return typeof name === "string" && Object.hasOwn(handlers, name) ? `${TOOL_PREFIX}${name}` : undefined;
}

function validateKnownArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const allowed = new Set(Object.keys(inputSchemas.get(name)?.properties ?? {}));
  const unknown = Object.keys(args).find((key) => !allowed.has(key));
  if (!unknown) return;

  const error = new Error(`Unknown argument for ${name}: ${unknown}`);
  error.code = -32602;
  throw error;
}

export async function callTool(name, args) {
  const started = Date.now();
  const internalName = internalToolName(name);
  let result;
  let error;

  try {
    const handler = internalName ? handlers[internalName] : undefined;
    if (handler) {
      validateKnownArgs(name, args);
      result = await handler(args);
      return result;
    }

    const suggestion = suggestedPrefixedToolName(name);
    error = new Error(suggestion ? `Unknown tool: ${name}. Tool names are prefixed; use ${suggestion}.` : `Unknown tool: ${name}`);
    error.code = -32601;
    throw error;
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await recordUsage(handlers[internalName] ? internalName : name, args, result, error, Date.now() - started);
  }
}
