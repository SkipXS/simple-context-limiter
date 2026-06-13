import { DEFAULT_BYTES, DEFAULT_COMMAND_TIMEOUT_MS, MAX_BYTES, MAX_COMMAND_TIMEOUT_MS, MAX_LINES, MIN_COMMAND_TIMEOUT_MS } from "../constants.js";
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

export const COMMON_SCHEMA_DEFAULTS = Object.freeze({
  maxLines: MAX_LINES,
  maxBytes: DEFAULT_BYTES,
  timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
});

function integerProperty({ minimum, maximum, defaultValue, description }) {
  return {
    type: "integer",
    minimum,
    maximum,
    default: defaultValue,
    description: `${description} Default: ${defaultValue}.`,
  };
}

function maxLinesProperty(description = "Content line cap.", defaultValue = COMMON_SCHEMA_DEFAULTS.maxLines) {
  return integerProperty({ minimum: 10, maximum: 500, defaultValue, description });
}

function maxBytesProperty(description = "Byte cap.") {
  return integerProperty({ minimum: 1024, maximum: MAX_BYTES, defaultValue: COMMON_SCHEMA_DEFAULTS.maxBytes, description });
}

function timeoutMsProperty() {
  return integerProperty({ minimum: MIN_COMMAND_TIMEOUT_MS, maximum: MAX_COMMAND_TIMEOUT_MS, defaultValue: COMMON_SCHEMA_DEFAULTS.timeoutMs, description: "Timeout ms." });
}

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
          maxLines: maxLinesProperty(),
          maxBytes: maxBytesProperty(),
          timeoutMs: timeoutMsProperty(),
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
          maxLines: maxLinesProperty("Content line cap.", 120),
          maxBytes: maxBytesProperty(),
          timeoutMs: timeoutMsProperty(),
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
          maxLines: maxLinesProperty("Content line cap; per-file in paths mode."),
          lineNumbers: { type: "boolean", description: "Number ranged lines. Default: false." },
          maxBytes: maxBytesProperty("Byte cap; per-file in paths mode."),
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
          maxLinesPerFile: maxLinesProperty("paths mode: lines per file."),
          maxBytesPerFile: maxBytesProperty("paths mode: bytes per file."),
          maxTotalBytes: maxBytesProperty("paths mode: total byte cap."),
          maxTotalLines: {
            type: "integer",
            minimum: 10,
            maximum: 500,
            description: "paths mode: total line cap. Default: 200.",
          },
        },
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
          contextLines: { type: "integer", minimum: 0, maximum: 10, default: 0, description: "Context lines. Default: 0." },
          maxMatches: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            default: 100,
            description: "Match cap. Default: 100.",
          },
          maxLines: maxLinesProperty(),
          maxBytes: maxBytesProperty(),
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
          maxSymbols: { type: "integer", minimum: 1, maximum: 1000, default: 200, description: "outline: symbol cap. Default: 200." },
          maxLines: maxLinesProperty(),
          maxBytes: maxBytesProperty(),
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
          force: { type: "boolean", description: "Skip cache read and refresh. Default: false." },
          cache: { type: "boolean", description: "Override fetch cache use. Default: public text only; private literal hosts bypass unless opted in." },
          maxLines: maxLinesProperty(),
          maxBytes: maxBytesProperty(),
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
            default: 20,
            description: "diff: hunk cap. Default: 20.",
          },
          maxLines: maxLinesProperty(),
          maxBytes: maxBytesProperty(),
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
          maxEvents: { type: "integer", minimum: 1, maximum: 10000, default: 1000, description: "Event cap. Default: 1000." },
          maxLines: maxLinesProperty(),
          maxBytes: maxBytesProperty(),
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

export function registeredToolNamesForTest() {
  return Object.keys(handlers).map((name) => `${TOOL_PREFIX}${name}`);
}

for (const tool of tools.tools) {
  tool.name = `${TOOL_PREFIX}${tool.name}`;
  tool.inputSchema.additionalProperties = false;
}

const inputSchemas = new Map(tools.tools.map((tool) => [tool.name, tool.inputSchema]));

function suggestedPrefixedToolName(name) {
  return typeof name === "string" && Object.hasOwn(handlers, name) ? `${TOOL_PREFIX}${name}` : undefined;
}

function invalidToolParams(message) {
  const error = new Error(message);
  error.code = -32602;
  throw error;
}

function validateSchemaArgs(name, args) {
  const schema = inputSchemas.get(name);
  if (!schema) return;

  const input = args ?? {};
  if (typeof input !== "object" || Array.isArray(input)) invalidToolParams(`${name} arguments must be an object`);

  const properties = schema.properties ?? {};
  const allowed = new Set(Object.keys(properties));
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) invalidToolParams(`Unknown argument for ${name}: ${unknown}`);

  for (const required of schema.required ?? []) {
    if (input[required] === undefined) invalidToolParams(`Missing required argument for ${name}: ${required}`);
  }

  for (const [key, value] of Object.entries(input)) {
    validateSchemaValue(name, key, value, properties[key]);
  }
}

function validateSchemaValue(toolName, key, value, schema) {
  if (!schema || value === undefined) return;

  if (schema.type === "integer") {
    const label = schemaLabel(toolName, key);
    const range = schema.maximum === undefined ? `>= ${schema.minimum}` : `between ${schema.minimum} and ${schema.maximum}`;
    if (typeof value !== "number" || !Number.isInteger(value)) invalidToolParams(`${label} must be an integer ${range}`);
    if (schema.minimum !== undefined && value < schema.minimum) invalidToolParams(`${label} must be ${range}`);
    if (schema.maximum !== undefined && value > schema.maximum) invalidToolParams(`${label} must be ${range}`);
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) invalidToolParams(`${toolName} ${key} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) invalidToolParams(`${toolName} ${key} must contain at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) invalidToolParams(`${toolName} ${key} must contain at most ${schema.maxItems} item(s)`);
    if (schema.items) {
      for (const [index, item] of value.entries()) validateSchemaValue(toolName, `${key}[${index}]`, item, schema.items);
    }
    return;
  }

  if (schema.type && typeof value !== schema.type) invalidToolParams(`${schemaLabel(toolName, key)} must be a ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) invalidToolParams(`${schemaLabel(toolName, key)} must be one of: ${schema.enum.join(", ")}`);
}

function schemaLabel(toolName, key) {
  const bareToolName = toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : toolName;
  return `${bareToolName} ${key}`;
}

export async function callTool(name, args) {
  const started = Date.now();
  const internalName = internalToolName(name);
  let result;
  let error;

  try {
    const handler = internalName ? handlers[internalName] : undefined;
    if (handler) {
      validateSchemaArgs(name, args);
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
