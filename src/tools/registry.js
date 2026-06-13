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
        "Run a shell command; return bounded stdout. Stderr is omitted on success; use sc-logs for diagnostics.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Content line cap. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Byte cap. Default: 32768.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 100,
            maximum: 1800000,
            description: "Timeout ms. Default: 120000.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "logs",
      description:
        "Run a command and show bounded error/warning blocks from stdout+stderr, with exit metadata.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command whose combined output is scanned." },
          maxBlocks: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Block cap. Default: 10.",
          },
          contextLines: {
            type: "integer",
            minimum: 0,
            maximum: 20,
            description: "Context lines around matches. Default: 5.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Content line cap. Default: 120.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Byte cap. Default: 32768.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 100,
            maximum: 1800000,
            description: "Timeout ms. Default: 120000.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "read",
      description:
        "Read bounded UTF-8 file previews. Use path/fromLine/toLine for one ranged file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Primary file path; ranged when fromLine/toLine set." },
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: { type: "string" },
            description: "Standalone list or extra files, max 20. Ranges apply only to path/one file.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Content line cap. Default: 60; per-file in paths mode.",
          },
          lineNumbers: { type: "boolean", description: "Number ranged lines. Default: false." },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Byte cap. Default: 32768; per-file in paths mode.",
          },
          fromLine: {
            type: "integer",
            minimum: 1,
            description: "First 1-based line for ranged read.",
          },
          toLine: {
            type: "integer",
            minimum: 1,
            description: "Last 1-based line for ranged read.",
          },
          maxLinesPerFile: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "paths mode: lines per file. Default: 60.",
          },
          maxBytesPerFile: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "paths mode: bytes per file. Default: 32768.",
          },
          maxTotalBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "paths mode: total byte cap. Default: 32768.",
          },
          maxTotalLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "paths mode: total line cap. Default: 200.",
          },
        },
        anyOf: [{ required: ["path"] }, { required: ["paths"] }],
      },
    },
    {
      name: "search",
      description:
        "Search local files with bounded text or ast-grep output.",
      inputSchema: {
        type: "object",
        properties: {
          engine: { type: "string", enum: ["text", "ast"], description: "Default: text; ast uses ast-grep." },
          pattern: { type: "string", description: "Regex for text; ast-grep pattern for ast." },
          path: { type: "string", description: "Search path. Default: ." },
          include: { type: "string", description: "Include glob, not regex, e.g. *.js." },
          language: { type: "string", description: "ast-grep language when not inferred." },
          contextLines: { type: "integer", minimum: 0, maximum: 10, description: "Context lines. Default: 0." },
          maxMatches: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            description: "Match cap. Default: 100.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Content line cap. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Byte cap. Default: 32768.",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "discover",
      description:
        "Discover repo summary, files, tree, or source outline before broad reads.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["summary", "files", "tree", "outline"], description: "Mode. Default: summary." },
          path: { type: "string", description: "Path. Default: .; outline requires a file." },
          include: { type: "string", description: "Regex filter for file paths." },
          maxFiles: { type: "integer", minimum: 1, maximum: 5000, description: "files: file cap. Default: 500." },
          maxDepth: { type: "integer", minimum: 1, maximum: 10, description: "tree: depth cap. Default: 3." },
          maxEntries: { type: "integer", minimum: 1, maximum: 2000, description: "tree: entry cap. Default: 200." },
          maxSymbols: { type: "integer", minimum: 1, maximum: 1000, description: "outline: symbol cap. Default: 200." },
          maxLines: { type: "integer", minimum: 10, maximum: 500, description: "Content line cap. Default: 60." },
          maxBytes: { type: "integer", minimum: 1024, maximum: MAX_BYTES, description: "Byte cap. Default: 32768." },
        },
      },
    },
    {
      name: "fetch",
      description:
        "Fetch bounded readable text from HTTP(S), including localhost/private URLs. Lightweight HTML stripping; no JS rendering.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP(S) URL; localhost/private reachable." },
          force: { type: "boolean", description: "Skip cache. Default: false." },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Content line cap. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Byte cap. Default: 32768.",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "diff",
      description:
        "Show compact git diff, tracked status, or commit history. Untracked files are excluded.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional git pathspec; blank omitted." },
          mode: { type: "string", enum: ["diff", "status", "history"], description: "Mode. Default: diff; status honors staged." },
          staged: { type: "boolean", description: "Use staged/cached changes. Default: false." },
          stat: { type: "boolean", description: "Include diffstat. Default: true." },
          maxFiles: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "diff: file cap. Default: 20.",
          },
          maxCommits: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "history: commit cap. Default: 20.",
          },
          maxHunks: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "diff: hunk cap. Default: 20.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "Content line cap. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Byte cap. Default: 32768.",
          },
        },
      },
    },
    {
      name: "usage",
      description:
        "Show savings stats, usage report, or guidance.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["stats", "report", "guidance"], description: "Mode. Default: stats." },
          maxEvents: { type: "integer", minimum: 1, maximum: 10000, description: "Event cap. Default: 1000." },
          maxLines: { type: "integer", minimum: 10, maximum: 500, description: "Content line cap. Default: 60." },
          maxBytes: { type: "integer", minimum: 1024, maximum: MAX_BYTES, description: "Byte cap. Default: 32768." },
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
