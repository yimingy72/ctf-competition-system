import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, open, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import { createReadTool, createWriteTool, createEditTool, detectSupportedImageMimeTypeFromFile,
  DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rememberProcess, forgetProcess, recoverProcesses } from "./session-processes.mjs";

const PREVIEW_BYTES = 48 * 1024;
const CANCEL_DRAIN_MS = 250;

async function readTextRange(path, { offset = 1, limit }, signal) {
  const file = await open(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  const pieces = [];
  let line = 1;
  let selectedLines = 0;
  let selectedBytes = 0;
  let bytesRead = 0;
  let stopped = false;
  let lineLimitReached = false;
  try {
    scan: while (true) {
      signal?.throwIfAborted();
      const { bytesRead: count } = await file.read(buffer);
      signal?.throwIfAborted();
      if (!count) break;
      bytesRead += count;
      for (let start = 0; start < count;) {
        const newline = buffer.indexOf(10, start);
        const end = newline >= 0 && newline < count ? newline + 1 : count;
        if (line >= offset) {
          // One extra byte detects an oversized line without retaining its remainder.
          const size = Math.min(end - start, DEFAULT_MAX_BYTES + 1 - selectedBytes);
          pieces.push(Buffer.from(buffer.subarray(start, start + size)));
          selectedBytes += size;
          if (selectedBytes > DEFAULT_MAX_BYTES) { stopped = true; break scan; }
          if (end > start && buffer[end - 1] === 10
            && ++selectedLines >= Math.min(limit ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES)) {
            stopped = lineLimitReached = true;
            break scan;
          }
        }
        if (end > start && buffer[end - 1] === 10) line += 1;
        start = end;
      }
    }
  } finally { await file.close(); }
  if (line < offset) throw new Error(`Offset ${offset} is beyond end of file (${line} lines total)`);
  let text = Buffer.concat(pieces).toString("utf8");
  if (lineLimitReached) text = text.slice(0, -1);
  const truncation = truncateHead(text);
  const truncated = stopped || truncation.truncated;
  const returnedLines = truncation.truncated ? truncation.outputLines
    : lineLimitReached ? selectedLines : truncation.outputLines;
  const nextOffset = truncated && !truncation.firstLineExceedsLimit ? offset + returnedLines : null;
  const output = truncation.firstLineExceedsLimit
    ? `[Line ${offset} exceeds ${DEFAULT_MAX_BYTES / 1024} KiB. Use bash to read a bounded byte range of this line.]`
    : truncation.content + (nextOffset === null ? ""
      : `\n\n[Showing lines ${offset}-${nextOffset - 1}. Use offset=${nextOffset} to continue.]`);
  return { content: [{ type: "text", text: output }], structuredContent: output,
    details: { bytes_read: bytesRead, truncated, next_offset: nextOffset,
      truncation: { ...truncation, truncated, outputLines: returnedLines,
        truncatedBy: truncation.truncatedBy ?? (stopped ? "lines" : null),
        // Do not present the bounded prefix's size as the complete file/range size.
        totalBytes: stopped ? null : truncation.totalBytes,
        totalLines: stopped ? null : truncation.totalLines } } };
}

function createBoundedReadTool(cwd) {
  const original = createReadTool(cwd);
  return { ...original,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to read (1-indexed)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
    }),
    async execute(callId, args, signal, onUpdate) {
      for (const key of ["offset", "limit"]) if (args[key] !== undefined
        && (!Number.isSafeInteger(args[key]) || args[key] < 1)) throw new Error(`${key} must be a positive integer`);
      let image = false;
      let textResult;
      // The public operations hook retains SDK path resolution, access checks and image handling.
      const reader = createReadTool(cwd, { operations: {
        access: path => access(path, constants.R_OK),
        detectImageMimeType: async path => {
          const mime = await detectSupportedImageMimeTypeFromFile(path);
          image = Boolean(mime);
          return mime;
        },
        readFile: async path => {
          if (image) return readFile(path, { signal });
          textResult = await readTextRange(path, args, signal);
          // SDK has no range-reader hook; its empty text result is replaced below.
          return Buffer.alloc(0);
        },
      } });
      const result = await reader.execute(callId, { path: args.path }, signal, onUpdate);
      return textResult ?? result;
    },
  };
}

function killGroup(pid) {
  if (!pid) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

function toolEnvironment(overrides, secrets) {
  const env = { ...process.env, ...overrides };
  for (const name of ["ARENA_SOLVER_TOKEN", "BENCHMARK_TOKEN", "CTF_MODEL_API_KEY",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"]) delete env[name];
  for (const [name, value] of Object.entries(env)) if (secrets.has(value?.trim())) delete env[name];
  return env;
}

export function createLocalTools({ cwd, outputDir = join(cwd, "tool-output"), env = {}, secrets = [] }) {
  const processes = new Map();
  const privateValues = new Set(secrets.filter((value) => typeof value === "string" && value.length));
  const files = [createBoundedReadTool(cwd), createWriteTool(cwd), createEditTool(cwd)].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    local: true,
    execute: (args, { callId, signal, onUpdate }) => tool.execute(callId, args, signal, onUpdate),
  }));
  const bash = {
    name: "bash",
    description: "Execute a command in the shared Linux container. Set cwd explicitly when needed. "
      + "Returns exit status and the last 48 KiB of output; complete output is saved to the returned file. "
      + "Optional timeout is in seconds. The shell process group is stopped when this command finishes or is cancelled; "
      + "cleanup_unknown reports a cancelled command whose output pipes did not close promptly.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      cwd: Type.Optional(Type.String()),
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2147483 })),
    }),
    local: true,
    async execute(args, { callId = randomUUID(), signal } = {}) {
      signal?.throwIfAborted();
      if (typeof args.command !== "string" || !args.command.trim()) throw new Error("A command is required");
      if (args.timeout !== undefined && (!Number.isFinite(args.timeout) || args.timeout <= 0
        || args.timeout > 2147483)) throw new Error("Invalid command timeout");
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      const filename = createHash("sha256").update(callId).digest("hex") + ".log";
      const outputPath = join(outputDir, filename);
      const processPath = join(outputDir, filename + ".process.json");
      const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
      let outputError;
      output.on("error", (error) => { outputError = error; });
      const started = performance.now();
      const child = spawn("/bin/bash", ["-s"], {
        cwd: resolve(cwd, args.cwd ?? "."),
        env: toolEnvironment(env, privateValues),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let preview = Buffer.alloc(0);
      let bytes = 0;
      let timedOut = false;
      let aborted = false;
      let drainTimedOut = false;
      let drainTimer;
      let spawnError;
      const stop = () => killGroup(child.pid);
      const cancel = () => {
        stop();
        drainTimer ??= setTimeout(() => {
          if (child.stdout.destroyed && child.stderr.destroyed) return;
          drainTimedOut = true;
          child.stdout.destroy();
          child.stderr.destroy();
        }, CANCEL_DRAIN_MS);
      };
      const abort = () => { aborted = true; cancel(); };
      if (child.pid) processes.set(child.pid, abort);
      child.stdin.on("error", () => {});
      child.once("spawn", () => {
        try {
          rememberProcess(processPath, child.pid);
          child.stdin.end(args.command + "\n");
        } catch (error) { spawnError = error; stop(); }
      });
      const timeout = args.timeout === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        cancel();
      }, args.timeout * 1000);
      const consume = (stream) => stream.on("data", (chunk) => {
        bytes += chunk.length;
        preview = Buffer.concat([preview, chunk]).subarray(-PREVIEW_BYTES);
        if (!output.write(chunk)) {
          stream.pause();
          output.once("drain", () => stream.resume());
        }
      });
      consume(child.stdout);
      consume(child.stderr);
      output.on("error", stop);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let exitCode;
      let exitSignal;
      try {
        [exitCode, exitSignal] = await new Promise((accept) => {
          child.once("error", (error) => { spawnError = error; accept([null, null]); });
          child.once("exit", (code, sig) => { stop(); accept([code, sig]); });
        });
        await new Promise((accept) => {
          if (child.stdout.destroyed && child.stderr.destroyed) accept();
          else child.once("close", accept);
        });
      } finally {
        clearTimeout(timeout);
        clearTimeout(drainTimer);
        signal?.removeEventListener("abort", abort);
        stop();
        processes.delete(child.pid);
        output.end();
        await finished(output);
        forgetProcess(processPath);
      }
      if (outputError) throw outputError;
      if (spawnError) throw spawnError;
      const details = {
        exit_code: exitCode,
        signal: exitSignal,
        timed_out: timedOut,
        aborted,
        drain_timeout: drainTimedOut,
        cleanup_unknown: drainTimedOut,
        bytes,
        truncated: bytes > PREVIEW_BYTES,
        output_path: outputPath,
        duration_ms: Math.round(performance.now() - started),
      };
      return {
        content: [{ type: "text", text: `${preview.toString("utf8") || "(no output)"}\n${JSON.stringify(details)}` }],
        details,
        isError: exitCode !== 0 || timedOut || aborted,
      };
    },
  };
  return {
    tools: [bash, ...files],
    activeProcesses: () => processes.size,
    abort: () => { for (const abort of processes.values()) abort(); },
    recover: () => recoverProcesses(outputDir),
  };
}
