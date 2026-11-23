import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export async function acquireRunLock(workDir, { onLost } = {}) {
  await mkdir(workDir, { recursive: true });
  const helper = fileURLToPath(new URL("../scripts/run-lock.py", import.meta.url));
  const process = spawn("python3", [helper, join(workDir, ".run.lock")], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(process, "exit");
  await new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", code => reject(new Error(code === 73
      ? "Another solver process already owns this work directory" : `Work-directory lock failed (${code})`)));
    process.stdout.once("data", data => {
      if (data.toString().trim() === "locked") resolve();
      else reject(new Error("Invalid work-directory lock response"));
    });
  });
  let releasing = false;
  void exited.then(([code, signal]) => {
    if (releasing) return;
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    const error = Object.assign(new Error(`Work-directory lock helper exited unexpectedly with ${detail}`), {
      code: "run_lock_lost",
    });
    try { onLost?.(error); }
    catch (callbackError) { queueMicrotask(() => { throw callbackError; }); }
  });
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    releasing = true;
    if (process.stdin.writable) process.stdin.end();
    await exited;
  };
  release.pid = process.pid;
  return release;
}
