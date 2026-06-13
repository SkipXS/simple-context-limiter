# simple-context-limiter MCP Lifecycle Hardening Notes

## Context

While running `pi-simple-subagents` review fanouts on Windows, one reviewer appeared to hang even though it had already produced its review artifact.

Observed run:

```text
C:\Projects\mini-sandbox\.pi\agent-runs\20260613T144053-90m921
```

The reviewer artifact existed and was complete:

```text
review-6-developer-experience-wartbarkeit-und-dokumentati.md
```

But the child Pi process remained alive. Process tree inspection showed the reviewer Pi process was being kept open by an MCP server launched through `npx`:

```text
node.exe ... pi-coding-agent ... reviewer-1781361744569-vrh56n.jsonl
  conhost.exe
  cmd.exe /d /s /c "npx ^"-y^" ^"github:SkipXS/simple-context-limiter^""
    node.exe ... npm\bin\npx-cli.js -y github:SkipXS/simple-context-limiter
      cmd.exe /d /s /c simple-context-limiter
        node.exe ... simple-context-limiter\server.js
```

Killing the intermediate `cmd.exe` process with:

```powershell
taskkill /PID 23592 /T /F
```

allowed the parent review workflow to continue cleanly into synthesis and complete.

There was also stderr from the reviewer Pi process:

```text
MCP initialization failed: Error: EPERM: operation not permitted, rename
'C:\Users\sebas\.pi\agent\mcp-cache.json.<pid>.tmp' ->
'C:\Users\sebas\.pi\agent\mcp-cache.json'
```

This suggests the immediate hang was likely a Pi/MCP lifecycle + Windows/npx wrapper issue, not necessarily a simple-context-limiter tool execution bug. However, simple-context-limiter can still be hardened so it exits more predictably under MCP client shutdown, parent process termination, stdio closure, and signal events.

## Findings

### 1. The MCP server currently relies mostly on natural Node process exit

In `server.js`, stdin end is currently handled like this:

```js
process.stdin.on("end", () => {
  if (lineBytes > 0 || discardingLine) finishLine();
});
```

This processes a final partial line but does not explicitly initiate shutdown or force exit after a grace period.

If any active handle remains open, or if parent/wrapper processes behave oddly on Windows, the MCP server process may remain alive after the client is done.

### 2. JSON-RPC lifecycle methods appear incomplete

The current `handleMessage()` supports:

- `initialize`
- `notifications/initialized`
- `tools/list`
- `tools/call`

Recommended MCP lifecycle handling should also include:

- `shutdown`
- `notifications/exit`

Expected behavior:

- `shutdown` with id: send success response and mark server shutting down.
- after shutdown: reject new tool calls / list calls.
- `notifications/exit`: exit promptly.

### 3. Signals and parent disconnect should be handled explicitly

Add handlers for:

- `SIGTERM`
- `SIGINT`
- `SIGHUP` where available
- `process.on("disconnect")`
- `process.stdin.on("close")`

These should start graceful shutdown and then force exit after a short timeout.

### 4. `npx github:SkipXS/simple-context-limiter` adds fragile wrapper layers

The observed process tree had multiple wrappers:

```text
cmd.exe -> npx-cli.js -> cmd.exe -> server.js
```

This increases the chance that the actual MCP server stays alive after the caller thinks it is done, or that signal/stdio handling behaves differently from direct execution.

Prefer direct invocation where possible:

```json
{
  "command": "node",
  "args": ["C:/path/to/simple-context-limiter/server.js"]
}
```

or a pinned npm registry package instead of GitHub npx:

```text
npx -y simple-context-limiter@1.1.0
```

GitHub `npx` is slower and more lifecycle-sensitive on Windows.

## Suggested implementation plan

### A. Add shutdown state

Add module-level state:

```js
let shuttingDown = false;
let shutdownTimer;
```

Add helper:

```js
function beginShutdown(reason = "shutdown") {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    process.stderr.write(`[${SERVER_NAME}] shutting down: ${reason}\n`);
  } catch {}
  shutdownTimer = setTimeout(() => process.exit(0), 1000);
  shutdownTimer.unref?.();
}
```

If tools can spawn child processes, also add a cleanup hook for active child processes if such tracking exists.

### B. Support JSON-RPC `shutdown` and `notifications/exit`

In `handleMessage()` before `tools/list` / `tools/call`:

```js
if (method === "shutdown") {
  if (!hasId) return undefined;
  beginShutdown("json-rpc shutdown");
  return resultResponse(id, null);
}

if (method === "notifications/exit") {
  beginShutdown("json-rpc exit notification");
  setImmediate(() => process.exit(0));
  return undefined;
}
```

Then reject requests after shutdown:

```js
if (shuttingDown && method !== "shutdown" && method !== "notifications/exit") {
  if (!hasId) return undefined;
  return errorResponse(id, -32000, "Server is shutting down");
}
```

### C. End process on stdio closure

Extend stdin handlers:

```js
process.stdin.on("end", () => {
  if (lineBytes > 0 || discardingLine) finishLine();
  beginShutdown("stdin end");
});

process.stdin.on("close", () => {
  beginShutdown("stdin close");
});
```

### D. Add signal / disconnect handling

```js
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  try {
    process.on(signal, () => beginShutdown(signal));
  } catch {}
}

process.on("disconnect", () => beginShutdown("parent disconnect"));
```

On Windows, `SIGHUP` may not always be meaningful, so guard with try/catch.

### E. Tests to add

Add tests in `test/server-backpressure.test.js` or a new `test/server-lifecycle.test.js`.

Recommended cases:

1. **Responds to shutdown and exits on exit notification**
   - spawn server
   - initialize
   - send `shutdown` request
   - expect result response
   - send `notifications/exit`
   - expect process close within e.g. 1s

2. **Exits when stdin ends**
   - spawn server
   - initialize
   - close `server.stdin.end()`
   - expect process close within e.g. 1s

3. **Rejects tool calls after shutdown**
   - initialize
   - send `shutdown`
   - send `tools/list` or `tools/call`
   - expect JSON-RPC error or no response depending protocol expectations

4. **Signal handling**
   - spawn server
   - send `SIGTERM` or `server.kill()`
   - expect process close
   - should not print unhandled rejection / uncaught exception

## Important nuance

The simple-context-limiter server may not be the root cause of the original hang. The root issue included:

- Windows process wrapper chain from `npx github:...`
- Pi MCP initialization cache rename collision/EPERM
- MCP process remaining alive after the reviewer had already emitted terminal assistant output

`pi-simple-subagents` was patched separately to handle this class of issue by terminating lingering child process trees after a terminal assistant output. Still, hardening simple-context-limiter is worthwhile because it improves behavior for all MCP clients and reduces the chance of lingering server processes.

## Operational recommendation

For local MCP config, prefer direct/pinned server invocation over GitHub `npx`:

```json
{
  "command": "node",
  "args": ["C:/Projects/mini-sandbox/server.js"]
}
```

or:

```json
{
  "command": "npx",
  "args": ["-y", "simple-context-limiter@1.1.0"]
}
```

Avoid when possible:

```json
{
  "command": "npx",
  "args": ["-y", "github:SkipXS/simple-context-limiter"]
}
```

especially on Windows and in high-concurrency reviewer fanouts.
