import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { acquireRunLock } from "../src/run-lock.mjs";

test("only one main process owns a work directory and the lock can be reacquired", async () => {
  const directory = fileURLToPath(new URL("../.data/tests/", import.meta.url));
  await mkdir(directory, { recursive: true });
  const work = await mkdtemp(join(directory, "lock-"));
  try {
    const release = await acquireRunLock(work);
    try { await assert.rejects(acquireRunLock(work), /already owns/); }
    finally { await release(); }
    const releaseAgain = await acquireRunLock(work);
    await releaseAgain();
  } finally { await rm(work, { recursive: true, force: true }); }
});

test("unexpected helper exit reports lock loss and blocks the old owner from continuing", async () => {
  const directory = fileURLToPath(new URL("../.data/tests/", import.meta.url));
  await mkdir(directory, { recursive: true });
  const work = await mkdtemp(join(directory, "lock-lost-"));
  try {
    let resolveLost;
    const lost = new Promise(resolve => { resolveLost = resolve; });
    const release = await acquireRunLock(work, { onLost: resolveLost });
    process.kill(release.pid, "SIGKILL");
    const error = await lost;
    assert.equal(error.code, "run_lock_lost");
    const replacement = await acquireRunLock(work);
    await replacement();
    await release();
  } finally { await rm(work, { recursive: true, force: true }); }
});
