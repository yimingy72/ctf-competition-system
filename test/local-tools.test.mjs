import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createLocalTools } from "../src/local-tools.mjs";

async function tools(t, options = {}) {
  const scratch = fileURLToPath(new URL("../.data/tests/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const cwd = await mkdtemp(join(scratch, "tools-"));
  const local = createLocalTools({ cwd, ...options });
  t.after(async () => { local.abort(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, local, tool: (name) => local.tools.find((item) => item.name === name) };
}

test("local tools preserve file edits and spool large command output", async (t) => {
  const { cwd, tool } = await tools(t);
  await tool("write").execute({ path: "a.txt", content: "one\ntwo\n" }, { callId: "write" });
  await tool("edit").execute({ path: "a.txt", edits: [{ oldText: "two", newText: "three" }] }, { callId: "edit" });
  const file = await tool("read").execute({ path: "a.txt" }, { callId: "read" });
  assert.match(file.content[0].text, /three/);
  const output = await tool("bash").execute({ command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(200000))'` }, { callId: "large" });
  assert.equal(output.details.bytes, 200000);
  assert.equal(output.details.truncated, true);
  assert.equal((await readFile(output.details.output_path)).length, 200000);
  assert.ok(output.content[0].text.length < 51000);
  assert.equal(process.cwd().includes(cwd), false);
});

test("timeout and cancellation reap shell descendants", async (t) => {
  const { local, tool } = await tools(t);
  const timeout = await tool("bash").execute({ command: "sleep 60 & wait", timeout: 0.05 }, { callId: "timeout" });
  assert.equal(timeout.details.timed_out, true);
  assert.equal(timeout.isError, true);
  assert.equal(timeout.details.cleanup_unknown, false);
  assert.equal(local.activeProcesses(), 0);
  const controller = new AbortController();
  const work = tool("bash").execute({ command: "sleep 60 & wait" }, { callId: "abort", signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const cancelled = await work;
  assert.equal(cancelled.details.aborted, true);
  assert.equal(cancelled.details.cleanup_unknown, false);
  assert.equal(local.activeProcesses(), 0);
});

test("text reads bound retained input and preserve line, UTF-8 and SDK path semantics", async (t) => {
  const { cwd, tool } = await tools(t);
  await writeFile(join(cwd, "large.txt"), "first\n" + "x".repeat(4 * 1024 * 1024) + "\nlast😀");
  const first = await tool("read").execute({ path: "@large.txt", offset: 1, limit: 1 }, { callId: "first" });
  assert.match(first.content[0].text, /^first\n/);
  assert.equal(first.details.next_offset, 2);
  assert.ok(first.details.bytes_read <= 64 * 1024);
  assert.equal(first.details.truncation.totalBytes, null);
  const oversized = await tool("read").execute({ path: "large.txt", offset: 2 }, { callId: "oversized" });
  assert.equal(oversized.details.truncation.firstLineExceedsLimit, true);
  assert.ok(oversized.details.bytes_read <= 2 * 64 * 1024);
  assert.ok(oversized.content[0].text.length < 200);
  const last = await tool("read").execute({ path: "large.txt", offset: 3 }, { callId: "last" });
  assert.equal(last.content[0].text, "last😀");
  await assert.rejects(tool("read").execute({ path: "large.txt", offset: 4 }, { callId: "past-end" }), /beyond end/);
  const unicode = "界😀".repeat(2000);
  await writeFile(join(cwd, "cafe\u0301.txt"), "p".repeat(65000) + "\n" + unicode + "\nend");
  const ranged = await tool("read").execute({ path: "@café.txt", offset: 2, limit: 1 }, { callId: "unicode" });
  assert.equal(ranged.content[0].text.split("\n\n[")[0], unicode);
  await writeFile(join(cwd, "lines.txt"), "line\n".repeat(2100));
  const lines = await tool("read").execute({ path: "lines.txt" }, { callId: "lines" });
  assert.equal(lines.details.next_offset, 2001);
  assert.equal(lines.details.truncation.outputLines, 2000);
  await writeFile(join(cwd, "empty-line.txt"), "\nnext");
  const emptyLine = await tool("read").execute({ path: "empty-line.txt", limit: 1 }, { callId: "empty-line" });
  assert.equal(emptyLine.details.next_offset, 2);
  assert.equal(emptyLine.details.truncation.outputLines, 1);
  const boundary = "界".repeat(Math.floor(50 * 1024 / 3));
  await writeFile(join(cwd, "byte-boundary.txt"), boundary + "\n尾😀");
  const bounded = await tool("read").execute({ path: "byte-boundary.txt" }, { callId: "byte-boundary" });
  assert.equal(bounded.content[0].text.split("\n\n[")[0], boundary);
  assert.equal(bounded.details.truncation.outputBytes, Buffer.byteLength(boundary));
  assert.equal(bounded.details.next_offset, 2);
  assert.equal(bounded.content[0].text.includes("\uFFFD"), false);
});

test("read retains image support and rejects cancelled or invalid reads", async (t) => {
  const { cwd, tool } = await tools(t);
  await writeFile(join(cwd, "pixel.gif"), Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
  const picture = await tool("read").execute({ path: "pixel.gif" }, { callId: "picture" });
  assert.ok(picture.content.some(part => part.type === "image"));
  await assert.rejects(tool("read").execute({ path: "missing" }, { callId: "missing" }), /ENOENT/);
  await assert.rejects(tool("read").execute({ path: "pixel.gif", offset: 0 }, { callId: "invalid" }), /positive integer/);
  const controller = new AbortController();
  const reading = tool("read").execute({ path: "pixel.gif" }, { callId: "cancel-read", signal: controller.signal });
  controller.abort();
  await assert.rejects(reading, /abort/i);
});

test("timeout and abort stop waiting for output held by a different process group", { skip: process.platform !== "linux" }, async (t) => {
  const { cwd, local, tool } = await tools(t);
  for (const mode of ["timeout", "signal", "local"]) {
    const pidFile = join(cwd, `${mode}.pid`);
    let pid;
    const controller = new AbortController();
    const command = `setsid sh -c 'echo $$ > ${mode}.pid; sleep 5' & wait`;
    const started = performance.now();
    const work = tool("bash").execute({ command, ...(mode === "timeout" ? { timeout: 0.2 } : {}) },
      { callId: `escaped-${mode}`, signal: controller.signal });
    try {
      const deadline = Date.now() + 2000;
      while (!pid && Date.now() < deadline) {
        try { pid = Number(await readFile(pidFile, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!pid) await new Promise(accept => setTimeout(accept, 5));
      }
      assert.ok(pid);
      if (mode === "signal") controller.abort();
      if (mode === "local") local.abort();
      const result = await work;
      assert.equal(result.details.drain_timeout, true);
      assert.equal(result.details.cleanup_unknown, true);
      assert.equal(result.details.timed_out, mode === "timeout");
      assert.equal(result.details.aborted, mode !== "timeout");
      assert.equal(result.isError, true);
      assert.equal(local.activeProcesses(), 0);
      assert.ok(performance.now() - started < 3000);
    } finally {
      controller.abort();
      if (pid) {
        try { process.kill(-pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      await work.catch(() => {});
    }
  }
});

test("a missing working directory fails promptly and preserves nonzero exit status", async (t) => {
  const { tool } = await tools(t);
  await assert.rejects(tool("bash").execute({ command: "pwd", cwd: "absent" }, { callId: "absent" }), /ENOENT/);
  const result = await tool("bash").execute({ command: "printf failure >&2; exit 7" }, { callId: "failure" });
  assert.equal(result.details.exit_code, 7);
  assert.equal(result.isError, true);
});

test("commands exclude credential aliases from inherited and overridden environments", async (t) => {
  const prior = process.env.CTF_TEST_CUSTOM_INHERITED;
  process.env.CTF_TEST_CUSTOM_INHERITED = " synthetic-custom-secret ";
  t.after(() => {
    if (prior === undefined) delete process.env.CTF_TEST_CUSTOM_INHERITED;
    else process.env.CTF_TEST_CUSTOM_INHERITED = prior;
  });
  const { tool } = await tools(t, {
    env: { CTF_TEST_CUSTOM_OVERRIDE: "synthetic-custom-secret", ARENA_SOLVER_TOKEN: "synthetic-token",
      CTF_TEST_PUBLIC_VALUE: "public-fixture" },
    secrets: ["synthetic-custom-secret"],
  });
  const result = await tool("bash").execute({ command: "printf '%s|%s|%s|%s' \"${CTF_TEST_CUSTOM_INHERITED-unset}\" \"${CTF_TEST_CUSTOM_OVERRIDE-unset}\" \"${ARENA_SOLVER_TOKEN-unset}\" \"$CTF_TEST_PUBLIC_VALUE\"" }, { callId: "environment" });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /^unset\|unset\|unset\|public-fixture\n/);
});

test("Linux recovery stops persisted shell groups after their Node host is SIGKILLed", { skip: process.platform !== "linux" }, async (t) => {
  const { cwd, local } = await tools(t);
  const moduleUrl = new URL("../src/local-tools.mjs", import.meta.url).href;
  const source = `import { createLocalTools } from ${JSON.stringify(moduleUrl)};
    const local = createLocalTools({ cwd: ${JSON.stringify(cwd)} });
    await local.tools[0].execute({ command: 'echo $$ > shell.pid; sleep 60 & echo $! > descendant.pid; wait' }, { callId: 'crash' });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let pid;
  const deadline = Date.now() + 10000;
  while (!pid) {
    try { pid = Number(await readFile(join(cwd, "descendant.pid"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (Date.now() > deadline) throw new Error("Synthetic shell did not start");
    if (!pid) await new Promise((accept) => setTimeout(accept, 10));
  }
  child.kill("SIGKILL");
  await new Promise((accept) => child.once("exit", accept));
  const recovered = await local.recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].outcome, "stopped");
  let state;
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    state = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/)[0];
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.ok(state === undefined || state === "Z" || state === "X");
  assert.deepEqual(await local.recover(), []);
});
