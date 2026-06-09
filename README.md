# mini-sandbox

A minimal MCP server that keeps large output out of your LLM context. Two tools, zero dependencies, works in any MCP-compatible client (Pi, OpenCode, Claude Code, KiloCode, etc.).

## What it does

When an LLM calls `bash` or `webfetch`, the **entire** output enters the context — every log line, every HTML tag, every navigation bar. That burns tokens fast.

mini-sandbox gives the LLM two alternatives that **keep raw data out**:

| Instead of | Use | What happens |
|---|---|---|
| `bash "tail -10000 log.txt"` | `sandbox_run "tail -10000 log.txt"` | Output capped at 60 lines (head+tail). The LLM sees it was truncated and can re-run with `maxLines: 200` or `grep` pre-filtering. |
| `webfetch "https://react.dev/..."` | `sandbox_fetch "https://react.dev/..."` | HTML stripped to readable text, then capped at 60 lines when large. Cached for 1 hour. No nav, no footer, no JavaScript. |

The LLM learns when to use which because `instructions` are injected into the system prompt at startup.

## Install

Requirements: **Node.js >= 22**.

### Quick Start: OpenCode

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

### From GitHub

Use directly from the GitHub repo with `npx`:

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

Pin a version by using a tag once releases exist:

```json
"command": ["npx", "-y", "github:SkipXS/mini-sandbox#v1.0.0"]
```

### Local Checkout

```bash
cd mini-sandbox
# nothing to install — just point Pi/OpenCode at server.js
npm test # optional smoke test
```

## Configure

### Pi

`.pi/config.json` or your Pi config file:

```json
{
  "mcp_servers": {
    "mini-sandbox": {
      "type": "stdio",
      "command": ["npx", "-y", "github:SkipXS/mini-sandbox"]
    }
  }
}
```

Then `/reload` in Pi.

Pin a version by using a release tag:

```json
"command": ["npx", "-y", "github:SkipXS/mini-sandbox#v1.0.0"]
```

### OpenCode

`opencode.json` (project or global `~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "mini-sandbox": {
      "type": "local",
      "command": ["npx", "-y", "github:SkipXS/mini-sandbox"]
    }
  }
}
```

Restart OpenCode.

### Claude Code

```bash
claude mcp add mini-sandbox -- npx -y github:SkipXS/mini-sandbox
```

## Tools

### `sandbox_run`

Run a shell command. Output is auto-truncated when it exceeds 60 lines or 32 KB.

```
sandbox_run { command: "find . -name '*.ts'", maxLines?: 10..200 }
```

The response includes `_meta.truncated` — when `true`, the LLM knows to drill deeper:

```
sandbox_run "rg ERROR huge.log"           # pre-filter
sandbox_run "tail -200 huge.log"          # narrower window
sandbox_run "cat huge.log" maxLines: 200  # higher limit
```

Or fall back to `bash` when every line is genuinely needed.

### `sandbox_fetch`

Fetch a URL, strip HTML to readable text, cap large output, cache for 1 hour.
Downloads are capped at 10 MB by default before parsing/caching. Override with `MINI_SANDBOX_MAX_FETCH_BYTES` if needed.

```
sandbox_fetch { url: "https://example.com/docs", force?: false, maxLines?: 10..200 }
```

## Why so minimal?

**Context-mode** (the full solution this was inspired by) packs 11 MCP tools, SQLite FTS5, BM25 ranking, Porter stemming, Levenshtein typos, 26 event-type hooks, session continuity, and 4,500 system-prompt tokens of overhead. It saves ~66% context but costs ~50% more system-prompt tokens.

**mini-sandbox** covers ~75% of the savings with 2 tools, 0 dependencies, and 3 lines of routing instructions. The remaining 25% gap is closed by teaching the LLM one pattern:

> Use `grep`/`rg`/`head`/`tail`/`jq` **inside** `sandbox_run` before you ever read a file into context.

## Cache

`~/.mini-sandbox/cache.json` — a flat JSON file mapping URL hashes to `{ timestamp, content }`. Delete it anytime to clear cache. Autocreated on first `sandbox_fetch`.

## License

MIT
