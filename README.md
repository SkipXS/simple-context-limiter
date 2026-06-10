# mini-sandbox

A minimal MCP server that keeps large command, file, search, and web output out of your LLM context. Four tools, zero dependencies, works in MCP-compatible clients such as Pi, OpenCode, Claude Code, and KiloCode.

## Tools

| Tool | Use it for | Instead of |
|---|---|---|
| `sandbox_run` | Running shell commands when full stdout is not needed | `bash`, terminal, `tail -10000 log.txt` |
| `sandbox_read` | Reading local UTF-8 text files safely | `cat huge.log`, `type huge.log`, `Get-Content huge.log` |
| `sandbox_search` | Searching local files with bounded ripgrep output | raw `rg` / `grep` commands |
| `sandbox_fetch` | Fetching web pages as readable text | `webfetch`, raw HTML downloads |

### `sandbox_run`

Runs a shell command and returns stdout. Output is automatically truncated when it exceeds 60 lines or 32 KB.

```json
{ "command": "find . -name '*.ts'", "maxLines": 100 }
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

### `sandbox_read`

Reads a local UTF-8 text file and returns a safe preview. Output is automatically truncated when it exceeds 60 lines or 32 KB.

```json
{ "path": "logs/app.log", "maxLines": 100 }
```

Read a specific 1-based line range after a search result:

```json
{ "path": "logs/app.log", "fromLine": 28470, "toLine": 28520, "maxLines": 100 }
```

File reads are capped at 10 MB by default before formatting. Override with `MINI_SANDBOX_MAX_READ_BYTES` if needed.
When `fromLine` or `toLine` is used, the file is streamed line-by-line and `maxLines` still caps the returned range.

### `sandbox_search`

Searches local files with ripgrep and returns bounded `file:line:match` output.

```json
{ "pattern": "ERROR", "path": "logs", "include": "*.log", "maxMatches": 100 }
```

mini-sandbox does not download ripgrep. It uses the first available binary from:

- `MINI_SANDBOX_RG_PATH`
- system `PATH`
- OpenCode cache: `~/.cache/opencode/bin/rg` or `rg.exe`
- Pi cache: `~/.pi/agent/bin/rg` or `rg.exe`

If none is found, `sandbox_search` returns a clear error. The other tools do not need ripgrep.

### `sandbox_fetch`

Fetches a URL, strips HTML to readable text, caches the result for 1 hour, and truncates large output.

```json
{ "url": "https://example.com/docs", "force": false, "maxLines": 100 }
```

Downloads are capped at 10 MB by default before parsing/caching. Override with `MINI_SANDBOX_MAX_FETCH_BYTES` if needed.

## How It Works

When an LLM calls normal shell or web tools, the entire output can enter the model context: every log line, every HTML tag, every navigation bar. mini-sandbox gives the model smaller MCP tools that return only useful previews by default.

Large output is returned as head + tail:

```text
╔══ 1200 lines · 46.9 KB · showing first 24 + last 36 ══╗
...
╟── … 1140 lines omitted … ──╢
...
╚══════════════════════════════════════════════════════════╝
```

The response always includes `_meta.truncated`. If it is `true`, the LLM can re-run with a higher `maxLines`, pre-filter the command, read a narrower `sandbox_read` line range, or fall back to the native client tool when every line is genuinely needed.

The server also injects MCP startup instructions telling the LLM to default to these tools for exploratory commands, file previews, searches, logs, test/build output, and web pages:

- `sandbox_run` instead of shell/terminal commands that may produce large output
- `sandbox_read` instead of `cat`, `type`, or `Get-Content` for file previews
- `sandbox_search` instead of raw `rg` or `grep` commands for bounded search results
- `sandbox_fetch` instead of raw web fetches for pages that are not needed as raw HTML

Native shell, read, or fetch tools remain appropriate when complete output, exact stderr/exit behavior, interactivity, or unsupported behavior is specifically needed. If `_meta.truncated` is true, retry with a narrower query/range or higher `maxLines` before falling back to native tools.

## Requirements

- Node.js >= 22
- No npm dependencies

## Installation

### OpenCode

Add this to your project `opencode.json` or global `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "mini-sandbox": {
      "type": "local",
      "command": ["npx", "-y", "github:SkipXS/mini-sandbox"],
      "env": {
        "MINI_SANDBOX_SHELL": "bash"
      }
    }
  }
}
```

Restart OpenCode after saving the config.

`MINI_SANDBOX_SHELL` is optional. Set it when you want `sandbox_run` to use the same shell style as OpenCode, for example Git for Windows `bash`. Without it, Node uses the platform default shell (`cmd.exe` on Windows).

### Pi

Add this to `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "mini-sandbox": {
      "command": "npx",
      "args": ["-y", "github:SkipXS/mini-sandbox"],
      "env": {
        "MINI_SANDBOX_SHELL": "bash"
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
  "MINI_SANDBOX_SHELL": "C:/Program Files/Git/bin/bash.exe"
}
```

### Claude Code

```bash
claude mcp add mini-sandbox -- npx -y github:SkipXS/mini-sandbox
```

If you need a specific command shell for `sandbox_run`, set `MINI_SANDBOX_SHELL` in the environment that starts Claude Code.

### Local Checkout

```bash
git clone https://github.com/SkipXS/mini-sandbox.git
cd mini-sandbox
npm test
```

Then point your MCP client at the local `server.js` with Node.

## Version Pinning

Use a tag once releases exist.

OpenCode command:

```json
["npx", "-y", "github:SkipXS/mini-sandbox#v1.0.0"]
```

For Pi:

```json
"args": ["-y", "github:SkipXS/mini-sandbox#v1.0.0"]
```

## Environment Variables

| Variable | Default | Purpose |
|---|---:|---|
| `MINI_SANDBOX_SHELL` | Node platform default | Shell used by `sandbox_run` |
| `MINI_SANDBOX_RG_PATH` | auto-detect | Explicit path to `rg` / `rg.exe` for `sandbox_search` |
| `MINI_SANDBOX_MAX_FETCH_BYTES` | `10485760` | Max downloaded bytes before parsing/caching |
| `MINI_SANDBOX_MAX_READ_BYTES` | `10485760` | Max file bytes read before previewing |

## Cache

`sandbox_fetch` caches fetched content for 1 hour in `~/.mini-sandbox/cache.json`. Delete that file anytime to clear the cache.

## Why So Minimal?

mini-sandbox intentionally avoids heavy indexing, databases, embeddings, and large system prompts. It covers the most common context-wasting cases with four small MCP tools and leaves full-output inspection to the native client tools when genuinely needed.

## License

MIT
