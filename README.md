# simple-context-limiter

A minimal MCP server that keeps large command, log, file, search, web, and git diff output out of your LLM context. Seven tools, zero dependencies, works in MCP-compatible clients such as Pi, OpenCode, Claude Code, and KiloCode.

## Tools

| Tool | Use it for | Instead of |
|---|---|---|
| `context_run` | Running shell commands when full stdout is not needed | `bash`, terminal, `tail -10000 log.txt` |
| `context_logs` | Extracting relevant errors from tests, builds, lints, and logs | raw test/build output, full server logs |
| `context_read` | Reading local UTF-8 text files safely | `cat huge.log`, `type huge.log`, `Get-Content huge.log` |
| `context_search` | Searching local files with bounded ripgrep output | raw `rg` / `grep` commands |
| `context_fetch` | Fetching web pages as readable text | `webfetch`, raw HTML downloads |
| `context_diff` | Reviewing compact Git diffs | raw `git diff` output |
| `context_stats` | Viewing current-project aggregate savings stats | manual accounting |

### `context_run`

Runs a shell command and returns stdout. Output is automatically truncated when it exceeds 60 lines or 32 KB. Override with `maxLines` or `maxBytes` per call.

```json
{ "command": "find . -name '*.ts'", "maxLines": 100, "maxBytes": 16384 }
```

Response `_meta` includes:

```json
{
  "totalLines": 1200,
  "totalBytes": 48000,
  "truncated": true,
  "durationMs": 230,
  "shell": "bash"
}
```

### `context_logs`

Runs a shell command and extracts relevant error or warning blocks with surrounding context. Use it for tests, builds, lints, compiler output, server logs, and CI-style output where the important lines may appear in the middle.

```json
{ "command": "npm test", "maxBlocks": 10, "contextLines": 5, "maxBytes": 16384 }
```

Unlike `context_run`, non-zero exits return a normal tool response with `exitCode`, `durationMs`, `blocksFound`, and savings metadata in `_meta`. If no error-like patterns are found, `context_logs` returns a compact tail fallback.

### `context_read`

Reads a local UTF-8 text file and returns a safe preview. Output is automatically truncated when it exceeds 60 lines or 32 KB. Override with `maxLines` or `maxBytes` per call.

```json
{ "path": "logs/app.log", "maxLines": 100, "maxBytes": 16384 }
```

Read a specific 1-based line range after a search result:

```json
{ "path": "logs/app.log", "fromLine": 28470, "toLine": 28520, "maxLines": 100, "maxBytes": 16384 }
```

File reads are capped at 10 MB by default before formatting. Override with `SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES` if needed.
When `fromLine` or `toLine` is used, the file is streamed line-by-line and `maxLines` still caps the returned range.

### `context_search`

Searches local files with ripgrep and returns bounded `file:line:match` output. Override with `maxMatches`, `maxLines`, or `maxBytes` per call.

```json
{ "pattern": "ERROR", "path": "logs", "include": "*.log", "maxMatches": 100, "maxBytes": 16384 }
```

simple-context-limiter does not download ripgrep. It uses the first available binary from:

- `SIMPLE_CONTEXT_LIMITER_RG_PATH`
- system `PATH`
- OpenCode cache: `~/.cache/opencode/bin/rg` or `rg.exe`
- Pi cache: `~/.pi/agent/bin/rg` or `rg.exe`

If none is found, `context_search` returns a clear error. The other tools do not need ripgrep.

### `context_fetch`

Fetches an `http` or `https` URL, strips HTML to readable text, caches the result for 1 hour, and truncates large output. Override with `maxLines` or `maxBytes` per call.

```json
{ "url": "https://example.com/docs", "force": false, "maxLines": 100, "maxBytes": 16384 }
```

Downloads are capped at 10 MB by default before parsing/caching. Override with `SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES` if needed.
Non-HTTP schemes are blocked by default. Set `SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH=1` if you explicitly need schemes such as `data:` for local testing.
HTTP(S) fetches are not restricted to public internet hosts. `context_fetch` can access `localhost`, private network addresses, and other HTTP services reachable from the machine running the MCP server. Only enable simple-context-limiter for agents you trust with that local access.

### `context_diff`

Shows a compact Git diff preview for the current project. It includes `git diff --stat` by default, then bounded diff hunks.

```json
{ "path": "src/tools.js", "maxFiles": 20, "maxHunks": 20, "maxBytes": 16384 }
```

Review staged changes instead:

```json
{ "staged": true, "maxFiles": 20, "maxHunks": 20 }
```

`context_diff` only reports tracked working-tree or staged changes covered by `git diff`. It does not include untracked files unless they have been staged.

### `context_stats`

Shows aggregate savings statistics for the current project, grouped by tool. The project key is the MCP server's `process.cwd()`.

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
- `context_fetch` instead of raw web fetches for pages that are not needed as raw HTML
- `context_diff` instead of raw `git diff` for compact working-tree or staged diff previews
- `context_stats` when you want to inspect accumulated current-project savings

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
| `SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES` | `10485760` | Max downloaded bytes before parsing/caching |
| `SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES` | `10485760` | Max file bytes read before previewing |
| `SIMPLE_CONTEXT_LIMITER_CACHE_MAX_ENTRIES` | `200` | Max cached fetch entries kept on disk |
| `SIMPLE_CONTEXT_LIMITER_CACHE_MAX_BYTES` | `52428800` | Max cached fetch content bytes kept on disk |
| `SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH` | unset | Set to `1` to allow non-HTTP fetch schemes |

## Cache

`context_fetch` caches fetched content for 1 hour in `~/.simple-context-limiter/cache.json` and prunes old entries on load/save. The cache is capped by entry count and total content bytes. Delete that file anytime to clear the cache.

## Why So Minimal?

simple-context-limiter intentionally avoids heavy indexing, databases, embeddings, and large system prompts. It covers the most common context-wasting cases with small MCP tools and leaves full-output inspection to the native client tools when genuinely needed.

## License

MIT
