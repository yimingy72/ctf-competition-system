import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resources } from "../src/resources.mjs";

test("resource reads retain container units and unavailable fields", async () => {
  const scratch = fileURLToPath(new URL("../.data/tests/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, "resource-"));
  const resources = new Resources({ workDir: dir, cgroupPath: dir, execution: () => ({ workers: 20 }) });
  try {
    await Promise.all(Object.entries({
      "cpu.max": "400000 100000", "cpu.stat": "usage_usec 100000\nnr_throttled 2\nthrottled_usec 500",
      "memory.max": "6442450944", "memory.current": "1024", "memory.peak": "4096",
      "memory.stat": "anon 768\nfile 256",
      "memory.events": "low 0\nhigh 0\nmax 3\noom 2\noom_kill 1\noom_group_kill 0",
    }).map(([name, value]) => writeFile(join(dir, name), value)));
    const [result, concurrent] = await Promise.all([resources.snapshot(), resources.snapshot()]);
    assert.equal(concurrent, result);
    assert.equal(result.cpu.quota_cpus, 4);
    assert.equal(result.cpu.counters.nr_throttled, 2);
    assert.equal(result.memory.limit_bytes, 6 * 1024 ** 3);
    assert.equal(result.memory.current_bytes, 1024);
    assert.equal(result.memory.oom_count, 2);
    assert.equal(result.memory.oom_kill_count, 1);
    assert.equal(result.memory.oom_group_kill_count, 0);
    assert.ok(result.memory.node.rss > 0);
    assert.ok(result.runtime.process_uptime_seconds >= 0);
    assert.equal(result.execution.workers, 20);
    assert.ok(result.disk.available_bytes > 0);
    await rm(join(dir, "cpu.max"));
    await rm(join(dir, "memory.max"));
    await rm(join(dir, "memory.events"));
    const missing = await resources.snapshot();
    assert.equal(missing.cpu.source, "unavailable");
    assert.equal(missing.cpu.quota_cpus, null);
    assert.equal(missing.memory.limit_bytes, null);
    assert.equal(missing.memory.oom_count, null);
    assert.equal(missing.memory.oom_kill_count, null);
    assert.equal(missing.memory.oom_group_kill_count, null);
  } finally {
    resources.close();
    await rm(dir, { recursive: true, force: true });
  }
});
