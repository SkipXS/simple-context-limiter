# simple-context-limiter

A minimal MCP server that keeps large command, log, file, search, repo-discovery, web, and git diff output out of your LLM context. Eight tools, zero dependencies, works in MCP-compatible clients such as Pi, OpenCode, Claude Code, and KiloCode.

## Tools

| Tool | Use it for | Instead of |
|---|---|---|
| `sc-run` | Running shell commands when full stdout is not needed | `bash`, terminal, `tail -10000 log.txt` |
| `sc-logs` | Extracting relevant errors from tests, builds, lints, and logs | raw test/build output, full server logs |
| `sc-read` | Reading one or more local UTF-8 text files safely | `cat huge.log`, `type huge.log`, repeated file reads |
| `sc-search` | Searching local files with bounded ripgrep output or optional ast-grep structural search | raw `rg` / `grep` / `sg` commands |
| `sc-discover` | Repo summaries, file lists, trees, and source outlines | broad globs, recursive trees, several setup reads |
| `sc-fetch` | Fetching web pages as readable text | `webfetch`, raw HTML downloads |
| `sc-diff` | Reviewing compact Git diffs, changed-file status, or commit history | raw `git diff` / `git status` / `git log` output |
| `sc-usage` | Viewing savings stats, local usage reports, or guidance | manual accounting, guessing from project trees alone |

Tool names exposed by `tools/list` are prefixed with `sc-` to avoid collisions with built-in client tools such as `read` or `search`. Use the prefixed names for all calls; unprefixed legacy names are not exposed or accepted.

## Agent Recipes

- Unknown repo: `sc-discover {"mode":"summary"}` → `sc-discover {"mode":"tree"}` → targeted `sc-search`/`sc-read`.
- Failing tests/builds: `sc-logs` on the test command → `sc-read` with `fromLine`/`toLine` for implicated files.
- Reviewing changes: `sc-diff` first → `sc-read` only touched or referenced files.
- Huge file/log: `sc-search` for anchors first → narrow `sc-read` ranges instead of broad reads.
- Truncated output: inspect `_meta.truncation.retryHint`; narrow path/query/range before raising limits.

## Security Model

simple-context-limiter is intended for trusted local MCP clients. `sc-run`/`sc-logs` execute shell commands on the machine running the server, `sc-read`/`sc-search` can access local paths visible to that process, and `sc-fetch` can access any HTTP(S) service reachable from that machine, including localhost and private networks. This is by design: the server limits output volume, not the authority of the client. Do not expose it to untrusted agents, prompts, or remote users unless you run it in a sandbox or add your own policy controls.

### `sc-run`

Runs a shell command and returns stdout. Output is automatically truncated when it exceeds 60 content lines or 32 KB. Override with `maxLines` up to 500 or `maxBytes` per call.
Commands that exit successfully but write diagnostics to stderr will not include stderr in `sc-run`; use `sc-logs` when stderr or mixed command output matters. In that case the response appends `[stderr omitted: ...]`, and `_meta.stderrOmitted: true` plus `_meta.stderrBytes` report that stderr existed without leaking its text.

```json
{ "command": "find . -name '*.ts'", "maxLines": 100, "maxBytes": 16384, "timeoutMs": 120000 }
```

Response `_meta` includes:

```json
{
  "truncated": true,
  "durationMs": 230,
  "timeoutMs": 120000,
  "shell": "bash",
  "response": {
    "totalLines": 1200,
    "totalBytes": 48000,
    "returnedBytes": 16384,
    "savedBytes": 31616,
    "savedPercent": 66,
    "estimatedTokensSaved": 7904,
    "truncated": true
  }
}
```

Command output collection is capped at 10 MB by default before formatting. If a command crosses that cap and still exits cleanly, `sc-run` can return the bounded stdout preview; if the cap stops the process or the process exits non-zero, the call is reported as an error with exit/signal metadata. Override with `SIMPLE_CONTEXT_LIMITER_MAX_COMMAND_BYTES` if needed. Command timeout defaults to 120 seconds and can be set per call with `timeoutMs` from 100ms to 30 minutes.

### `sc-logs`

Runs a shell command and extracts relevant error or warning blocks with surrounding context. Use it for tests, builds, lints, compiler output, server logs, and CI-style output where the important lines may appear in the middle. Matching blocks are sorted by severity, then source line; plain-output fallback remains chronological.

```json
{ "command": "npm test", "maxBlocks": 10, "contextLines": 5, "maxLines": 300, "maxBytes": 16384, "timeoutMs": 600000 }
```

Unlike `sc-run`, non-zero exits return a normal tool response with `exitCode`, `durationMs`, `blocksFound`, and savings metadata in `_meta`. If no error-like patterns are found, `sc-logs` returns a compact tail fallback. `sc-logs.maxLines` accepts up to 500 lines because CI/test diagnostics often need more room; `maxBytes` still caps the formatted response at 32 KB.

### `sc-read`

Reads local UTF-8 text files and returns safe previews. Provide `path` for one primary file or `paths` for a standalone list of up to 20 files; if both are provided, they are merged as `[path, ...paths]` with duplicates ignored. Output is automatically truncated when it exceeds 60 content lines or 32 KB. Override with `maxLines` up to 500 or `maxBytes` per call. In multi-file mode, `maxLines` and `maxBytes` act as per-file defaults unless `maxLinesPerFile` or `maxBytesPerFile` are set. `sc-read` allows up to 500 lines for targeted single-file ranges while keeping the 32 KB response cap.

```json
{ "path": "logs/app.log", "maxLines": 100, "maxBytes": 16384 }
```

Read a specific 1-based line range after a search result; add `lineNumbers` when citations or review comments need stable line references:

```json
{ "path": "logs/app.log", "fromLine": 28470, "toLine": 28520, "lineNumbers": true, "maxLines": 100, "maxBytes": 16384 }
```

Ranged reads include a compact `--- path:start-end ---` header for traceability. `lineNumbers` is intentionally limited to ranged reads so truncated head/tail previews never show misleading source line numbers.

For larger targeted source sections, raise `maxLines` up to 500 while keeping `fromLine` and `toLine` narrow enough to stay useful:

```json
{ "path": "src/large-module.ts", "fromLine": 1200, "toLine": 1650, "maxLines": 500, "maxBytes": 32768 }
```

File reads are capped at 10 MB by default before formatting. Override with `SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES` if needed.
When `fromLine` or `toLine` is used, the file is streamed line-by-line and `maxLines` still caps the returned range. Range scans also stop after the read cap; if the requested line is deeper than that, `_meta.scanLimited` is `true` and the response is marked truncated. `_meta` includes `returnedLines`, `scannedLines`, `scannedBytes`, `rangeLimited`, `scanLimited`, and `scanTimedOut` so callers can retry with a narrower range, search first, or raise `SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES` for trusted large files.
Use `path` to identify the ranged file; if `paths` is also provided, those files are included as additional non-ranged previews and per-file range metadata appears in `_meta.files`.

Read multiple known files in one bounded response:

```json
{ "paths": ["src/a.js", "src/b.js"], "maxLinesPerFile": 80, "maxBytesPerFile": 12000, "maxTotalBytes": 24000 }
```

The tool accepts at most 20 merged paths. Each file uses the same preview behavior as single-file reads, then the combined response is capped by `maxTotalBytes` and `maxTotalLines`. If a multi-file response is globally truncated, visible file content stays under an explicit `--- file ---` header to avoid misattribution.

### `sc-search`

Searches local files with ripgrep by default and returns bounded `file:line:match` output. Pass `contextLines` when you need small surrounding context windows. Override with `maxMatches`, `maxLines`, or `maxBytes` per call. `include` is a ripgrep glob, not a regex. When matches are limited, the final line says how many were shown and that more matches exist.
Relative search paths are resolved from the MCP server's `process.cwd()`.

```json
{ "pattern": "ERROR", "path": "logs", "include": "*.log", "contextLines": 2, "maxMatches": 100, "maxBytes": 16384 }
```

simple-context-limiter does not download ripgrep. It uses the first available binary from:

- `SIMPLE_CONTEXT_LIMITER_RG_PATH`
- system `PATH`
- OpenCode cache: `~/.cache/opencode/bin/rg` or `rg.exe`
- Pi cache: `~/.pi/agent/bin/rg` or `rg.exe`

If none is found, `sc-search` returns a clear error. The other tools do not need ripgrep.

Structural search is available when the ast-grep CLI is installed. It is optional and not bundled. `language` can be omitted when it can be inferred from `path` or `include`:

```json
{ "engine": "ast", "pattern": "assert.equal($A, $B)", "path": "smoke-test.js", "maxMatches": 20 }
```

For AST searches, `contextLines` includes bounded source context under each compact `file:line:column` match.

Install ast-grep with one of:

```bash
npm install -g @ast-grep/cli
brew install ast-grep
cargo install ast-grep --locked
pip install ast-grep-cli
```

simple-context-limiter discovers `sg` or `ast-grep` on `PATH`, or use `SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH` to point at the binary. It intentionally does not run `npx`.

### `sc-discover`

Use this before broad file reads or recursive shell commands. Pick a mode for the discovery shape you need:

- `summary` summarizes package metadata, scripts, configs, a compact README preview, and tracked-file count.
- `files` lists tracked files with optional regex filtering.
- `tree` shows a bounded tree and skips heavy/noisy folders like `.git`, `node_modules`, `.pi`, and `.opencode`.
- `outline` extracts imports, exports, functions, classes, and top-level declarations from one source file.

Use the separate `sc-search` tool for bounded text or AST search with optional context windows.

```json
{ "mode": "summary", "maxLines": 80 }
```

```json
{ "mode": "files", "path": "src", "include": "\\.js$", "maxFiles": 500 }
```

```json
{ "mode": "tree", "path": ".", "maxDepth": 3, "maxEntries": 200 }
```

`tree` always skips high-noise directories such as `.git`, `node_modules`, `.pi`, and `.opencode`, and also honors Git ignore rules best-effort via `git check-ignore` when the target is inside the current Git work tree. When `tree` hits `maxEntries`, it reports omitted entries as a lower bound in `_meta.entriesOmittedLowerBound`. The shown entries are bounded and sorted for readability, not a complete alphabetic prefix of very large directories.

```json
{ "mode": "outline", "path": "src/tools/run.js", "maxSymbols": 200 }
```

Use `sc-logs` for test/check commands when you want error blocks or a compact tail fallback instead of full output.

### Usage Reports

simple-context-limiter records local usage metadata by default in `~/.simple-context-limiter/usage.jsonl`, including the current project key. It does not store tool outputs and does not upload anything. For shell commands, it stores a command class such as `git-history`, `dependencies`, or `infra-logs`, not the raw command string. The log is pruned after appends and capped by `SIMPLE_CONTEXT_LIMITER_USAGE_LOG_MAX_BYTES` (default 10 MB).
Stats and usage are attributed to the nearest project marker such as `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`. Markerless working directories under the system temp folder are ignored instead of being recorded as separate projects.

Use `sc-usage` to see aggregate savings stats, local usage reports, or guidance from local usage patterns:

```json
{ "mode": "report", "maxEvents": 1000, "maxLines": 100 }
```

```json
{ "mode": "guidance", "maxEvents": 1000, "maxLines": 100 }
```

Opt out by setting `SIMPLE_CONTEXT_LIMITER_USAGE_LOG=0` or `SIMPLE_CONTEXT_LIMITER_DISABLE_USAGE_LOG=1` in the MCP server environment.

### `sc-fetch`

Fetches an `http` or `https` URL, strips HTML to readable text, optionally caches the result for 1 hour, and truncates large output. HTML extraction is lightweight text stripping, not browser/JavaScript rendering. Override with `maxLines` up to 500 or `maxBytes` per call.

```json
{ "url": "https://example.com/docs", "force": false, "cache": true, "maxLines": 100, "maxBytes": 16384 }
```

Downloads are capped at 10 MB by default before parsing/caching. Override with `SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES` if needed. The visible response starts with a compact `Source: ...` line; `_meta` also includes low-token traceability fields such as `url`, `finalUrl`, `status`, `contentType`, `charset`, `cached`, `cacheEligible`, `cacheSkippedReason`, `htmlStripped`, and `durationMs`.
Non-HTTP schemes are blocked by default. Set `SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH=1` if you explicitly need schemes such as `data:` for local testing.
HTTP(S) fetches are not restricted to public internet hosts. `sc-fetch` can access `localhost`, private network addresses, and other HTTP services reachable from the machine running the MCP server. Literal localhost, loopback, unspecified (`0.0.0.0/8`), link-local, RFC1918/private, and metadata IP hosts are not read from or written to the persistent fetch cache by default; pass `cache: true` for a specific trusted call or set `SIMPLE_CONTEXT_LIMITER_FETCH_CACHE=all` to opt in globally. Pass `cache: false` or set `SIMPLE_CONTEXT_LIMITER_FETCH_CACHE=0` to disable persistent fetch cache use. `force: true` only skips cache reads and refreshes the response; it may still write an eligible refreshed response. Only textual content types are returned; binary/non-text responses are rejected. Text is decoded with the response `charset` when Node's WHATWG `TextDecoder` supports it; responses declaring an unsupported charset return an error rather than guessing.

### `sc-diff`

Shows a compact Git diff preview, changed-file status, or commit history for the current project. Diff mode includes `git diff --stat` by default, then bounded diff hunks.

```json
{ "path": "src/tools.js", "maxFiles": 20, "maxHunks": 20, "maxBytes": 16384 }
```

Review staged changes instead:

```json
{ "staged": true, "maxFiles": 20, "maxHunks": 20 }
```

`sc-diff` only reports tracked working-tree or staged changes covered by `git diff`. It does not include untracked files unless they have been staged. In `mode: "status"`, `staged: false` shows only unstaged tracked changes and `staged: true` shows only staged tracked changes.
Relative diff paths are resolved from the MCP server's `process.cwd()`.

Show compact changed-file status instead of diff hunks:

```json
{ "mode": "status", "maxBytes": 16384 }
```

Show compact commit history instead of raw `git log`:

```json
{ "mode": "history", "maxCommits": 20, "maxBytes": 16384 }
```

In `mode: "history"`, `maxCommits` controls the commit count and `path` filters history to a file or directory. `maxFiles` is still accepted as a legacy alias for the commit count.

### `sc-usage`

Shows aggregate savings statistics for the current project by default. Use `mode: "report"` for local usage telemetry and `mode: "guidance"` for concrete suggestions. The project key is the MCP server's `process.cwd()`.

```json
{}
```

## How It Works

When an LLM calls normal shell or web tools, the entire output can enter the model context: every log line, every HTML tag, every navigation bar. simple-context-limiter gives the model smaller MCP tools that return only useful previews by default.

Large output is returned as head + tail with compact ASCII truncation markers:

```text
[truncated: 1200 lines, 46.9 KB; showing first 24 + last 36]
...
[omitted: 1140 lines]
...
```

The response always includes `_meta.truncated`; treat it as the authoritative truncation signal. If it is `true`, `_meta.truncation` gives a compact `{ "reason", "retryHint" }` such as `format_lines`, `download_limit`, `max_files`, or `depth_limit`. Truncated responses also try to append a visible one-line retry notice when the formatter already showed a truncation marker, or a compact truncation notice otherwise, so clients that hide `_meta` still give the LLM a useful next step. The LLM can re-run with a higher `maxLines` or `maxBytes`, pre-filter the command, read a narrower `sc-read` line range, or fall back to the native client tool when every line is genuinely needed.

Each tool response reports compact savings stats in `_meta.response`: `totalBytes`, `returnedBytes`, `savedBytes`, `savedPercent`, and `estimatedTokensSaved`. `_meta.response.truncated` is kept as a compatibility mirror of `_meta.truncated`, not a separate retry signal. Byte counters are not duplicated at the top level of `_meta`; top-level fields are reserved for tool-specific facts such as `durationMs`, `emptyReason`, `exitCode`, `stderrOmitted`, `stderrBytes`, `shownMatches`, or `filesChanged`. Empty/no-result responses set `_meta.empty: true` plus a compact reason such as `no_matches`, `no_output`, or `no_diff`. Token savings are approximate and use `savedBytes / 4` as a dependency-free estimate. In `sc-usage` `mode: "stats"`, top-level totals describe aggregate usage stats while formatted response savings remain in `_meta.response`.

`maxLines` accepts values from 10 to 500 across tools and caps selected content lines; compact truncation/retry marker lines may add a few display lines. `maxBytes` defaults to 32768 and controls the formatted response preview size; it accepts values from 1024 to 65536 by default. It does not raise the separate file-read or download safety caps.

Aggregate stats are stored globally in `~/.simple-context-limiter/stats.json`. They contain only numeric counters grouped by project path and tool name, not commands, file paths, URLs, or content.

The published `tools/list` schemas preserve strict `additionalProperties: false` validation and describe high-risk semantics: `sc-run`/`sc-logs` execute local shell commands, `sc-search` uses regex patterns for text and ast-grep patterns for AST mode, `sc-search.include` is a glob while `sc-discover.include` is a regex, `sc-fetch` is HTTP(S) by default but can reach localhost/private networks, and `sc-diff` status excludes untracked files unless staged.

The server also injects short MCP startup instructions that tell the LLM to prefer these bounded tools for shell output, logs, file previews, local search, repo discovery, readable web pages, git previews, and usage guidance. Native shell, read, fetch, or diff tools remain appropriate when complete output, exact stderr/exit behavior, interactivity, raw HTML, or unsupported behavior is specifically needed. If `_meta.truncated` is true, use `_meta.truncation.reason/retryHint` and retry with a narrower query/range/path or higher `maxLines`/`maxBytes` before falling back to native tools.

## Errors

Protocol and validation failures use standard JSON-RPC errors:

- `-32601` for unknown methods or unknown tools
- `-32602` for invalid JSON-RPC or tool-call parameters, such as wrong types or out-of-range limits
- `-32002` when a request is made before `initialize` plus `notifications/initialized`

Runtime failures inside a valid `tools/call` usually return a normal JSON-RPC response whose `result.isError` is `true`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "Command failed: npm test (exited with code 1)\n\ndetails:\nexitCode: 1\n\nstderr:\nAssertionError: expected true" }],
    "isError": true,
    "_meta": {
      "exitCode": 1,
      "stderr": "AssertionError: expected true",
      "truncated": false,
      "response": { "totalLines": 7, "totalBytes": 128, "returnedBytes": 128, "savedBytes": 0, "truncated": false }
    }
  }
}
```

When available, JSON-RPC `error.data` or tool-result `_meta` includes diagnostic fields. Command failures can include `exitCode`, `signal`, `stdout`, and `stderr`. Fetch failures can include `httpStatus`, `httpStatusText`, `url`, and low-level `cause` details.

## Requirements

- Node.js >= 22
- No npm package dependencies
- Optional external tools: `rg` / ripgrep is needed for text `sc-search`; `sg` / ast-grep is needed only for `sc-search` with `engine: "ast"`

## Installation

### OpenCode

Add this to your project `opencode.json` or global `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "simple-context-limiter": {
      "type": "local",
      "command": ["npx", "-y", "simple-context-limiter@1.1.0"],
      "env": {
        "SIMPLE_CONTEXT_LIMITER_SHELL": "bash"
      }
    }
  }
}
```

Restart OpenCode after saving the config.

`SIMPLE_CONTEXT_LIMITER_SHELL` is optional. Set it when you want `sc-run` to use the same shell style as OpenCode, for example Git for Windows `bash`. Without it, Node uses the platform default shell (`cmd.exe` on Windows).

### Pi

Add this to `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "simple-context-limiter": {
      "command": "npx",
      "args": ["-y", "simple-context-limiter@1.1.0"],
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

If you prefer to avoid `npx` wrapper layers entirely, you can instead use direct invocation from a local checkout:

```json
{
  "mcpServers": {
    "simple-context-limiter": {
      "command": "node",
      "args": ["C:/path/to/simple-context-limiter/server.js"],
      "env": {
        "SIMPLE_CONTEXT_LIMITER_SHELL": "bash"
      },
      "directTools": true,
      "lifecycle": "lazy"
    }
  }
}
```

On Windows with Git for Windows, use the full path if `bash` is not on `PATH`:

```json
"env": {
  "SIMPLE_CONTEXT_LIMITER_SHELL": "C:/Program Files/Git/bin/bash.exe"
}
```

### Claude Code

```bash
claude mcp add simple-context-limiter -- npx -y simple-context-limiter@1.1.0
```

If you need a specific command shell for `sc-run`, set `SIMPLE_CONTEXT_LIMITER_SHELL` in the environment that starts Claude Code.

### Local Checkout

```bash
git clone https://github.com/SkipXS/simple-context-limiter.git
cd simple-context-limiter
npm ci
npm run check
npm test
npm run audit
```

`npm run check` runs syntax, unit, and output-quality checks; `npm test` runs unit and smoke tests. Then point your MCP client at the local `server.js` with Node.

## Version Pinning

The examples above use a pinned npm package version for fast, reproducible startup. To pick up repository updates without maintaining a local checkout, use an explicit GitHub ref such as `github:SkipXS/simple-context-limiter#main`; for reproducible team setups on GitHub, prefer an immutable tag such as `github:SkipXS/simple-context-limiter#v1.1.0`.

OpenCode command using GitHub main:

```json
["npx", "-y", "github:SkipXS/simple-context-limiter#main"]
```

For Pi using GitHub main:

```json
"args": ["-y", "github:SkipXS/simple-context-limiter#main"]
```

GitHub `npx` installs from source and may still do more setup than the npm package path; the package `prepack` hook is intentionally lightweight, while full validation lives in `npm run check` and `prepublishOnly`. Avoid omitting the ref entirely (`github:SkipXS/simple-context-limiter`) in long-running or concurrent MCP setups: it follows npm/GitHub defaults implicitly and is less explicit than choosing either `#main` for auto-updates or a version tag for reproducibility. On Windows, GitHub `npx` still adds wrapper layers, so keep `lifecycle: "lazy"` and rely on the server's explicit MCP shutdown handling.

## Environment Variables

| Variable | Default | Purpose |
|---|---:|---|
| `SIMPLE_CONTEXT_LIMITER_SHELL` | Node platform default | Shell used by `sc-run` |
| `SIMPLE_CONTEXT_LIMITER_RG_PATH` | auto-detect | Explicit path to `rg` / `rg.exe` for `sc-search` |
| `SIMPLE_CONTEXT_LIMITER_AST_GREP_PATH` | auto-detect | Explicit path to `sg` / `ast-grep` for `sc-search` with `engine: "ast"` |
| `SIMPLE_CONTEXT_LIMITER_MAX_RESPONSE_BYTES` | `65536` | Max formatted response bytes accepted via `maxBytes`; per-call default stays `32768` |
| `SIMPLE_CONTEXT_LIMITER_MAX_COMMAND_BYTES` | `10485760` | Max command output bytes collected before stopping the process |
| `SIMPLE_CONTEXT_LIMITER_MAX_FETCH_BYTES` | `10485760` | Max downloaded bytes before parsing/caching |
| `SIMPLE_CONTEXT_LIMITER_FETCH_CACHE` | public-text only | Set to `0`/`false`/`off` to disable default fetch cache use; set to `all`/`private` to also cache private/loopback/link-local hosts by default, including DNS names that resolve to private addresses. Per-call `cache` overrides this. |
| `SIMPLE_CONTEXT_LIMITER_DISABLE_COMMAND_TOOLS` | unset | Set to `1` to disable command-executing tools (`sc-run` and `sc-logs`). `SIMPLE_CONTEXT_LIMITER_DISABLE_RUN=1` is also accepted as an alias. |
| `SIMPLE_CONTEXT_LIMITER_COMMAND_ALLOWLIST` | unset | Comma/semicolon/newline-delimited exact shell command allowlist for `sc-run`/`sc-logs`, e.g. `npm test,npm run check`. This is string matching before shell execution, not a sandbox. |
| `SIMPLE_CONTEXT_LIMITER_FETCH_PUBLIC_ONLY` | unset | Set to `1` to block `sc-fetch` requests to localhost/private/special-use/unresolved hosts, including redirects checked hop-by-hop. |
| `SIMPLE_CONTEXT_LIMITER_PATH_ROOTS` | unset | Comma/semicolon/newline-delimited filesystem roots allowed for local path tools (`sc-read`, `sc-search`, `sc-discover`, `sc-diff` path arguments). |
| `SIMPLE_CONTEXT_LIMITER_MAX_READ_BYTES` | `10485760` | Max file bytes read before previewing |
| `SIMPLE_CONTEXT_LIMITER_MAX_RPC_LINE_BYTES` | `1048576` | Max JSON-RPC input line bytes accepted before rejecting the request |
| `SIMPLE_CONTEXT_LIMITER_MAX_RPC_BATCH_SIZE` | `50` | Max JSON-RPC requests accepted in one batch |
| `SIMPLE_CONTEXT_LIMITER_MAX_RPC_BATCH_CONCURRENCY` | `4` | Max JSON-RPC batch items processed concurrently |
| `SIMPLE_CONTEXT_LIMITER_MAX_RPC_TOOL_CONCURRENCY` | same as batch concurrency | Max `tools/call` executions active globally across all requests and batches |
| `SIMPLE_CONTEXT_LIMITER_MAX_RPC_TOOL_QUEUE` | `100` | Max queued `tools/call` requests waiting for a tool slot before overload errors (`-32003`) |
| `SIMPLE_CONTEXT_LIMITER_MAX_RPC_PENDING_REQUESTS` | `100` | Max JSON-RPC input lines being processed concurrently before request overload errors (`-32003`) |
| `SIMPLE_CONTEXT_LIMITER_READ_RANGE_TIMEOUT_MS` | `120000` | Max time spent scanning for a requested line range |
| `SIMPLE_CONTEXT_LIMITER_CACHE_MAX_ENTRIES` | `200` | Max cached fetch entries kept on disk |
| `SIMPLE_CONTEXT_LIMITER_CACHE_MAX_BYTES` | `52428800` | Max cached fetch content bytes kept on disk |
| `SIMPLE_CONTEXT_LIMITER_ALLOW_NON_HTTP_FETCH` | unset | Set to `1` to allow non-HTTP fetch schemes |
| `SIMPLE_CONTEXT_LIMITER_USAGE_LOG` | enabled | Set to `0` to disable local usage logging |
| `SIMPLE_CONTEXT_LIMITER_USAGE_LOG_MAX_BYTES` | `10485760` | Max usage log bytes kept on disk |
| `SIMPLE_CONTEXT_LIMITER_DISABLE_USAGE_LOG` | unset | Set to `1` to disable local usage logging |
| `SIMPLE_CONTEXT_LIMITER_STATS` | enabled | Set to `0` to disable aggregate stats writes |
| `SIMPLE_CONTEXT_LIMITER_DISABLE_STATS` | unset | Set to `1` to disable aggregate stats writes |

## Cache

`sc-fetch` caches eligible textual fetched content for 1 hour in `~/.simple-context-limiter/cache.json` and prunes old entries on load/save. The cache is capped by entry count and total content bytes. Literal `localhost`, loopback, unspecified (`0.0.0.0/8`), link-local, RFC1918/private IPv4, common RFC6890/special-use IPv4 ranges, IPv6 unique-local/link-local, and DNS names resolving to private/special-use addresses bypass persistent cache by default to avoid storing local secrets. Use per-call `cache: false` to disable cache for one request, `cache: true` to explicitly opt a trusted request in, `SIMPLE_CONTEXT_LIMITER_FETCH_CACHE=0` to disable default cache use, or `SIMPLE_CONTEXT_LIMITER_FETCH_CACHE=all` to cache private hosts by default. `force: true` means skip an existing cache entry and refresh; it is not a cache-disable control. Delete this file anytime to clear the cache.

`sc-usage` with `mode: "report"` reads `~/.simple-context-limiter/usage.jsonl`. Delete that file anytime to clear collected usage metadata.

## Privacy and Local Storage

simple-context-limiter does not send telemetry to a hosted service, but it can read local files, run local commands, fetch local/private HTTP services, and write small local state files under `~/.simple-context-limiter/` on the machine running the server. Disable usage logs with `SIMPLE_CONTEXT_LIMITER_USAGE_LOG=0` or `SIMPLE_CONTEXT_LIMITER_DISABLE_USAGE_LOG=1`, disable aggregate stats with `SIMPLE_CONTEXT_LIMITER_STATS=0` or `SIMPLE_CONTEXT_LIMITER_DISABLE_STATS=1`, and disable default fetch caching with `SIMPLE_CONTEXT_LIMITER_FETCH_CACHE=0`. For stricter shared/CI/remote-agent setups, set `SIMPLE_CONTEXT_LIMITER_DISABLE_COMMAND_TOOLS=1`, `SIMPLE_CONTEXT_LIMITER_FETCH_PUBLIC_ONLY=1`, and/or `SIMPLE_CONTEXT_LIMITER_PATH_ROOTS` to constrain the exposed local authority. Delete `cache.json`, `usage.jsonl`, or stats files in that directory whenever you want to clear local history.

## Strict / Shared Environment Examples

For a read-only-ish repo helper that cannot run shell commands, cannot fetch local/private networks, and cannot read outside the current checkout:

```json
{
  "SIMPLE_CONTEXT_LIMITER_DISABLE_COMMAND_TOOLS": "1",
  "SIMPLE_CONTEXT_LIMITER_FETCH_PUBLIC_ONLY": "1",
  "SIMPLE_CONTEXT_LIMITER_PATH_ROOTS": "/path/to/checkout",
  "SIMPLE_CONTEXT_LIMITER_FETCH_CACHE": "0",
  "SIMPLE_CONTEXT_LIMITER_USAGE_LOG": "0"
}
```

For CI where only known validation commands should be callable:

```json
{
  "SIMPLE_CONTEXT_LIMITER_COMMAND_ALLOWLIST": "npm test,npm run check",
  "SIMPLE_CONTEXT_LIMITER_FETCH_PUBLIC_ONLY": "1",
  "SIMPLE_CONTEXT_LIMITER_PATH_ROOTS": "/path/to/checkout"
}
```

These controls reduce accidental authority exposure but do not turn shell execution or network access into a sandbox. Run the MCP server with OS/container permissions appropriate for the trust boundary.

## Contributing, Security, and Changes

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development checks, [SECURITY.md](SECURITY.md) for vulnerability reporting and support policy, and [CHANGELOG.md](CHANGELOG.md) for release notes.

## Why So Minimal?

simple-context-limiter intentionally avoids heavy indexing, databases, embeddings, and large system prompts. It covers the most common context-wasting cases with small MCP tools and leaves full-output inspection to the native client tools when genuinely needed.

## License

MIT
