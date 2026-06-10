import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { COMMAND_SHELL, MAX_COMMAND_BYTES } from "./constants.js";
import { formatOutput } from "./output.js";

function terminateChild(child) {
  if (!child.pid) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => child.kill());
    killer.unref();
    return;
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
}

export function commandErrorData(error) {
  const data = {};

  if (error.status !== null && error.status !== undefined) data.exitCode = error.status;
  if (error.signal) data.signal = error.signal;

  for (const stream of ["stdout", "stderr"]) {
    const value = error[stream];
    if (!value) continue;

    const output = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    data[stream] = formatOutput(output).text;
  }

  return Object.keys(data).length > 0 ? data : undefined;
}

export function commandError(command, code, signal, stdout, stderr, timedOut = false, outputTooLarge = false) {
  const detail = outputTooLarge
    ? `output exceeded ${MAX_COMMAND_BYTES} bytes`
    : timedOut
      ? `timed out after 120000ms`
      : `exited with code ${code}`;
  const error = new Error(`Command failed: ${command} (${detail})`);

  error.status = code;
  error.signal = signal;
  error.stdout = stdout;
  error.stderr = stderr;
  throw error;
}

export function errorData(error) {
  const data = {};
  for (const key of ["code", "errno", "address", "port"]) {
    if (typeof error[key] === "string" || typeof error[key] === "number") data[key] = error[key];
  }
  if (error.cause) {
    data.cause = {};
    for (const key of ["code", "errno", "address", "port"]) {
      if (typeof error.cause[key] === "string" || typeof error.cause[key] === "number") {
        data.cause[key] = error.cause[key];
      }
    }
  }

  return Object.keys(data).length > 0 ? data : undefined;
}

function collectOutput(child, stdout, stderr) {
  let outputBytes = 0;
  let outputTooLarge = false;

  function appendOutput(chunks, chunk) {
    if (outputTooLarge) return;

    const remaining = MAX_COMMAND_BYTES - outputBytes;
    if (chunk.byteLength > remaining) {
      if (remaining > 0) chunks.push(chunk.slice(0, remaining));
      outputBytes = MAX_COMMAND_BYTES;
      outputTooLarge = true;
      terminateChild(child);
      return;
    }

    chunks.push(chunk);
    outputBytes += chunk.byteLength;
  }

  child.stdout.on("data", (chunk) => appendOutput(stdout, chunk));
  child.stderr.on("data", (chunk) => appendOutput(stderr, chunk));

  return () => outputTooLarge;
}

export async function runProcess(file, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

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

export async function runCommand(command) {
  return await new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, {
      shell: COMMAND_SHELL,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const outputTooLarge = collectOutput(child, stdout, stderr);

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, 120_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      const durationMs = Date.now() - started;

      if (code === 0 && !timedOut) {
        resolve({ stdout: stdoutText, durationMs });
        return;
      }

      try {
        commandError(command, code, signal, stdoutText, stderrText, timedOut, outputTooLarge());
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function runProcessLines(file, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

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
