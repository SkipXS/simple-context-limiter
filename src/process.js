import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { COMMAND_SHELL, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_BYTES } from "./constants.js";
import { formatOutput } from "./output.js";

const activeChildren = new Set();

function trackChild(child) {
  activeChildren.add(child);
  const remove = () => activeChildren.delete(child);
  child.once("close", remove);
  child.once("error", remove);
  return child;
}

export async function terminateActiveChildren() {
  await Promise.allSettled([...activeChildren].map((child) => terminateChild(child)));
}

function spawnTarget(file, args, options = {}) {
  if (options.windowsCommandShim && process.platform === "win32") {
    const npmShim = resolveNpmCommandShim(file);
    if (npmShim) return { file: process.execPath, args: [npmShim, ...args] };

    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", ["call", file, ...args.map(escapeWindowsCmdArg)].join(" ")],
    };
  }

  return { file, args };
}

function resolveNpmCommandShim(file) {
  if (!/\.cmd$/i.test(file)) return undefined;

  try {
    const content = fs.readFileSync(file, "utf8");
    const match = content.match(/"%dp0%\\([^"]+)"\s+%\*/i);
    if (!match) return undefined;

    const target = path.join(path.dirname(file), ...match[1].split("\\"));
    return fs.existsSync(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

function escapeWindowsCmdArg(value) {
  return String(value).replace(/[()%!^"<>&|]/g, "^$&");
}

function terminateChild(child) {
  if (!child.pid) {
    child.kill();
    return Promise.resolve();
  }

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => done(true), 1_000);
      timer.unref();
      const done = (fallback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (fallback) child.kill();
        resolve();
      };
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => done(true));
      killer.on("close", (code) => done(code !== 0));
      killer.unref();
    });
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  const force = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 1_000);
  force.unref();
  return Promise.resolve();
}

export function commandErrorData(error) {
  const data = {};

  if (error.status !== null && error.status !== undefined) data.exitCode = error.status;
  if (error.signal) data.signal = error.signal;
  if (typeof error.timedOut === "boolean") data.timedOut = error.timedOut;
  if (typeof error.outputTooLarge === "boolean") data.outputTooLarge = error.outputTooLarge;
  if (Number.isFinite(error.timeoutMs)) data.timeoutMs = error.timeoutMs;

  for (const stream of ["stdout", "stderr"]) {
    const value = error[stream];
    if (!value) continue;

    const output = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    data[stream] = formatOutput(output).text;
  }

  return Object.keys(data).length > 0 ? data : undefined;
}

export function commandError(command, code, signal, stdout, stderr, timedOut = false, outputTooLarge = false, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  const detail = outputTooLarge
    ? `output exceeded ${MAX_COMMAND_BYTES} bytes`
    : timedOut
      ? `timed out after ${timeoutMs}ms`
      : `exited with code ${code}`;
  const error = new Error(`Command failed: ${command} (${detail})`);

  error.status = code;
  error.signal = signal;
  error.stdout = stdout;
  error.stderr = stderr;
  error.timedOut = timedOut;
  error.outputTooLarge = outputTooLarge;
  error.timeoutMs = timeoutMs;
  throw error;
}

export function errorData(error) {
  const data = {};
  for (const key of ["code", "errno", "address", "port", "httpStatus", "httpStatusText", "url"]) {
    if (typeof error[key] === "string" || typeof error[key] === "number") data[key] = error[key];
  }
  if (error.cause) {
    data.cause = {};
    for (const key of ["code", "errno", "address", "port", "name", "message"]) {
      if (typeof error.cause[key] === "string" || typeof error.cause[key] === "number") {
        data.cause[key] = error.cause[key];
      }
    }
  }

  return Object.keys(data).length > 0 ? data : undefined;
}

function collectOutput(child, stdout, stderr, combined) {
  let outputBytes = 0;
  let outputTooLarge = false;

  function appendOutput(chunks, chunk) {
    if (outputTooLarge) return;

    const remaining = MAX_COMMAND_BYTES - outputBytes;
    if (chunk.byteLength > remaining) {
      if (remaining > 0) {
        const kept = chunk.slice(0, remaining);
        chunks.push(kept);
        combined?.push(kept);
      }
      outputBytes = MAX_COMMAND_BYTES;
      outputTooLarge = true;
      terminateChild(child);
      return;
    }

    chunks.push(chunk);
    combined?.push(chunk);
    outputBytes += chunk.byteLength;
  }

  child.stdout.on("data", (chunk) => appendOutput(stdout, chunk));
  child.stderr.on("data", (chunk) => appendOutput(stderr, chunk));

  return () => outputTooLarge;
}

export async function runProcess(file, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const started = Date.now();
    const target = spawnTarget(file, args, options);
    const child = trackChild(spawn(target.file, target.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    }));

    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const outputTooLarge = collectOutput(child, stdout, stderr);

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, options.timeout ?? 120_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - started,
        timedOut,
        outputTooLarge: outputTooLarge(),
      });
    });
  });
}

export async function runCommandResult(command, options = {}) {
  return await new Promise((resolve, reject) => {
    const started = Date.now();
    const child = trackChild(spawn(command, {
      shell: COMMAND_SHELL,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    }));

    const stdout = [];
    const stderr = [];
    const output = [];
    let timedOut = false;
    const outputTooLarge = collectOutput(child, stdout, stderr, output);

    const timeoutMs = options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const outputBuffer = Buffer.concat(output);
      resolve({
        code,
        signal,
        stdout: stdoutBuffer.toString("utf8"),
        stderr: stderrBuffer.toString("utf8"),
        stderrBytes: stderrBuffer.byteLength,
        output: outputBuffer.toString("utf8"),
        durationMs: Date.now() - started,
        timeoutMs,
        timedOut,
        outputTooLarge: outputTooLarge(),
      });
    });
  });
}

export async function runCommand(command, options = {}) {
  const result = await runCommandResult(command, options);
  if (options.allowOutputTooLarge && result.outputTooLarge && !result.timedOut && result.stdout) {
    return {
      stdout: result.stdout,
      stderrBytes: result.stderrBytes,
      durationMs: result.durationMs,
      timeoutMs: result.timeoutMs,
      outputTooLarge: result.outputTooLarge,
      code: result.code,
      signal: result.signal,
    };
  }
  if (result.code === 0 && !result.signal && !result.timedOut) {
    return {
      stdout: result.stdout,
      stderrBytes: result.stderrBytes,
      durationMs: result.durationMs,
      timeoutMs: result.timeoutMs,
      outputTooLarge: result.outputTooLarge,
      code: result.code,
      signal: result.signal,
    };
  }

  commandError(command, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge, result.timeoutMs);
}

export async function runProcessLines(file, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const started = Date.now();
    const target = spawnTarget(file, args, options);
    const child = trackChild(spawn(target.file, target.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    }));

    const maxLines = options.maxLines ?? 100;
    const maxBytes = options.maxBytes ?? MAX_COMMAND_BYTES;
    const stdoutLines = [];
    const stderr = [];
    const decoder = new StringDecoder("utf8");
    let pendingLine = "";
    let outputBytes = 0;
    let timedOut = false;
    let truncated = false;
    let outputTooLarge = false;

    function stopAsTooLarge() {
      outputTooLarge = true;
      terminateChild(child);
    }

    function appendLine(line) {
      if (stdoutLines.length >= maxLines) {
        truncated = true;
        terminateChild(child);
        return false;
      }

      stdoutLines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
      return true;
    }

    child.stdout.on("data", (chunk) => {
      if (truncated || outputTooLarge) return;

      outputBytes += chunk.byteLength;
      if (outputBytes > maxBytes) {
        stopAsTooLarge();
        return;
      }

      pendingLine += decoder.write(chunk);
      for (;;) {
        const newline = pendingLine.indexOf("\n");
        if (newline === -1) break;

        const line = pendingLine.slice(0, newline);
        pendingLine = pendingLine.slice(newline + 1);
        if (!appendLine(line)) break;
      }
    });

    child.stderr.on("data", (chunk) => {
      if (outputTooLarge) return;

      outputBytes += chunk.byteLength;
      if (outputBytes > maxBytes) {
        stopAsTooLarge();
        return;
      }

      stderr.push(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, options.timeout ?? 120_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (!truncated && !outputTooLarge) {
        pendingLine += decoder.end();
        if (pendingLine) appendLine(pendingLine);
      }

      resolve({
        code,
        signal,
        lines: stdoutLines,
        stdout: stdoutLines.join("\n"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - started,
        timedOut,
        truncated,
        outputTooLarge,
      });
    });
  });
}
