# simple-context-limiter

A minimal MCP server that keeps large command, log, file, search, repo-discovery, web, and git diff output out of your LLM context. Eight tools, zero dependencies, works in MCP-compatible clients such as Pi, OpenCode, Claude Code, and KiloCode.

## Tools

| Tool | Use it for | Instead of |
|---|---|---|
| `context_run` | Running shell commands when full stdout is not needed | `bash`, terminal, `tail -10000 log.txt` |
| `context_logs` | Extracting relevant errors from tests, builds, lints, and logs | raw test/build output, full server logs |
| `context_read` | Reading one or more local UTF-8 text files safely | `cat huge.log`, `type huge.log`, repeated file reads |
| `context_search` | Searching local files with bounded ripgrep output or optional ast-grep structural search | raw `rg` / `grep` / `sg` commands |
| `context_discover` | Repo summaries, file lists, trees, and source outlines | broad globs, recursive trees, several setup reads |
| `context_fetch` | Fetching web pages as readable text | `webfetch`, raw HTML downloads |
| `context_diff` | Reviewing compact Git diffs, changed-file status, or commit history | raw `git diff` / `git status` / `git log` output |
| `context_usage` | Viewing savings stats, local usage reports, or guidance | manual accounting, guessing from project trees alone |

### `context_run`

Runs a shell command and returns stdout. Output is automatically truncated when it exceeds 60 lines or 32 KB. Override with `maxLines` or `maxBytes` per call.
Commands that exit successfully but write diagnostics to stderr will not include stderr in `context_run`; use `context_logs` when stderr or mixed command output matters.

```json
{ "command": "find . -name '*.ts'", "maxLines": 100, "maxBytes": 16384, "timeoutMs": 120000 }
```

Response `_meta` includes:

```json
{
  "totalLines": 1200,
  "totalBytes": 48000,
  "truncated": true,
  "durationMs": 230,
  "timeoutMs": 120000,
  "shell": "bash"
}
```

Command output collection is capped at 10 MB by default before formatting. Override with `SIMPLE_CONTEXT_LIMITER_MAX_COMMAND_BYTES` if needed. Command timeout defaults to 120 seconds and can be set per call with `timeoutMs` from 100ms to 30 minutes.

### `context_logs`

Runs a shell command and extracts relevant error or warning blocks with surrounding context. Use it for tests, builds, lints, compiler output, server logs, and CI-style output where the important lines may appear in the middle.

```json
{ "command": "npm test", "maxBlocks": 10, "contextLines": 5, "maxBytes": 16384, "timeoutMs": 600000 }
```

Unlike `context_run`, non-zero exits return a normal tool response with `exitCode`, `durationMs`, `blocksFound`, and savings metadata in `_meta`. If no error-like patterns are found, `context_logs` returns a compact tail fallback.

### `context_read`

Reads local UTF-8 text files and returns safe previews. Use `path` for one file or `paths` for up to 20 files; if both are provided, they are merged as `[path, ...paths]` with duplicates ignored. Output is automatically truncated when it exceeds 60 lines or 32 KB. Override with `maxLines` or `maxBytes` per call. In multi-file mode, `maxLines` and `maxBytes` act as per-file defaults unless `maxLinesPerFile` or `maxBytesPerFile` are set. `context_read` allows up to 500 lines for targeted single-file ranges while keeping the 32 KB response cap.

```json
{ "path": "logs/app.log", "maxLines": 100, "maxBytes": 16384 }
```

Read a specific 1-based line range after a search result:

```json
{ "path": "logs/app.log", "fromLine": 28470, "toLine": 28520, "maxLines": 100, "maxBytes": 16384 }
```

For larger targeted source sections, raise `maxLines` up to 500 while keeping `fromLine` and `toLine` narrow enough to stay useful:

```json
{ "path": "src/large-module.ts", "fromLine": 1200, "toLine": 1650, "maxLines": 500, "maxBytes": 32768 }
```

File reads are capped at 10 MB by default before formatting. Override with `SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES` if needed.
When `fromLine` or `toLine` is used, the file is streamed line-by-line and `maxLines` still caps the returned range. Use `path` to identify the ranged file; if `paths` is also provided, those files are included as additional non-ranged previews.

Read multiple known files in one bounded response:

```json
{ "paths": ["src/a.js", "src/b.js"], "maxLinesPerFile": 80, "maxBytesPerFile": 12000, "maxTotalBytes": 24000 }
```

The tool accepts at most 20 merged paths. Each file uses the same preview behavior as single-file reads, then the combined response is capped by `maxTotalBytes` and `maxTotalLines`.

### `context_search`

Searches local files with ripgrep by default and returns bounded `file:line:match` output. Pass `contextLines` when you need small surrounding context windows. Override with `maxMatches`, `maxLines`, or `maxBytes` per call.
Relative search paths are resolved from the MCP server's `process.cwd()`.

```json
{ "pattern": "ERROR", "path": "logs", "include": "*.log", "contextLines": 2, "maxMatches": 100, "maxBytes": 16384 }
```

simple-context-limiter does not download ripgrep. It uses the first available binary from:

- `SIMPLE_CONTEXT_LIMITER_RG_PATH`
- system `PATH`
- OpenCode cache: `~/.cache/opencode/bin/rg` or `rg.exe`
- Pi cache: `~/.pi/agent/bin/rg` or `rg.exe`

If none is found, `context_search` returns a clear error. The other tools do not need ripgrep.

Structural search is available when the ast-grep CLI is installed. It is optional and not bundled:

```json
{ "engine": "ast", "pattern": "assert.equal($A, $B)", "language": "javascript", "path": "smoke-test.js", "maxMatches": 20 }
```

Install ast-grep with one of:

```bash
npm install -g @ast-grep/cli
brew install ast-grep
cargo install ast-grep --locked
pip install ast-grep-cli
```

simple-context-limiter discovers `sg` or `ast-grep` on `PATH`, or use `SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH` to point at the binary. It intentionally does not run `npx`.

### `context_discover`

Use this before broad file reads or recursive shell commands. Pick a mode for the discovery shape you need:

- `summary` summarizes package metadata, scripts, configs, README preview, and tracked-file count.
- `files` lists tracked files with optional regex filtering.
- `tree` shows a bounded tree and skips heavy folders like `.git` and `node_modules`.
- `outline` extracts imports, exports, functions, classes, and top-level declarations from one source file.
- `context_search` searches with bounded context windows when `contextLines` is set.

```json
{ "mode": "summary", "maxLines": 80 }
```

```json
{ "mode": "files", "path": "src", "include": "\\.js$", "maxFiles": 500 }
```

```json
{ "mode": "tree", "path": ".", "maxDepth": 3, "maxEntries": 200 }
```

```json
{ "mode": "outline", "path": "src/tools/run.js", "maxSymbols": 200 }
```

Use `context_logs` for test/check commands when you want error blocks or a compact tail fallback instead of full output.

### Usage Reports

simple-context-limiter records local usage metadata by default in `~/.simple-context-limiter/usage.jsonl`, including the current project path (`process.cwd()`). It does not store tool outputs and does not upload anything. For shell commands, it stores a command class such as `git-history`, `dependencies`, or `infra-logs`, not the raw command string. The log is pruned after appends and capped by `SIMPLE_CONTEXT_LIMITER_USAGE_LOG_MAX_BYTES` (default 10 MB).

Use `context_usage` to see aggregate savings stats, local usage reports, or guidance from local usage patterns:

```json
{ "mode": "report", "maxEvents": 1000, "maxLines": 100 }
```

```json
{ "mode": "guidance", "maxEvents": 1000, "maxLines": 100 }
```

Opt out by setting `SIMPLE_CONTEXT_LIMITER_USAGE_LOG=0` or `SIMPLE_CONTEXT_LIMITER_DISABLE_USAGE_LOG=1` in the MCP server environment.

### `context_fetch`

Fetches an `http` or `https` URL, strips HTML to readable text, caches the result for 1 hour, and truncates large output. Override with `maxLines` or `maxBytes` per call.

```json
{ "url": "https://example.com/docs", "force": false, "maxLines": 100, "maxBytes": 16384 }
```

Downloads are capped at 10 MB by default before parsing/caching. Override with `SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES` if needed.
Non-HTTP schemes are blocked by default. Set `SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH=1` if you explicitly need schemes such as `data:` for local testing.
HTTP(S) fetches are not restricted to public internet hosts. `context_fetch` can access `localhost`, private network addresses, and other HTTP services reachable from the machine running the MCP server. Only enable simple-context-limiter for agents you trust with that local access.

### `context_diff`

Shows a compact Git diff preview, changed-file status, or commit history for the current project. Diff mode includes `git diff --stat` by default, then bounded diff hunks.

```json
{ "path": "src/tools.js", "maxFiles": 20, "maxHunks": 20, "maxBytes": 16384 }
```

Review staged changes instead:

```json
{ "staged": true, "maxFiles": 20, "maxHunks": 20 }
```

`context_diff` only reports tracked working-tree or staged changes covered by `git diff`. It does not include untracked files unless they have been staged. In `mode: "status"`, `staged: false` shows only unstaged tracked changes and `staged: true` shows only staged tracked changes.
Relative diff paths are resolved from the MCP server's `process.cwd()`.

Show compact changed-file status instead of diff hunks:

```json
{ "mode": "status", "maxBytes": 16384 }
```

Show compact commit history instead of raw `git log`:

```json
{ "mode": "history", "maxFiles": 20, "maxBytes": 16384 }
```

In `mode: "history"`, `maxFiles` acts as the maximum commit count and `path` filters history to a file or directory.

### `context_usage`

Shows aggregate savings statistics for the current project by default. Use `mode: "report"` for local usage telemetry and `mode: "guidance"` for concrete suggestions. The project key is the MCP server's `process.cwd()`.

```json
{}
```

## How It Works

When an LLM calls normal shell or web tools, the entire output can enter the model context: every log line, every HTML tag, every navigation bar. simple-context-limiter gives the model smaller MCP tools that return only useful previews by default.

Large output is returned as head + tail:

```text
╔══ 1200 lines · 46.9 KB · showing first 24 + last 36 ══╗
...
╟── … 1140 lines omitted … ──╢
...
╚══════════════════════════════════════════════════════════╝
```

The response always includes `_meta.truncated`. If it is `true`, the LLM can re-run with a higher `maxLines` or `maxBytes`, pre-filter the command, read a narrower `context_read` line range, or fall back to the native client tool when every line is genuinely needed.

Each tool response also reports compact savings stats in `_meta`: `returnedBytes`, `savedBytes`, `savedPercent`, and `estimatedTokensSaved`. Token savings are approximate and use `savedBytes / 4` as a dependency-free estimate.

`maxBytes` controls the formatted response preview size and accepts values from 1024 to 32768. It does not raise the separate file-read or download safety caps.

Aggregate stats are stored globally in `~/.simple-context-limiter/stats.json`. They contain only numeric counters grouped by project path and tool name, not commands, file paths, URLs, or content.

The server also injects MCP startup instructions telling the LLM to default to these tools for exploratory commands, logs, test/build output, file previews, searches, web pages, and git diff previews:

- `context_run` instead of shell/terminal commands that may produce large output
- `context_logs` instead of plain command output for tests, builds, lints, server logs, and other error-heavy output
- `context_read` instead of `cat`, `type`, or `Get-Content` for file previews
- `context_search` instead of raw `rg` or `grep` commands for bounded search results
- `context_discover` before broad file reads
- `context_fetch` instead of raw web fetches for pages that are not needed as raw HTML
- `context_diff` instead of raw `git diff` for compact working-tree or staged diff previews
- `context_usage` when you want to inspect accumulated current-project savings or usage reports

Native shell, read, fetch, or diff tools remain appropriate when complete output, exact stderr/exit behavior, interactivity, or unsupported behavior is specifically needed. If `_meta.truncated` is true, retry with a narrower query/range or higher `maxLines`/`maxBytes` before falling back to native tools.

## Errors

Tool calls use standard JSON-RPC error codes:

- `-32601` for unknown tools or methods
- `-32602` for invalid arguments, such as wrong types or out-of-range limits
- `-32000` for runtime failures, such as command exits, missing `rg`, HTTP errors, or network failures

When available, `error.data` includes diagnostic fields. Command failures can include `exitCode`, `signal`, `stdout`, and `stderr`. Fetch failures can include `httpStatus`, `httpStatusText`, `url`, and low-level `cause` details.

## Requirements

- Node.js >= 22
- No npm dependencies

## Installation

### OpenCode

Add this to your project `opencode.json` or global `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "simple-context-limiter": {
      "type": "local",
      "command": ["npx", "-y", "github:SkipXS/simple-context-limiter"],
      "env": {
        "SIMPLE_CONTEXT_LIMITER_SHELL": "bash"
      }
    }
  }
}
```

Restart OpenCode after saving the config.

`SIMPLE_CONTEXT_LIMITER_SHELL` is optional. Set it when you want `context_run` to use the same shell style as OpenCode, for example Git for Windows `bash`. Without it, Node uses the platform default shell (`cmd.exe` on Windows).

### Pi

Add this to `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "simple-context-limiter": {
      "command": "npx",
      "args": ["-y", "github:SkipXS/simple-context-limiter"],
      "env": {
        "SIMPLE_CONTEXT_LIMITER_SHELL": "bash"
      },
      "directTools": true,
      "lifecycle": "lazy"
    }
  }
}
```

Then `/reload` in Pi or restart Pi.

On Windows with Git for Windows, use the full path if `bash` is not on `PATH`:

```json
"env": {
  "SIMPLE_CONTEXT_LIMITER_SHELL": "C:/Program Files/Git/bin/bash.exe"
}
```

### Claude Code

```bash
claude mcp add simple-context-limiter -- npx -y github:SkipXS/simple-context-limiter
```

If you need a specific command shell for `context_run`, set `SIMPLE_CONTEXT_LIMITER_SHELL` in the environment that starts Claude Code.

### Local Checkout

```bash
git clone https://github.com/SkipXS/simple-context-limiter.git
cd simple-context-limiter
npm test
npm run check
```

Then point your MCP client at the local `server.js` with Node.

## Version Pinning

Use a tag once releases exist.

OpenCode command:

```json
["npx", "-y", "github:SkipXS/simple-context-limiter#v1.0.0"]
```

For Pi:

```json
"args": ["-y", "github:SkipXS/simple-context-limiter#v1.0.0"]
```

## Environment Variables

| Variable | Default | Purpose |
|---|---:|---|
| `SIMPLE_CONTEXT_LIMITER_SHELL` | Node platform default | Shell used by `context_run` |
| `SIMPLE_CONTEXT_LIMITER_RG_PATH` | auto-detect | Explicit path to `rg` / `rg.exe` for `context_search` |
| `SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH` | auto-detect | Explicit path to `sg` / `ast-grep` for `context_search` with `engine: "ast"` |
| `SIMPLE_CONTEXT_LIMITER_MAX_COMMAND_BYTES` | `10485760` | Max command output bytes collected before stopping the process |
| `SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES` | `10485760` | Max downloaded bytes before parsing/caching |
| `SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES` | `10485760` | Max file bytes read before previewing |
| `SIMPLE_CONTEXT_LIMITER_READ_RANGE_TIMEOUT_MS` | `120000` | Max time spent scanning for a requested line range |
| `SIMPLE_CONTEXT_LIMITER_CACHE_MAX_ENTRIES` | `200` | Max cached fetch entries kept on disk |
| `SIMPLE_CONTEXT_LIMITER_CACHE_MAX_BYTES` | `52428800` | Max cached fetch content bytes kept on disk |
| `SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH` | unset | Set to `1` to allow non-HTTP fetch schemes |
| `SIMPLE_CONTEXT_LIMITER_USAGE_LOG` | enabled | Set to `0` to disable local usage logging |
| `SIMPLE_CONTEXT_LIMITER_USAGE_LOG_MAX_BYTES` | `10485760` | Max usage log bytes kept on disk |
| `SIMPLE_CONTEXT_LIMITER_DISABLE_USAGE_LOG` | unset | Set to `1` to disable local usage logging |

## Security / Trust Model

simple-context-limiter intentionally gives trusted agents local capabilities: `context_run` executes shell commands, `context_read` and `context_search` can access local paths visible to the MCP server process, and `context_fetch` can reach HTTP services available from that machine. Only enable it for clients and agents you trust with that access. Output, downloads, and previews are size-limited to protect model context, not to sandbox the underlying operation.

## Cache

`context_fetch` caches fetched content for 1 hour in `~/.simple-context-limiter/cache.json` and prunes old entries on load/save. The cache is capped by entry count and total content bytes. Delete that file anytime to clear the cache.

`context_usage` with `mode: "report"` reads `~/.simple-context-limiter/usage.jsonl`. Delete that file anytime to clear collected usage metadata.

## Why So Minimal?

simple-context-limiter intentionally avoids heavy indexing, databases, embeddings, and large system prompts. It covers the most common context-wasting cases with small MCP tools and leaves full-output inspection to the native client tools when genuinely needed.

## License

MIT
