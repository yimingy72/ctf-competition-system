import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ContestRun } from "../src/coordinator.mjs";
import { Board } from "../src/board.mjs";
import { Resources } from "../src/resources.mjs";
import { ScriptedPool } from "./helpers/scripted-pool.mjs";
import { startFakeArena } from "./helpers/fake-arena.mjs";

const root = fileURLToPath(new URL("../.data/tests/", import.meta.url));

async function setup(t, challenges = [{ unique_code: "one", flag: "flag{one}" }],
  { beforeStart, mode = "attempt", initialWorkers = 20 } = {}) {
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(join(root, "coordinator-"));
  const arena = await startFakeArena({ challenges, mode });
  const config = { workDir, model: { apiKey: "test-model-key" },
    arena: { baseUrl: arena.baseUrl, token: arena.token, mode, identity: "test-attempt", expiresAt: null } };
  const board = new Board({ path: join(workDir, "blackboard.sqlite"), initialWorkers });
  let pool;
  const poolFactory = async (options) => { pool = new ScriptedPool(options); return pool; };
  const run = await ContestRun.create(config, { board, poolFactory });
  t.after(async () => {
    await run.stop("test_complete");
    await arena.close();
    await rm(workDir, { recursive: true, force: true });
  });
  await beforeStart?.(arena, run);
  await run.start();
  const lead = (action, args) => run.board.execute("lead", action, { request_id: randomUUID(), ...args });
  const create = (code, extra = {}) => lead("create_challenge", { unique_code: code, title: code, ready: false, ...extra });
  async function pump() {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!run.pumping) await run.pump();
      await delay(1);
      if (!run.pumping && !run.scheduled) return;
    }
  }
  async function review(challengeId, flag) {
    const challenge = run.board.challenge(challengeId);
    const worker = challenge.owner_id;
    return run.board.execute(worker, "submit_review", { request_id: randomUUID(), challenge_id: challengeId,
      expected_revision: challenge.revision, flag, summary: "Local synthetic candidate" }, run.board.context(worker));
  }
  async function submit(challengeId, flag, callId = randomUUID()) {
    const candidate = await review(challengeId, flag);
    const current = run.board.challenge(challengeId);
    return run.submit({ challenge_id: challengeId, candidate_id: candidate.candidate.id,
      review_revision: current.review_revision, expected_revision: current.revision }, callId);
  }
  return { workDir, arena, config, run, pool, poolFactory, lead, create, pump, review, submit };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(10);
  }
}

function notificationPayload(notice) {
  return JSON.parse(notice.text.slice(notice.text.indexOf("{")));
}

test("complete local contest performs start, candidate review, receipt, release and explicit finish", async (t) => {
  const { run, pool, arena, create, pump, submit } = await setup(t);
  assert.equal(run.board.workers().length, 20);
  assert.equal(pool.status().length, 21);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  assert.equal(run.board.challenge(challenge.id).phase, "solving");
  const submission = await submit(challenge.id, "flag{one}");
  assert.equal(submission.outcome, "accepted");
  assert.equal(submission.submission_id !== undefined, true);
  assert.equal(Object.hasOwn(submission, "challenge"), false);
  await pump();
  assert.equal(run.board.challenge(challenge.id).phase, "completed");
  assert.equal(run.board.challenge(challenge.id).members.length, 0);
  assert.equal(run.board.getMeta("cumulative_score"), 100);
  assert.equal(arena.stats.finishes, 0);
  await run.finish("All synthetic challenges completed");
  assert.equal(arena.stats.finishes, 1);
});

test("a single pending start receipt is reconciled before dispatch", async (t) => {
  const { run, arena, create, pump } = await setup(t, [{ unique_code: "one", flag: "flag{one}", container: true }]);
  const challenge = create("one");
  arena.setFault("start", { kind: "pending" });
  await run.startChallenge(challenge.id);
  await pump();
  assert.equal(run.board.challenge(challenge.id).members.length, 1);
  assert.equal(run.board.challenge(challenge.id).ready, true);
  assert.equal(run.board.challenge(challenge.id).environment.status, "active");
});

test("an unknown start outcome is retried once with the same idempotent start", async (t) => {
  const { run, arena, create, pump } = await setup(t, [
    { unique_code: "one", flag: "flag{one}", container: true },
  ]);
  const challenge = create("one");
  arena.setFault("start", { kind: "disconnect" });
  await run.startChallenge(challenge.id);
  await pump();
  assert.equal(run.board.challenge(challenge.id).environment.status, "active");
  assert.equal(run.board.challenge(challenge.id).members.length, 1);
});

test("unrecognized start response cannot make a task dispatchable", async (t) => {
  const { run, create, pump } = await setup(t, [{ unique_code: "one", flag: "flag{one}", container: true }]);
  const challenge = create("one");
  run.arena.start = async () => ({ container_status: "failed", container: true });
  await run.startChallenge(challenge.id).catch(() => {});
  await pump();
  assert.equal(run.board.challenge(challenge.id).ready, false);
  assert.equal(run.board.challenge(challenge.id).members.length, 0);
});

test("review and failure facts notify Lead and the same challenge team", async (t) => {
  const { run, pool, create, pump, review } = await setup(t);
  const challenge = create("one", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const initialTeam = run.board.challenge(challenge.id).members.map((member) => member.worker_id);
  assert.equal(initialTeam.length, 2);
  pool.notifications.length = 0;
  const candidate = await review(challenge.id, "wrong");
  await pump();
  assert.ok(pool.notifications.some((notice) => notice.id === "lead" && notice.text.includes("核验")));
  assert.ok(pool.notifications.some((notice) => notice.id === initialTeam[1] && notice.text.includes("reviewing")));
  const current = run.board.challenge(challenge.id);
  const result = await run.submit({ challenge_id: challenge.id, candidate_id: candidate.candidate.id,
    review_revision: current.review_revision, expected_revision: current.revision }, randomUUID());
  await pump();
  assert.equal(result.outcome, "rejected");
  const retried = run.board.challenge(challenge.id);
  assert.equal(retried.phase, "solving");
  assert.ok(retried.facts.some((fact) => fact.statement.includes("incorrect")));
  assert.deepEqual(retried.members.map((member) => member.worker_id), initialTeam);
});

test("simultaneous review and deferral events produce one Lead decision batch", async (t) => {
  const { run, pool, create, pump, review } = await setup(t, [
    { unique_code: "review", flag: "flag{review}", container: false },
    { unique_code: "defer", flag: "flag{defer}", container: false },
  ]);
  const reviewChallenge = create("review");
  const deferChallenge = create("defer");
  await run.startChallenge(reviewChallenge.id);
  await run.startChallenge(deferChallenge.id);
  await pump();
  pool.notifications.length = 0;

  await review(reviewChallenge.id, "flag{review}");
  const deferCurrent = run.board.challenge(deferChallenge.id);
  run.board.execute(deferCurrent.owner_id, "request_deferral", {
    request_id: randomUUID(),
    challenge_id: deferChallenge.id,
    expected_revision: deferCurrent.revision,
    reason: "Synthetic blocker for batched Lead decision",
  }, run.board.context(deferCurrent.owner_id));
  await pump();

  const batches = pool.notifications.filter(notice => notice.id === "lead"
    && notice.eventId.startsWith("lead-batch:"));
  assert.equal(batches.length, 1);
  assert.match(batches[0].text, /review_required/);
  assert.match(batches[0].text, /deferral_requested/);
  assert.match(batches[0].text, /"entity":"candidate"/);
  assert.match(batches[0].text, /"entity":"fact"/);
  assert.ok(batches[0].text.includes(reviewChallenge.id));
  assert.ok(batches[0].text.includes(deferChallenge.id));
});

test("a hard primary in assembling immediately notifies Lead and keeps assistance broadcastable", async (t) => {
  const { run, pool, create, pump } = await setup(t, [
    { unique_code: "hard", flag: "flag{hard}", container: false },
  ]);
  await pump();
  const workers = run.board.workers();
  const primary = workers[0];
  const broadcastWorker = workers[1];
  for (const worker of workers) {
    run.board._save("worker", {
      ...worker,
      status: worker.id === primary.id ? "idle" : worker.id === broadcastWorker.id ? "idle" : "failed",
      has_worked: worker.id === broadcastWorker.id,
      active: false,
      assignment_id: null,
    });
  }
  run.resources.snapshot = async () => ({
    cpu: { quota_cpus: 4 },
    memory: { limit_bytes: 6 * 1024 ** 3 },
    disk: { available_bytes: 1024 },
    event_loop: { p99_ms: 1 },
    execution: { workers: run.board.workers(), sessions: run.pool.status() },
  });
  run.started = false;
  const challenge = create("hard", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  run.board._assign(run.board.workers().find(worker => worker.id === primary.id),
    run.board._challenge(challenge.id));
  run.started = true;
  await pump();

  const assembling = run.board.challenge(challenge.id);
  assert.equal(assembling.phase, "assembling");
  assert.equal(assembling.members.length, 1);
  assert.equal(assembling.needs_assistance, true);
  const leadNotice = pool.notifications.find(notice => notice.id === "lead"
    && notice.eventId.startsWith("lead-needs-assistance:"));
  assert.ok(leadNotice);
  assert.match(leadNotice.text, /新题仍优先/);
  assert.match(leadNotice.text, /grow_workers/);
  assert.match(leadNotice.text, /challenges_need_assistance/);
  assert.match(leadNotice.text, /open_assistance_slots/);
  const broadcast = pool.notifications.find(notice => notice.id === broadcastWorker.id
    && notice.text.includes("没有新题时再领取援助"));
  assert.ok(broadcast);
  assert.match(broadcast.text, /new challenges before assistance/);
  assert.match(broadcast.text, /Lead-defined priority 0 highest/);
  assert.match(broadcast.text, /offline metadata is shown for Worker selection/);

  await pool.begin(primary.id);
  await pool.idle(primary.id);
  await pump();
  assert.ok(pool.notifications.some(notice => notice.id === primary.id
    && notice.text.includes("本题仍在解题中")));

  run.retryDelayBaseMs = 0;
  await pool.begin(primary.id);
  await pool.error(primary.id, "Synthetic assembling retry");
  await waitFor(() => pool.notifications.some(notice => notice.id === primary.id
    && notice.text.includes("上次模型回合失败")), "assembling session retry");
});

test("twenty assembling hard primaries produce one Lead notice and one resource sample", async (t) => {
  const definitions = Array.from({ length: 20 }, (_, index) => ({
    unique_code: `hard-${index}`,
    flag: `flag{hard-${index}}`,
    container: false,
  }));
  const { run, pool, create, pump } = await setup(t, definitions);
  await pump();
  run.started = false;
  const challenges = definitions.map(item => create(item.unique_code, { difficulty: "hard" }));
  for (const challenge of challenges) await run.startChallenge(challenge.id);
  const workers = run.board.workers();
  for (const [index, challenge] of challenges.entries()) {
    run.board._assign(workers[index], run.board._challenge(challenge.id));
  }
  let samples = 0;
  run.resources.snapshot = async () => {
    samples += 1;
    return {
      cpu: { quota_cpus: 4 },
      memory: { limit_bytes: 6 * 1024 ** 3 },
      disk: { available_bytes: 1024 },
      event_loop: { p99_ms: 1 },
      execution: { workers: run.board.workers(), sessions: run.pool.status() },
    };
  };
  run.started = true;
  await pump();

  const notices = pool.notifications.filter(notice => notice.id === "lead"
    && notice.eventId.startsWith("lead-needs-assistance:"));
  assert.equal(notices.length, 1);
  assert.equal(samples, 1);
  assert.match(notices[0].text, /"challenge_count":20/);
  for (const challenge of challenges) assert.ok(notices[0].text.includes(challenge.id));
});

test("assistance requests reach Lead when no idle Worker can satisfy the new slots", async (t) => {
  const { run, pool, create, pump } = await setup(t, undefined, { initialWorkers: 1 });
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const owner = run.board.challenge(challenge.id).owner_id;
  assert.equal(run.board.challenge(challenge.id).members.length, 1);
  assert.equal(run.board.workers().filter(worker => worker.status === "idle").length, 0);
  pool.notifications.length = 0;
  let samples = 0;
  run.resources.snapshot = async () => {
    samples += 1;
    return {
      cpu: { quota_cpus: 4 },
      memory: { limit_bytes: 6 * 1024 ** 3 },
      disk: { available_bytes: 1024 },
      event_loop: { p99_ms: 1 },
      execution: { workers: run.board.workers(), sessions: run.pool.status() },
    };
  };

  let current = run.board.challenge(challenge.id);
  const blocker = run.board.execute(owner, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    expected_revision: current.revision,
    statement: "The only current path is blocked on an unavailable fixture generator",
    evidence: [{ type: "text", summary: "Synthetic concrete blocker" }],
  }, run.board.context(owner)).fact;
  current = run.board.challenge(challenge.id);
  run.board.execute(owner, "request_assistance", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    expected_revision: current.revision,
    reason: "A second Worker can take the independent path",
    blocker_fact_id: blocker.id,
  }, run.board.context(owner));
  await pump();

  const notices = () => pool.notifications.filter(notice => notice.id === "lead"
    && notice.eventId.startsWith("lead-needs-assistance:"));
  assert.equal(run.board.challenge(challenge.id).needs_assistance, true);
  assert.equal(notices().length, 1);
  assert.match(notices()[0].text, /grow_workers/);
  assert.match(notices()[0].text, /"idle_worker_count":0/);
  assert.match(notices()[0].text, /"open_assistance_slots":1/);
  assert.equal(samples, 1);

  current = run.board.challenge(challenge.id);
  const direction = run.board.execute(owner, "post_intent", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    expected_revision: current.revision,
    statement: "Validate the parser through an independent fixture",
    based_on: [blocker.id],
    expected: "A reproducible parser result",
    method: "Run the independent fixture in a second Worker",
    parallel: true,
    parallel_key: "independent-fixture",
  }, run.board.context(owner)).intent;
  current = run.board.challenge(challenge.id);
  run.board.execute(owner, "request_assistance", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    expected_revision: current.revision,
    reason: "The new independent fixture path is ready",
    intent_ids: [direction.id],
  }, run.board.context(owner));
  await pump();

  assert.equal(notices().length, 2);
  assert.match(notices()[1].text, /"open_assistance_slots":2/);
  assert.equal(samples, 2);
});

test("a new parallel Intent reaches Lead when no idle Worker can take the direction", async (t) => {
  const { run, pool, create, pump } = await setup(t, undefined, { initialWorkers: 1 });
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const owner = run.board.challenge(challenge.id).owner_id;
  await pool.begin(owner);
  const context = run.board.context(owner);
  let current = run.board.challenge(challenge.id);
  const posted = run.board.execute(owner, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    expected_revision: current.revision,
    statement: "The parser exposes an independent branch",
    evidence: [{ type: "text", summary: "Local synthetic observation" }],
  }, context);
  await pump();
  pool.notifications.length = 0;
  let samples = 0;
  run.resources.snapshot = async () => {
    samples += 1;
    return {
      cpu: { quota_cpus: 4 },
      memory: { limit_bytes: 6 * 1024 ** 3 },
      disk: { available_bytes: 1024 },
      event_loop: { p99_ms: 1 },
      execution: { workers: run.board.workers(), sessions: run.pool.status() },
    };
  };

  current = run.board.challenge(challenge.id);
  run.board.execute(owner, "post_intent", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    expected_revision: current.revision,
    statement: "Test the independent parser branch",
    based_on: [posted.fact.id],
    expected: "An independent validation path",
    method: "Run a focused local probe in a second Worker",
    parallel: true,
    parallel_key: "parser-branch",
  }, context);
  await pump();

  const notice = pool.notifications.find(item => item.id === "lead"
    && item.eventId.startsWith("lead-needs-assistance:"));
  assert.ok(notice);
  assert.match(notice.text, /grow_workers/);
  assert.match(notice.text, /"open_assistance_slots":1/);
  assert.equal(samples, 1);
});

test("dispatch consuming the last idle Worker exposes the assistance gap to Lead", async (t) => {
  const { run, pool, create, pump } = await setup(t, [
    { unique_code: "a-assisted", flag: "flag{a}", container: false },
    { unique_code: "b-new", flag: "flag{b}", container: false },
  ], { initialWorkers: 2 });
  const assisted = create("a-assisted", { priority: 2 });
  await run.startChallenge(assisted.id);
  await pump();
  const owner = run.board.challenge(assisted.id).owner_id;
  pool.notifications.length = 0;
  let samples = 0;
  run.resources.snapshot = async () => {
    samples += 1;
    return {
      cpu: { quota_cpus: 4 },
      memory: { limit_bytes: 6 * 1024 ** 3 },
      disk: { available_bytes: 1024 },
      event_loop: { p99_ms: 1 },
      execution: { workers: run.board.workers(), sessions: run.pool.status() },
    };
  };

  run.started = false;
  let current = run.board.challenge(assisted.id);
  const blocker = run.board.execute(owner, "post_fact", {
    request_id: randomUUID(),
    challenge_id: assisted.id,
    expected_revision: current.revision,
    statement: "The active path is blocked and needs an independent probe",
    evidence: [{ type: "text", summary: "Synthetic blocker for dispatch gap" }],
  }, run.board.context(owner)).fact;
  current = run.board.challenge(assisted.id);
  run.board.execute(owner, "request_assistance", {
    request_id: randomUUID(),
    challenge_id: assisted.id,
    expected_revision: current.revision,
    reason: "A second Worker can take the independent path",
    blocker_fact_id: blocker.id,
  }, run.board.context(owner));
  const newer = create("b-new", { priority: 0 });
  await run.startChallenge(newer.id);
  run.board.execute("platform", "dispatch", {});
  assert.equal(run.board.challenge(assisted.id).members.length, 1);
  assert.equal(run.board.challenge(newer.id).members.length, 1);
  assert.equal(run.board.workers().filter(worker => worker.status === "idle").length, 0);

  run.started = true;
  await pump();

  const notice = pool.notifications.find(item => item.id === "lead"
    && item.eventId.startsWith("lead-needs-assistance:"));
  assert.ok(notice);
  assert.match(notice.text, /grow_workers/);
  assert.ok(notice.text.includes(assisted.id));
  assert.match(notice.text, /"idle_worker_count":0/);
  assert.match(notice.text, /"unclaimed_new_challenges":\[\]/);
  assert.equal(samples, 1);

  await pump();
  assert.equal(pool.notifications.filter(item => item.id === "lead"
    && item.eventId.startsWith("lead-needs-assistance:")).length, 1);
  assert.equal(samples, 1);
});

test("new-task backlog with no assignable Worker notifies Lead once per changed backlog", async (t) => {
  const { run, pool, create, pump } = await setup(t, [
    { unique_code: "first", flag: "flag{first}", container: false },
    { unique_code: "second", flag: "flag{second}", container: false },
    { unique_code: "third", flag: "flag{third}", container: false },
  ], { initialWorkers: 1 });
  let samples = 0;
  run.resources.snapshot = async () => {
    samples += 1;
    return {
      cpu: { quota_cpus: 4 },
      memory: { limit_bytes: 6 * 1024 ** 3 },
      disk: { available_bytes: 1024 },
      event_loop: { p99_ms: 1 },
      execution: { workers: run.board.workers(), sessions: run.pool.status() },
    };
  };

  run.started = false;
  const first = create("first", { priority: 0 });
  const second = create("second", { priority: 1 });
  await run.startChallenge(first.id);
  await run.startChallenge(second.id);
  run.started = true;
  await pump();

  const backlogNotices = () => pool.notifications.filter(notice => notice.id === "lead"
    && notice.eventId.startsWith("lead-new-task-backlog:"));
  assert.equal(backlogNotices().length, 1);
  assert.ok(backlogNotices()[0].text.includes(second.id));
  assert.match(backlogNotices()[0].text, /"idle_worker_count":0/);
  assert.match(backlogNotices()[0].text, /"unclaimed_new_challenge_count":1/);
  assert.equal(samples, 1);

  await pump();
  assert.equal(backlogNotices().length, 1);
  assert.equal(samples, 1);

  run.started = false;
  const third = create("third", { priority: 2 });
  await run.startChallenge(third.id);
  run.started = true;
  await pump();
  assert.equal(backlogNotices().length, 2);
  assert.ok(backlogNotices()[1].text.includes(third.id));
  assert.match(backlogNotices()[1].text, /"unclaimed_new_challenge_count":2/);
  assert.equal(samples, 2);
});

test("backlog escalates to Lead when every existing idle Worker exhausts available notices", async (t) => {
  const { run, pool, create, pump } = await setup(t, [
    { unique_code: "seed", flag: "flag{seed}", container: false },
    { unique_code: "backlog", flag: "flag{backlog}", container: false },
  ], { initialWorkers: 1 });
  run.resources.snapshot = async () => ({
    cpu: { quota_cpus: 4 },
    memory: { limit_bytes: 6 * 1024 ** 3 },
    disk: { available_bytes: 1024 },
    event_loop: { p99_ms: 1 },
    execution: { workers: run.board.workers(), sessions: run.pool.status() },
  });

  const seed = create("seed");
  await run.startChallenge(seed.id);
  await pump();
  const worker = run.board.challenge(seed.id).owner_id;
  run.started = false;
  run.board.execute("lead", "defer", {
    request_id: randomUUID(),
    challenge_id: seed.id,
    expected_revision: run.board.challenge(seed.id).revision,
    reason: "Free the worked Worker for backlog coverage",
  });
  run.board.execute("platform", "release_finished", {});
  assert.equal(run.board.workers().find(item => item.id === worker).status, "idle");

  const backlog = create("backlog");
  await run.startChallenge(backlog.id);
  const backlogNotices = () => pool.notifications.filter(notice => notice.id === "lead"
    && notice.eventId.startsWith("lead-new-task-backlog:"));
  await run.pump();
  await run.pump();
  assert.equal(backlogNotices().length, 0);
  assert.equal(pool.notifications.filter(notice => notice.id === worker
    && notice.text.includes("有可领取工作")).length, 2);

  await run.pump();
  run.started = true;
  assert.equal(backlogNotices().length, 1);
  assert.ok(backlogNotices()[0].text.includes(backlog.id));
  assert.match(backlogNotices()[0].text, /"active_available_notifications":0/);
});

test("backlog escalates when an available notice is stale instead of delivered", async (t) => {
  const { run, pool, create } = await setup(t, [
    { unique_code: "seed", flag: "flag{seed}", container: false },
    { unique_code: "backlog", flag: "flag{backlog}", container: false },
  ], { initialWorkers: 1 });
  const seed = create("seed");
  await run.startChallenge(seed.id);
  await run.pump();
  const worker = run.board.challenge(seed.id).owner_id;
  run.started = false;
  run.board.execute("lead", "defer", {
    request_id: randomUUID(),
    challenge_id: seed.id,
    expected_revision: run.board.challenge(seed.id).revision,
    reason: "Free the worked Worker",
  });
  run.board.execute("platform", "release_finished", {});
  const backlog = create("backlog");
  await run.startChallenge(backlog.id);

  const notify = pool.notify.bind(pool);
  pool.notify = async (id, text, options) => id !== "lead" && options.eventId?.startsWith("available:")
    ? { delivered: false, stale: true }
    : notify(id, text, options);
  await run.pump();
  run.started = true;

  const notice = pool.notifications.find(item => item.id === "lead"
    && item.eventId.startsWith("lead-new-task-backlog:"));
  assert.ok(notice);
  assert.ok(notice.text.includes(backlog.id));
  assert.match(notice.text, /"active_available_notifications":0/);
  assert.equal(pool.notifications.some(item => item.id === worker
    && item.text.includes("有可领取工作")), false);
});

test("backlog decision re-reads Board after asynchronous resource sampling", async (t) => {
  const { run, create } = await setup(t, [
    { unique_code: "first", flag: "flag{first}", container: false },
    { unique_code: "second", flag: "flag{second}", container: false },
  ], { initialWorkers: 1 });
  run.started = false;
  const first = create("first", { priority: 0 });
  const second = create("second", { priority: 1 });
  await run.startChallenge(first.id);
  await run.startChallenge(second.id);
  run.resources.snapshot = async () => {
    const grown = run.board.execute("lead", "grow_workers", {
      request_id: randomUUID(),
      target_total: 2,
    });
    run.board.execute("platform", "worker_ready", { worker_id: grown.starting[0] });
    run.board.execute("platform", "dispatch", {});
    return {
      cpu: { quota_cpus: 4 },
      memory: { limit_bytes: 6 * 1024 ** 3 },
      disk: { available_bytes: 1024 },
      event_loop: { p99_ms: 1 },
      execution: { workers: run.board.workers(), sessions: run.pool.status() },
    };
  };

  await run.pump();
  run.started = true;
  assert.equal(run.board.available().new_challenges.length, 0);
  assert.equal(run.board.challenge(second.id).members.length, 1);
  assert.equal(run.board.getMeta("lead_new_task_backlog"), null);
});

test("automatic continuations require new local work, not peer revisions or empty board reads", async (t) => {
  const { run, pool, create, pump, lead } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  await pool.begin(worker);
  for (let index = 0; index < 3; index++) {
    await pool.idle(worker);
    await pump();
  }
  const continuations = () => pool.notifications.filter(notice => notice.id === worker
    && notice.text.includes("本题仍在解题中"));
  assert.equal(continuations().length, 2);
  assert.ok(pool.notifications.some(notice => notice.id === "lead"
    && notice.text.includes("两次自动续跑")));

  const context = run.board.context(worker);
  lead("post_fact", { challenge_id: challenge.id, statement: "peer fixture discovery",
    evidence: [{ type: "text", summary: "fresh peer evidence" }] });
  await pump();
  assert.ok(pool.notifications.some(notice => notice.id === worker && notice.text.includes("peer fixture discovery")));
  for (const event of [
    { tool: "board_read", context },
    { tool: "record_fact", context },
    { tool: "bash", context: { ...context, assignment_id: "old-assignment" } },
    { tool: "bash", context: { ...context, environment_generation: context.environment_generation + 1 } },
    { tool: "bash", context, isError: true },
  ]) {
    run.sessionEvent({ type: "tool_end", agentId: worker, callId: randomUUID(), ...event });
    await pool.idle(worker);
    await pump();
  }
  assert.equal(continuations().length, 2);

  run.sessionEvent({ type: "tool_end", agentId: worker, tool: "bash", context,
    callId: "new-local-execution", isError: false });
  for (let index = 0; index < 3; index++) {
    await pool.idle(worker);
    await pump();
  }
  assert.equal(continuations().length, 4);
  assert.equal(new Set(continuations().map(notice => notice.eventId)).size, 4);
});

test("an idle Worker receives a bounded number of notices for the same available work", async (t) => {
  const { run, pool, pump } = await setup(t, [
    { unique_code: "first", flag: "flag{first}" },
    { unique_code: "second", flag: "flag{second}" },
  ], {
    initialWorkers: 1,
    beforeStart: (_arena, preparedRun) => {
      const board = preparedRun.board;
      const request = () => randomUUID();
      for (const worker of board.workers()) {
        board.execute("platform", "worker_ready", { worker_id: worker.id });
      }
      const first = board.execute("lead", "create_challenge", {
        request_id: request(), unique_code: "first", title: "first", ready: false,
      });
      board.execute("platform", "set_environment", {
        challenge_id: first.id, status: "active", ready: true, online: false,
      });
      const assignment = board.execute("platform", "dispatch").assignments[0];
      const current = board.challenge(first.id);
      const review = board.execute(assignment.worker_id, "submit_review", {
        request_id: request(), challenge_id: first.id, expected_revision: current.revision,
        flag: "flag{first}", summary: "fixture",
      }, board.context(assignment.worker_id));
      const submission = board.execute("lead", "begin_submission", {
        request_id: request(), challenge_id: first.id, candidate_id: review.candidate.id,
        review_revision: review.challenge.review_revision,
        expected_revision: board.challenge(first.id).revision,
      });
      board.execute("platform", "submission_result", {
        submission_id: submission.submission.id, status: "accepted",
        challenge_completed: true, receipt: { correct: true },
      });
      board.execute("platform", "release_finished", {});
      const second = board.execute("lead", "create_challenge", {
        request_id: request(), unique_code: "second", title: "second", ready: false,
      });
      board.execute("platform", "set_environment", {
        challenge_id: second.id, status: "active", ready: true, online: false,
      });
    },
  });
  const worker = run.board.workers()[0];
  await pump();
  for (let index = 0; index < 3; index++) {
    await pool.begin(worker.id);
    await pool.idle(worker.id);
    await pump();
  }
  const available = pool.notifications.filter(notice => notice.id === worker.id
    && notice.text.includes("有可领取工作"));
  assert.equal(available.length, 2);
});

test("a review pauses an active Worker without starting another model turn", async (t) => {
  const { run, pool, create, pump, review } = await setup(t, undefined, { initialWorkers: 2 });
  const challenge = create("one", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const members = run.board.challenge(challenge.id).members;
  assert.equal(members.length, 2);
  const worker = members.find(member => member.role === "primary").worker_id;
  const assistant = members.find(member => member.role === "assistant").worker_id;
  await pool.begin(worker);
  await pool.begin(assistant);
  review(challenge.id, "flag{one}");
  await pump();
  await waitFor(() => pool.abortCalls.includes(assistant), "review pause abort");
  assert.equal(pool.abortCalls.includes(worker), false);
  const pause = pool.notifications.find(notice => notice.id === assistant
    && notice.eventId.startsWith("board:")
    && notice.text.includes("等待 Lead 反馈"));
  assert.ok(pause);
  assert.equal(pause.triggerTurn, false);
});

test("one Worker recovery failure is quarantined without stopping healthy Workers", async (t) => {
  const { run, pool } = await setup(t);
  const originalEnsure = pool.ensure.bind(pool);
  pool.ensure = async (id, role) => {
    if (id === "worker-2") throw new Error("Synthetic corrupt session");
    return originalEnsure(id, role);
  };
  const result = await run.prepareWorkers();
  assert.deepEqual(result.map(item => item.worker_id), ["worker-2"]);
  assert.equal(run.board.workers().find(worker => worker.id === "worker-2").status, "failed");
  assert.equal(run.board.workers().find(worker => worker.id === "worker-1").status, "idle");
  assert.ok(pool.notifications.some(notice => notice.id === "lead"
    && notice.text.includes("Synthetic corrupt session")));
});

test("session errors stop after three retries, notify Lead once, and reset after idle", async (t) => {
  const { run, pool, create, pump } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  run.retryDelayBaseMs = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    await pool.begin(worker);
    await pool.error(worker, `Synthetic error ${attempt + 1}`);
    await delay(10);
  }
  await waitFor(() => pool.notifications.some(notice => notice.id === "lead"
    && notice.text.includes("有限重试后仍持续失败")), "Lead retry exhaustion notice");
  assert.equal(run.retries.get(worker), 4);
  assert.equal(run.retryTimers.has(worker), false);
  assert.equal(run.retryExhausted.has(worker), true);
  assert.equal(pool.notifications.filter(notice => notice.id === worker
    && notice.text.includes("上次模型回合失败")).length, 3);
  const exhaustionNotices = pool.notifications.filter(notice => notice.id === "lead"
    && notice.text.includes("有限重试后仍持续失败")).length;

  await pool.begin(worker);
  await pool.error(worker, "Synthetic exhausted error");
  await delay(10);
  assert.equal(pool.notifications.filter(notice => notice.id === "lead"
    && notice.text.includes("有限重试后仍持续失败")).length, exhaustionNotices);

  await pool.idle(worker);
  assert.equal(run.retries.has(worker), false);
  assert.equal(run.retryExhausted.has(worker), false);
  await pool.begin(worker);
  await pool.error(worker, "Synthetic post-idle error");
  await delay(10);
  assert.equal(run.retries.get(worker), 1);
});

test("a Worker context identity mismatch is quarantined without retry churn", async (t) => {
  const { run, pool, create, pump } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  await pool.begin(worker);
  await pool.error(worker, `Worker context identity mismatch for ${worker}`);
  await waitFor(() => run.board.workers().find(item => item.id === worker)?.status === "degraded",
    "identity mismatch quarantine");
  await pump();
  assert.equal(run.retries.has(worker), false);
  assert.equal(run.retryTimers.has(worker), false);
  assert.equal(run.board.challenge(challenge.id).members.length, 0);
  assert.ok(pool.notifications.some(notice => notice.id === "lead"
    && notice.text.includes("不可自愈错误")
    && notice.text.includes("identity mismatch")));
});

test("unknown accepted receipt stays pending until progress reconciliation and never reposts", async (t) => {
  const { run, arena, create, pump, submit } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  arena.setFault("submit", { kind: "accepted_disconnect" });
  assert.equal((await submit(challenge.id, "flag{one}")).outcome, "unknown");
  assert.equal(run.board.challenge(challenge.id).phase, "reviewing");
  await assert.rejects(run.finish("Try finishing"), /pending flag submissions/);
  assert.equal(arena.stats.finishes, 0);
  await run.reconcilePendingSubmissions();
  assert.equal(run.board.challenge(challenge.id).phase, "completed");
  assert.equal(arena.stats.submits, 1);
});

test("a lost unknown submission can retry the same candidate and complete", async (t) => {
  const { run, arena, create, pump, submit } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  arena.setFault("submit", { kind: "disconnect" });
  assert.equal((await submit(challenge.id, "flag{one}")).outcome, "unknown");
  const unresolved = run.board.challenge(challenge.id).submissions.find(item => item.status === "unknown");
  assert.equal(unresolved.candidate_id, run.board.challenge(challenge.id).candidates[0].id);
  await assert.rejects(run.finish("Try finishing"), /pending flag submissions/);
  assert.equal((await submit(challenge.id, "flag{one}")).outcome, "accepted");
  assert.equal(arena.stats.submits, 2);
  assert.equal(run.board.challenge(challenge.id).phase, "completed");
});

test("unknown partial flag uses authoritative progress after a duplicate accepted flag", async (t) => {
  const { run, pool, arena, create, pump, submit } = await setup(t, [{
    unique_code: "stages",
    flags: ["flag{first}", "flag{second}", "flag{third}"],
    container: true,
  }]);
  const challenge = create("stages", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  assert.equal((await submit(challenge.id, "flag{first}")).outcome, "accepted");
  assert.equal((await submit(challenge.id, "flag{first}")).outcome, "accepted");
  let current = run.board.challenge(challenge.id);
  assert.equal(current.correct_flag_count, 1);
  assert.equal(current.submissions.filter(item => item.status === "accepted").length, 2);

  arena.setFault("submit", { kind: "accepted_disconnect" });
  assert.equal((await submit(challenge.id, "flag{second}")).outcome, "unknown");
  const pending = run.board.challenge(challenge.id).submissions
    .find(item => item.status === "unknown");
  assert.equal(pending.baseline_correct_flag_count, 1);
  await run.reconcilePendingSubmissions();
  current = run.board.challenge(challenge.id);
  assert.equal(current.correct_flag_count, 2);
  assert.equal(current.submissions.filter(item => item.status === "accepted").length, 3);
  assert.equal(current.phase, "solving");
  assert.equal(current.environment.status, "active");

  await pool.begin(current.owner_id);
  assert.equal((await submit(challenge.id, "flag{third}")).outcome, "accepted");
  current = run.board.challenge(challenge.id);
  assert.equal(current.phase, "completed");
  assert.equal(arena.stats.submits, 4);
});

test("resuming a workdir reconciles a persisted unknown submission without a new POST", async (t) => {
  const { run, config, arena, create, pump, submit } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  arena.setFault("submit", { kind: "accepted_disconnect" });
  await submit(challenge.id, "flag{one}");
  await run.stop("simulated_restart");
  const resumed = await ContestRun.create(config, { poolFactory: (options) => ScriptedPool.create(options) });
  t.after(() => resumed.stop("test_complete"));
  await resumed.start();
  assert.equal(resumed.board.challenge(challenge.id).phase, "completed");
  assert.equal(arena.stats.submits, 1);
  assert.equal(arena.stats.finishes, 0);
});

test("online quota errors come from the arena API and retain the real state for Lead", async (t) => {
  const definitions = ["a", "b", "c", "d"].map((unique_code) => ({ unique_code, flag: `flag{${unique_code}}`, container: true }));
  const { run, arena, pool, create, pump } = await setup(t, definitions);
  const challenges = definitions.map((item) => create(item.unique_code));
  await Promise.all(challenges.slice(0, 3).map((challenge) => run.startChallenge(challenge.id)));
  await assert.rejects(run.startChallenge(challenges[3].id), (error) => error.code === "environment_limit"
    && error.detail.challenges.length === 3);
  await run.flushNotifications();
  const rejected = run.board.challenge(challenges[3].id);
  assert.equal(rejected.ready, false);
  assert.equal(rejected.environment.status, "closed");
  assert.equal(rejected.environment.connection.code, "environment_limit");
  const notice = pool.notifications.find(item => item.id === "lead"
    && item.eventId.startsWith("environment-start-rejected:"));
  assert.ok(notice);
  assert.match(notice.text, /environment_limit/);
  assert.match(notice.text, /active_online_environments/);
  assert.match(notice.text, /api_error/);
  await pump();
  assert.equal(arena.stats.activeMax, 3);
});

test("online start is not locally gated by unprepared offline challenges", async (t) => {
  const { run, create, pump } = await setup(t, [
    { unique_code: "offline", flag: "flag{offline}", container: false },
    { unique_code: "online", flag: "flag{online}", container: true },
  ]);
  const offline = create("offline");
  const online = create("online");
  await run.startChallenge(online.id);
  await pump();
  const started = run.board.challenge(online.id);
  assert.equal(started.phase, "solving");
  assert.equal(run.board.challenge(offline.id).phase, "pending");
  assert.equal(run.board.getMeta(`offline_prepared:${online.id}:${started.generation}`), null);
});

test("catalog normalizes data_plane and available environment states", async (t) => {
  const { run, create, pump } = await setup(t, [
    { unique_code: "offline", flag: "flag{offline}", data_plane: false },
    { unique_code: "ready", flag: "flag{ready}", data_plane: true, container_status: "available" },
  ]);
  const catalog = await run.refreshCatalog();
  assert.equal(catalog.find(item => item.unique_code === "offline").requires_online_environment, false);
  assert.equal(catalog.find(item => item.unique_code === "ready").requires_online_environment, true);
  const offline = create("offline");
  const ready = create("ready");
  await run.startChallenge(offline.id);
  await run.startChallenge(ready.id);
  await pump();
  assert.equal(run.board.challenge(offline.id).environment.status, "active");
  assert.equal(run.board.challenge(ready.id).environment.status, "active");
  assert.equal(run.board.challenge(offline.id).ready, true);
  assert.equal(run.board.challenge(ready.id).ready, true);
});

test("catalog description updates once when official task text changes", async (t) => {
  const definitions = [{
    unique_code: "one",
    flag: "flag{one}",
    container: false,
    description: "Official description version one",
  }];
  const { run, create } = await setup(t, definitions);
  const challenge = create("one");
  await run.refreshCatalog();
  assert.equal(run.board.challenge(challenge.id).description, "Official description version one");

  const initialRevision = run.board.challenge(challenge.id).revision;
  definitions[0].description = "Official description version two";
  await run.refreshCatalog();
  assert.equal(run.board.challenge(challenge.id).description, "Official description version two");
  assert.equal(run.board.challenge(challenge.id).revision, initialRevision + 1);

  const stableRevision = run.board.challenge(challenge.id).revision;
  await run.refreshCatalog();
  assert.equal(run.board.challenge(challenge.id).revision, stableRevision);
});

test("batch offline preparation creates tasks and downloads attachments before dispatch", async (t) => {
  const content = Buffer.from("offline handout");
  const { run, arena, pump } = await setup(t, [{
    unique_code: "offline",
    flag: "flag{offline}",
    container: false,
    handout: { path: "handouts/input.txt", content },
  }]);
  const prepared = await run.prepareOffline();
  assert.equal(prepared.offline_total, 1);
  assert.equal(prepared.prepared, 1);
  assert.equal(prepared.failed, 0);
  const task = prepared.tasks[0];
  assert.equal(task.status, "ready");
  assert.equal(task.materials.status, "ready");
  assert.equal(task.materials.downloaded, 1);
  assert.equal(task.materials.files[0].path, "handouts/input.txt");
  assert.equal(run.board.challenge(task.challenge_id).ready, true);
  assert.deepEqual(await readFile(task.files[0].path), content);
  const manifest = JSON.parse(await readFile(join(task.inputs, "manifest.json"), "utf8"));
  assert.equal(manifest.challenge_id, task.challenge_id);
  assert.equal(manifest.generation, 1);
  assert.equal(manifest.files[0].source_path, "handouts/input.txt");
  assert.equal(manifest.files[0].size, content.length);
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/);
  const marker = run.board.getMeta(`offline_prepared:${task.challenge_id}:1`);
  assert.equal(marker.manifest_sha256.length, 64);
  assert.deepEqual(marker.files, manifest.files);
  const factCount = run.board.challenge(task.challenge_id).facts.length;
  const filesBefore = arena.calls.filter(call => call.operation === "files").length;
  const [second, concurrent] = await Promise.all([run.prepareOffline(), run.prepareOffline()]);
  assert.equal(concurrent, second);
  assert.equal(second.tasks[0].files[0].cached, true);
  assert.equal(arena.calls.filter(call => call.operation === "files").length, filesBefore);
  assert.equal(arena.stats.starts, 1);
  assert.equal(run.board.challenge(task.challenge_id).facts.length, factCount);
  await pump();
});

test("direct offline start does not force attachment preparation", async (t) => {
  const content = Buffer.from("direct offline attachment");
  const { run, pool, create, pump } = await setup(t, [{
    unique_code: "offline",
    flag: "flag{offline}",
    container: false,
    handout: { path: "handouts/direct.bin", content },
  }]);
  const challenge = create("offline");
  await pool.tool("lead", "arena_start", { challenge_id: challenge.id });
  const started = run.board.challenge(challenge.id);
  assert.equal(started.environment.status, "active");
  assert.equal(started.ready, true);
  const marker = run.board.getMeta(`offline_prepared:${challenge.id}:${started.generation}`);
  assert.equal(marker, null);
  const downloaded = await pool.tool("lead", "arena_files", {
    challenge_id: challenge.id,
    path: "handouts/direct.bin",
  });
  assert.deepEqual(await readFile(downloaded.path), content);
  assert.match(downloaded.sha256, /^[0-9a-f]{64}$/);
  await pump();
});

test("explicit preparation detects changed inputs, while arena start remains API-driven", async (t) => {
  const content = Buffer.from("trusted attachment");
  const { run, create, pump } = await setup(t, [
    { unique_code: "offline", flag: "flag{offline}", container: false,
      handout: { path: "handouts/input.txt", content } },
    { unique_code: "online", flag: "flag{online}", container: true },
  ]);
  const prepared = await run.prepareOffline();
  const offline = prepared.tasks[0];
  const online = create("online");
  await writeFile(offline.files[0].path, "tampered");
  const invalid = await run.validatePreparedInputs(run.board.challenge(offline.challenge_id));
  assert.equal(invalid.valid, false);
  assert.equal(invalid.reason, "file_changed");
  await run.startChallenge(online.id);
  await pump();
  assert.equal(run.board.challenge(online.id).phase, "solving");
  const repaired = await run.prepareOffline();
  assert.equal(repaired.tasks[0].files[0].cached, false);
  assert.equal(repaired.tasks[0].files[0].changed, true);
  assert.deepEqual(await readFile(repaired.tasks[0].files[0].path), content);
  assert.equal(run.board.challenge(offline.challenge_id).ready, true);
  await pump();
});

test("ordinary coordinator stop keeps the remote attempt open and logs exclude credentials", async (t) => {
  const { run, arena, workDir } = await setup(t);
  run.log({ type: "redaction-fixture", message: `${arena.token} test-model-key` });
  await run.stop("local_failure");
  assert.equal(arena.stats.finishes, 0);
  const logs = await readFile(join(workDir, "events.jsonl"), "utf8");
  assert.equal(logs.includes(arena.token), false);
  assert.equal(logs.includes("test-model-key"), false);
});

test("nonretryable provider errors release the Worker without consuming retry attempts", async (t) => {
  const { run, pool, create, pump } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  await pool.begin(worker, context);
  await pool.error(worker, "permission_error: insufficient balance", context);
  await pump();
  const released = run.board.challenge(challenge.id);
  assert.equal(released.owner_id, null);
  assert.equal(released.members.some((member) => member.worker_id === worker), false);
  assert.equal(run.board.workers().find((item) => item.id === worker).status, "degraded");
  assert.equal(run.retryTimers.size, 0);
  assert.ok(pool.notifications.some((notice) => notice.id === "lead"
    && notice.text.includes("不可自愈错误")));
});

test("repeated tool signatures emit one progress_stalled event", async (t) => {
  const { run, create, pump } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  const cursor = run.board.getMeta("event_cursor");
  for (let index = 0; index < 3; index++) {
    run.sessionEvent({
      type: "tool_end",
      agentId: worker,
      tool: "bash",
      args_digest: "same-command",
      context,
      isError: false,
    });
  }
  const events = run.board.events(cursor).filter((event) => event.type === "progress.stalled");
  assert.equal(events.length, 1);
  assert.equal(events[0].worker_id, worker);
  assert.equal(events[0].attempts, 3);
});

test("a hard assignment gets one next-turn bootstrap reminder after a real tool execution", async (t) => {
  const { run, pool, create, pump } = await setup(t);
  run.hardBootstrapReminderDelayMs = 20;
  const challenge = create("one", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  pool.notifications.length = 0;

  run.sessionEvent({
    type: "tool_end",
    agentId: worker,
    tool: "bash",
    args_digest: "initial-recon",
    context,
    isError: false,
  });
  await waitFor(() => pool.notifications.some(notice =>
    notice.eventId.startsWith("hard-bootstrap-reminder:")), "hard bootstrap reminder");

  const notices = pool.notifications.filter(notice =>
    notice.eventId.startsWith("hard-bootstrap-reminder:"));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].id, worker);
  assert.equal(notices[0].triggerTurn, true);
  assert.equal(notices[0].deliverAs, "nextTurn");
  assert.match(notices[0].text, /record_fact/);
  assert.match(notices[0].text, /next_intents/);
  assert.deepEqual(pool.abortCalls, []);
  assert.ok(run.board.getMeta(`hard_bootstrap_tool:${context.assignment_id}`));
  assert.ok(run.board.getMeta(`hard_bootstrap_reminder:${context.assignment_id}`));

  await delay(50);
  assert.equal(pool.notifications.filter(notice =>
    notice.eventId.startsWith("hard-bootstrap-reminder:")).length, 1);
});

test("board_read alone does not arm the hard bootstrap reminder", async (t) => {
  const { run, pool, create, pump } = await setup(t);
  run.hardBootstrapReminderDelayMs = 10;
  const challenge = create("one", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  pool.notifications.length = 0;

  run.sessionEvent({
    type: "tool_end",
    agentId: worker,
    tool: "board_read",
    args_digest: "read-task",
    context,
    isError: false,
  });
  await delay(60);

  assert.equal(pool.notifications.some(notice =>
    notice.eventId.startsWith("hard-bootstrap-reminder:")), false);
  assert.equal(run.board.getMeta(`hard_bootstrap_tool:${context.assignment_id}`), null);
});

test("hard bootstrap reminder is suppressed by assignment or teammate progress", async (t) => {
  const { run, pool, create, pump } = await setup(t, [
    { unique_code: "own-progress", flag: "flag{own}" },
    { unique_code: "team-progress", flag: "flag{team}" },
  ]);
  run.hardBootstrapReminderDelayMs = 100;
  const ownChallenge = create("own-progress", { difficulty: "hard" });
  await run.startChallenge(ownChallenge.id);
  await pump();
  let challenge = run.board.challenge(ownChallenge.id);
  let worker = challenge.owner_id;
  let context = run.board.context(worker);
  const ownAssignmentId = context.assignment_id;
  run.sessionEvent({
    type: "tool_end",
    agentId: worker,
    tool: "bash",
    args_digest: "own-recon",
    context,
    isError: false,
  });
  run.board.execute(worker, "post_fact", {
    request_id: randomUUID(),
    challenge_id: ownChallenge.id,
    statement: "The primary recorded an initial observation",
    evidence: [{ type: "text", summary: "Fixture observation" }],
  }, context);
  await pump();

  const teamChallenge = create("team-progress", { difficulty: "hard" });
  await run.startChallenge(teamChallenge.id);
  await pump();
  challenge = run.board.challenge(teamChallenge.id);
  worker = challenge.owner_id;
  context = run.board.context(worker);
  run.sessionEvent({
    type: "tool_end",
    agentId: worker,
    tool: "bash",
    args_digest: "team-recon",
    context,
    isError: false,
  });
  const assistant = challenge.members.find(member => member.worker_id !== worker);
  assert.ok(assistant);
  run.board.execute(assistant.worker_id, "post_fact", {
    request_id: randomUUID(),
    challenge_id: teamChallenge.id,
    statement: "The assistant shared a reusable endpoint",
    evidence: [{ type: "text", summary: "Fixture endpoint response" }],
  }, run.board.context(assistant.worker_id));
  await pump();
  await delay(140);

  const reminders = pool.notifications.filter(notice =>
    notice.eventId.startsWith("hard-bootstrap-reminder:"));
  assert.equal(reminders.length, 0);
  assert.equal(run.board.getMeta(`hard_bootstrap_reminder:${ownAssignmentId}`).status, "suppressed");
  assert.equal(run.board.getMeta(`hard_bootstrap_reminder:${context.assignment_id}`).status, "suppressed");
  assert.equal(run.board.getMeta(`hard_bootstrap_reminder:${context.assignment_id}`).reason, "team_progress");
});

test("later progress withdraws a queued hard bootstrap reminder after delivery failure", async (t) => {
  const { run, pool, create, pump } = await setup(t);
  run.hardBootstrapReminderDelayMs = 10;
  const challenge = create("one", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  const notify = pool.notify.bind(pool);
  let warningEventId;
  pool.notify = async (id, message, options) => {
    if (options.eventId.startsWith("hard-bootstrap-reminder:")) {
      warningEventId = options.eventId;
      throw new Error("Synthetic reminder delivery failure");
    }
    return notify(id, message, options);
  };

  run.sessionEvent({
    type: "tool_end",
    agentId: worker,
    tool: "bash",
    args_digest: "failed-reminder-recon",
    context,
    isError: false,
  });
  await waitFor(() => warningEventId !== undefined, "failed hard bootstrap delivery");
  assert.ok(JSON.stringify(run.board.getMeta("pending_notifications")).includes(warningEventId));

  run.board.execute(worker, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "Progress now makes the reminder obsolete",
    evidence: [{ type: "text", summary: "Fixture progress" }],
  }, context);
  await run.pump();

  assert.equal(JSON.stringify(run.board.getMeta("pending_notifications")).includes(warningEventId), false);
  assert.equal(run.board.getMeta(`hard_bootstrap_reminder:${context.assignment_id}`).status, "suppressed");
});

test("review progress suppresses the hard bootstrap reminder", async (t) => {
  const { run, pool, create, pump, review } = await setup(t);
  run.hardBootstrapReminderDelayMs = 100;
  const challenge = create("one", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  run.sessionEvent({
    type: "tool_end",
    agentId: worker,
    tool: "bash",
    args_digest: "review-progress-recon",
    context,
    isError: false,
  });
  await review(challenge.id, "flag{one}");
  await pump();
  await delay(140);

  assert.equal(run.board.challenge(challenge.id).phase, "reviewing");
  assert.equal(pool.notifications.some(notice =>
    notice.eventId.startsWith("hard-bootstrap-reminder:")), false);
  assert.equal(run.board.getMeta(`hard_bootstrap_reminder:${context.assignment_id}`).status, "suppressed");
});

test("hard bootstrap reminder does not repeat after a consumed reminder and restart", async (t) => {
  const { run, pool, config, create, pump } = await setup(t);
  run.hardBootstrapReminderDelayMs = 20;
  const challenge = create("one", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  pool.notifications.length = 0;
  run.sessionEvent({
    type: "tool_end",
    agentId: worker,
    tool: "bash",
    args_digest: "restart-recon",
    context,
    isError: false,
  });
  await waitFor(() => pool.notifications.some(notice =>
    notice.eventId.startsWith("hard-bootstrap-reminder:")), "first bootstrap reminder");
  await run.stop("reminder_restart");

  let restartedPool;
  const restarted = await ContestRun.create(config, {
    arena: run.arena,
    poolFactory: async (options) => {
      restartedPool = new ScriptedPool(options);
      return restartedPool;
    },
  });
  restarted.hardBootstrapReminderDelayMs = 20;
  t.after(() => restarted.stop("test_complete"));
  await restarted.start();
  restarted.restoreHardBootstrapReminders();
  await delay(60);

  assert.equal(restartedPool.notifications.some(notice =>
    notice.eventId.startsWith("hard-bootstrap-reminder:")), false);
});

test("restart suppresses a pending reminder when progress predates the coordinator pump", async (t) => {
  const { run, pool, config, create, pump } = await setup(t);
  run.hardBootstrapReminderDelayMs = 10;
  const challenge = create("one", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  const notify = pool.notify.bind(pool);
  let warningEventId;
  pool.notify = async (id, message, options) => {
    if (options.eventId.startsWith("hard-bootstrap-reminder:")) {
      warningEventId = options.eventId;
      throw new Error("Synthetic restart delivery failure");
    }
    return notify(id, message, options);
  };
  run.sessionEvent({
    type: "tool_end",
    agentId: worker,
    tool: "bash",
    args_digest: "restart-pending-recon",
    context,
    isError: false,
  });
  await waitFor(() => warningEventId !== undefined, "pending reminder failure");
  run.board.execute(worker, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "Progress was committed before process exit",
    evidence: [{ type: "text", summary: "Durable fixture progress" }],
  }, context);
  assert.ok(JSON.stringify(run.board.getMeta("pending_notifications")).includes(warningEventId));
  await run.stop("pending_reminder_restart");

  let restartedPool;
  const restarted = await ContestRun.create(config, {
    arena: run.arena,
    poolFactory: async (options) => {
      restartedPool = new ScriptedPool(options);
      return restartedPool;
    },
  });
  restarted.hardBootstrapReminderDelayMs = 10;
  t.after(() => restarted.stop("test_complete"));
  await restarted.start();
  await delay(40);

  assert.equal(restartedPool.notifications.some(notice =>
    notice.eventId.startsWith("hard-bootstrap-reminder:")), false);
  assert.equal(JSON.stringify(restarted.board.getMeta("pending_notifications")).includes(warningEventId), false);
  assert.equal(restarted.board.getMeta(`hard_bootstrap_reminder:${context.assignment_id}`).status, "suppressed");
});

test("startup refuses to replace persisted runtime files with a new empty blackboard", async (t) => {
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(join(root, "orphaned-state-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  await writeFile(join(workDir, "events.jsonl"), "{\"type\":\"previous\"}\n");
  await writeFile(join(workDir, "blackboard.sqlite"), "");
  const config = {
    workDir,
    model: { apiKey: "test-model-key" },
    arena: { identity: "test-attempt" },
  };
  await assert.rejects(
    ContestRun.create(config, { arena: {} }),
    error => error.code === "state_store_missing"
      && /blackboard\.sqlite is missing or invalid/.test(error.message),
  );
});

test("empty pre-created state directories do not block a fresh blackboard", async (t) => {
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(join(root, "empty-state-dir-"));
  await mkdir(join(workDir, "sessions"));
  const config = {
    workDir,
    model: { apiKey: "test-model-key" },
    arena: { identity: "test-attempt" },
  };
  const run = await ContestRun.create(config, {
    arena: {},
    poolFactory: async options => new ScriptedPool(options),
  });
  t.after(async () => {
    await run.stop("test_complete");
    await rm(workDir, { recursive: true, force: true });
  });
  assert.equal(run.board.getMeta("initialized"), true);
  assert.equal(run.board.workers().length, 20);
});

test("runtime health distinguishes an unclean process replacement from a clean stop", async (t) => {
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(join(root, "runtime-health-"));
  const config = {
    workDir,
    model: { apiKey: "test-model-key" },
    arena: { identity: "test-attempt" },
  };
  const poolFactory = async options => new ScriptedPool(options);
  const first = await ContestRun.create(config, { arena: {}, poolFactory });
  assert.equal(first.board.getMeta("runtime_lifecycle").status, "running");
  assert.equal(JSON.parse(await readFile(join(workDir, "runtime-health.json"), "utf8")).status, "running");

  await first.pool.close();
  first.resources.close();
  await first.logWrites;
  await first.logFile.close();
  first.board.close();

  const restarted = await ContestRun.create(config, { arena: {}, poolFactory });
  t.after(async () => {
    await restarted.stop("test_complete");
    await rm(workDir, { recursive: true, force: true });
  });
  const lifecycle = restarted.board.getMeta("runtime_lifecycle");
  assert.equal(lifecycle.unexpected_previous_shutdown, true);
  assert.equal(lifecycle.previous.status, "running");
  assert.equal(Object.hasOwn(lifecycle.resources.memory, "limit_bytes"), true);

  await restarted.stop("clean_test_stop");
  const stopped = JSON.parse(await readFile(join(workDir, "runtime-health.json"), "utf8"));
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.stop_reason, "clean_test_stop");
});

test("blackboard lifecycle wins over a stale runtime-health sidecar on restart", async (t) => {
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(join(root, "runtime-health-disagreement-"));
  const board = new Board({ path: join(workDir, "blackboard.sqlite"), initialWorkers: 1 });
  board.setMeta("runtime_lifecycle", {
    status: "running",
    instance_id: "previous-instance",
    pid: 123,
    started_at: "2026-11-22T00:00:00.000Z",
  });
  board.close();
  await writeFile(join(workDir, "runtime-health.json"), JSON.stringify({
    status: "stopped",
    instance_id: "previous-instance",
  }));
  const config = {
    workDir,
    model: { apiKey: "test-model-key" },
    arena: { identity: "test-attempt" },
  };
  const run = await ContestRun.create(config, {
    arena: {},
    poolFactory: async options => new ScriptedPool(options),
  });
  t.after(async () => {
    await run.stop("test_complete");
    await rm(workDir, { recursive: true, force: true });
  });
  const lifecycle = run.board.getMeta("runtime_lifecycle");
  assert.equal(lifecycle.unexpected_previous_shutdown, true);
  assert.equal(lifecycle.status_sources_disagree, true);
  assert.equal(lifecycle.previous.source, "blackboard");
  assert.equal(lifecycle.previous_status_sources.blackboard, "running");
  assert.equal(lifecycle.previous_status_sources.runtime_health_file, "stopped");
});

test("runtime diagnostics are best effort and never block contest startup", async (t) => {
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(join(root, "runtime-health-unavailable-"));
  const blackboardPath = join(workDir, "blackboard.sqlite");
  const board = new Board({ path: blackboardPath, initialWorkers: 1 });
  await mkdir(join(workDir, "runtime-health.json"));
  const config = {
    workDir,
    model: { apiKey: "test-model-key" },
    arena: { identity: "test-attempt" },
  };
  const originalSnapshot = Resources.prototype.snapshot;
  Resources.prototype.snapshot = async () => {
    throw Object.assign(new Error("Synthetic cgroup failure"), { code: "EIO" });
  };
  let run;
  try {
    run = await ContestRun.create(config, {
      arena: {},
      board,
      poolFactory: async options => new ScriptedPool(options),
    });
  } finally {
    Resources.prototype.snapshot = originalSnapshot;
  }
  t.after(async () => {
    await run.stop("test_complete");
    await rm(workDir, { recursive: true, force: true });
  });
  const lifecycle = run.board.getMeta("runtime_lifecycle");
  assert.equal(lifecycle.status, "running");
  assert.equal(lifecycle.resources.error.error, "EIO");
  assert.ok(lifecycle.health_error);
  assert.ok(["EISDIR", "ENOTDIR", "EEXIST"].includes(lifecycle.health_error.error));
});

test("ContestRun creation failure closes an already-created Board, log and pool", async (t) => {
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(join(root, "create-cleanup-"));
  const board = new Board({ path: join(workDir, "blackboard.sqlite"), initialWorkers: 1 });
  const originalClose = board.close.bind(board);
  let boardClosed = false;
  board.close = () => {
    boardClosed = true;
    originalClose();
  };
  board.on = () => {
    throw new Error("Synthetic post-creation failure");
  };
  const config = {
    workDir,
    model: { apiKey: "test-model-key" },
    arena: { identity: "test-attempt" },
  };
  let pool;
  await assert.rejects(ContestRun.create(config, {
    arena: {},
    board,
    poolFactory: async options => {
      pool = new ScriptedPool(options);
      return pool;
    },
  }), /Synthetic post-creation failure/);
  assert.equal(boardClosed, true);
  assert.equal(pool.closed, true);
  await rm(workDir, { recursive: true, force: true });
});

test("restart recovers unfinished catalog work without recreating completed challenges", async (t) => {
  const { run, arena, config, create, pump, review } = await setup(t, [
    { unique_code: "unfinished", flag: "flag{unfinished}", container: false },
    { unique_code: "completed", flag: "flag{completed}", container: false },
  ]);
  const unfinished = create("unfinished");
  const completed = create("completed");
  await run.startChallenge(completed.id);
  await pump();
  const candidate = await review(completed.id, "flag{completed}");
  const current = run.board.challenge(completed.id);
  await run.submit({ challenge_id: completed.id, candidate_id: candidate.candidate.id,
    review_revision: current.review_revision }, randomUUID());
  await pump();
  await run.stop("restart_fixture");

  let recoveredPool;
  const recovered = await ContestRun.create(config, {
    arena: run.arena,
    poolFactory: async (options) => {
      recoveredPool = new ScriptedPool(options);
      return recoveredPool;
    },
  });
  t.after(async () => {
    await recovered.stop("recovered_fixture");
  });
  await recovered.start();
  const report = recovered.board.getMeta("recovery_report");
  assert.ok(report.recovered.includes("unfinished"));
  assert.ok(report.completed.includes("completed"));
  assert.ok(recovered.board.snapshot("lead").challenges.some((item) => item.unique_code === "unfinished"));
  assert.equal(recovered.board.snapshot("lead").challenges.some((item) => item.unique_code === "completed"), true);
  assert.equal(recovered.board.challenge(unfinished.id).unique_code, "unfinished");
});

test("record_fact snapshots the latest bash output and publishes a compact receipt", async (t) => {
  const { run, pool, create, pump } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  const basis = run.board.execute(worker, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "A pre-existing target fact",
    evidence: [{ type: "text", summary: "Target fixture" }],
  }, context).fact;
  const target = run.board.execute(worker, "post_intent", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "A pre-existing target direction",
    based_on: [basis.id],
    expected: "The original target direction holds",
    method: "Run the original target direction",
  }, context).intent;
  const output = join(run.config.workDir, "latest-output.log");
  await writeFile(output, "fixture output\n");
  pool.latestOutputs.set(worker, {
    call_id: "bash-call",
    tool: "bash",
    context,
    details: { output_path: output },
  });
  const receipt = await pool.tool(worker, "record_fact", {
    challenge_id: challenge.id,
    statement: "The fixture output is stable",
    kind: "inference",
    derived_from: [basis.id],
    summary: "Latest bash output",
    next_intents: [{
      statement: "Use the stable output",
      expected: "The next stage accepts the fixture",
      method: "Reuse the recorded artifact",
      disputes: [target.id],
    }],
  }, { context });
  assert.equal(receipt.fact.statement, "The fixture output is stable");
  assert.equal(receipt.fact.kind, "inference");
  assert.deepEqual(receipt.fact.derived_from, [basis.id]);
  assert.equal(receipt.intents.length, 1);
  const disputedTarget = run.board.challenge(challenge.id).intents.find(item => item.id === target.id);
  assert.equal(disputedTarget.disputed, true);
  assert.deepEqual(disputedTarget.disputed_by, [receipt.intents[0].id]);
  assert.match(receipt.fact.evidence[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(receipt, "challenge"), false);
  pool.latestOutputs.set(worker, {
    ...pool.latestOutputs.get(worker),
    context: { ...context, assignment_id: "stale-assignment" },
  });
  await assert.rejects(pool.tool(worker, "record_fact", {
    challenge_id: challenge.id,
    statement: "Stale output must not be recorded",
  }, { context }), /current task assignment/);
});

test("unknown close stays recorded until list reconciliation and resuming uses a new environment generation", async (t) => {
  const { run, arena, pool, create, pump } = await setup(t, [{ unique_code: "one", flag: "flag{one}", container: true }]);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const previous = run.board.challenge(challenge.id);
  arena.setFault("close", { kind: "closed_disconnect" });
  await assert.rejects(run.defer({ challenge_id: challenge.id, expected_revision: previous.revision, reason: "Try a different challenge" }, randomUUID()));
  const deferred = run.board.challenge(challenge.id);
  assert.equal(deferred.phase, "deferred");
  assert.equal(deferred.environment.status, "unknown");
  assert.equal(deferred.ready, false);
  assert.equal(deferred.members.length, 0);
  assert.equal(arena.stats.finishes, 0);
  await pool.tool("lead", "arena_reconcile", {});
  const reconciled = run.board.challenge(challenge.id);
  assert.equal(reconciled.environment.status, "closed");
  await pool.tool("lead", "resume_challenge", { challenge_id: challenge.id, expected_revision: reconciled.revision });
  await pump();
  const resumed = run.board.challenge(challenge.id);
  assert.equal(resumed.phase, "solving");
  assert.ok(resumed.generation > previous.generation);
  assert.equal(resumed.environment.status, "active");
});

test("completed work is paused without another model turn and released only after execution settles", async (t) => {
  const { run, pool, create, pump, submit } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  await pool.begin(worker);
  let settle;
  const settling = new Promise(resolve => { settle = resolve; });
  t.after(() => settle());
  const abort = pool.abort.bind(pool);
  let pauseStarted = false;
  pool.abort = async id => {
    pauseStarted = true;
    await settling;
    return abort(id);
  };
  await submit(challenge.id, "flag{one}");
  await waitFor(() => pauseStarted, "completion pause");
  assert.equal(run.board.challenge(challenge.id).members.length, 1);
  settle();
  await waitFor(() => !run.pumping, "completed execution settled");
  await pump();
  assert.equal(run.board.challenge(challenge.id).members.length, 0);
  assert.ok(pool.abortCalls.includes(worker));
  const completeNotice = pool.notifications.find(notice => notice.id === worker
    && notice.text.includes("本题已通过"));
  assert.equal(completeNotice.triggerTurn, false);
});

test("finished workdir restart does not start another remote interaction", async (t) => {
  const { run, arena, config, create, pump, submit } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  await submit(challenge.id, "flag{one}");
  await run.finish("Synthetic run is complete");
  await run.stop("shutdown");
  const callsBefore = arena.calls.length;
  let restartedPool;
  const restarted = await ContestRun.create(config, { poolFactory: async (options) => {
    restartedPool = new ScriptedPool(options);
    return restartedPool;
  } });
  t.after(() => restarted.stop("test_complete"));
  await restarted.start();
  assert.equal(arena.calls.length, callsBefore);
  assert.equal(restartedPool.notifications.length, 0);
  assert.equal(arena.stats.finishes, 1);
});

test("settled model error releases a completed assignment without ending the attempt", async (t) => {
  const { run, pool, arena, create, pump, submit } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  await pool.begin(worker);
  await submit(challenge.id, "flag{one}");
  await pool.error(worker, "Synthetic provider unavailable");
  await pump();
  assert.equal(run.board.challenge(challenge.id).members.length, 0);
  assert.equal(arena.stats.finishes, 0);
});

test("startup transient catalog failure recovers without finishing or reporting an empty contest", async (t) => {
  const { run, arena, pool } = await setup(t, undefined, { beforeStart: (fixture) => {
    fixture.setFault("list", { status: 503, code: "resource_unavailable" });
  } });
  assert.equal(run.catalog.length, 1);
  assert.ok(arena.calls.filter((call) => call.operation === "list").length >= 2);
  assert.equal(arena.stats.finishes, 0);
  assert.ok(pool.notifications.some((notice) => notice.id === "lead"));
});

test("startup guidance leaves offline order and online quota to Lead and the arena API", async (t) => {
  const { pool } = await setup(t);
  const notice = pool.notifications.find(item => item.id === "lead" && item.eventId.startsWith("startup:"));
  assert.ok(notice);
  assert.match(notice.text, /离线题优先是 Lead 的策略/);
  assert.match(notice.text, /赛事 API 判定/);
  assert.match(notice.text, /environment_limit/);
  assert.equal(/全部门控通过|强制最多 3 个/.test(notice.text), false);
});

test("startup recovery reports abnormal lifecycle and resumes Workers with compact task state", async (t) => {
  const { run, pool } = await setup(t, undefined, {
    beforeStart: async (_arena, current) => {
      current.board.execute("platform", "worker_ready", { worker_id: "worker-1" });
      const challenge = current.board.execute("lead", "create_challenge", {
        request_id: "recovery-challenge",
        unique_code: "one",
        title: "one",
        ready: true,
        requires_online_environment: false,
      });
      current.board.execute("platform", "dispatch", {});
      const lifecycle = current.board.getMeta("runtime_lifecycle");
      current.board.setMeta("runtime_lifecycle", {
        ...lifecycle,
        unexpected_previous_shutdown: true,
        status_sources_disagree: true,
        previous: {
          status: "running",
          started_at: "2026-11-23T00:00:00.000Z",
          stopped_at: null,
          stop_reason: null,
        },
      });
      assert.equal(current.board.challenge(challenge.id).owner_id, "worker-1");
    },
  });
  assert.equal(run.board.workers().find(worker => worker.id === "worker-1").assignment_id !== null, true);

  const lead = pool.notifications.find(notice => notice.id === "lead"
    && notice.eventId.startsWith("startup:"));
  assert.match(lead.text, /检测到上次运行异常结束/);
  assert.equal(notificationPayload(lead).runtime_recovery.unexpected_previous_shutdown, true);

  const resume = pool.notifications.find(notice => notice.id === "worker-1"
    && notice.eventId.startsWith("resume:"));
  assert.ok(resume);
  const payload = notificationPayload(resume);
  assert.equal(payload.task_state.challenge_id, run.board.context("worker-1").challenge_id);
  assert.equal(Object.hasOwn(payload, "facts"), false);
  assert.equal(Object.hasOwn(payload, "intents"), false);
  assert.match(payload.paths.inputs, /\/inputs$/);
});

test("worker tool contracts expose dispute inputs and the exact claim revision field", async (t) => {
  const { run } = await setup(t);
  const tools = run.tools("worker", "worker-1");
  const boardAct = tools.find(tool => tool.name === "board_act");
  assert.match(boardAct.description, /claim: challenge_id,expected_claim_revision/);
  assert.match(boardAct.description, /post_intent: .*disputes:\[intent_id\]/);
  assert.match(boardAct.description, /next_intents entries support optional disputes:\[intent_id\]/);
  assert.match(boardAct.description, /intent_ids and\/or blocker_fact_id/);
  assert.match(boardAct.description, /idempotent confirmation/);
  assert.match(boardAct.description, /submit_review: challenge_id,expected_revision,flag,summary/);
  assert.match(boardAct.description, /claim_intent: challenge_id,intent_id,expected_version/);
  assert.match(boardAct.description, /release_intent: challenge_id,intent_id,note/);
  const recordFact = tools.find(tool => tool.name === "record_fact");
  assert.match(recordFact.description, /next Intent may carry disputes:\[intent_id\]/);
  const nextIntent = recordFact.parameters.properties.next_intents.items;
  assert.equal(Object.hasOwn(nextIntent.properties, "disputes"), true);
  assert.equal(Object.hasOwn(recordFact.parameters.properties, "derived_from"), true);
  assert.match(recordFact.description, /separate Board transaction/);
  const leadAct = run.tools("lead", "lead").find(tool => tool.name === "board_act");
  assert.doesNotMatch(boardAct.description, /create_challenge:|update_challenge:|reject_review:/);
  assert.doesNotMatch(leadAct.description, /(?:^|\s)claim:|post_intent:|submit_review:/);
  for (const definition of [boardAct, leadAct]) {
    for (const action of definition.parameters.properties.action.anyOf.map(option => option.const)) {
      assert.ok(definition.description.includes(`${action}: `), action);
    }
  }
});

test("explicit not-started rejection stays distinct from a wrong flag and permits a corrected submission", async (t) => {
  const { run, arena, create, pump, review } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const candidate = await review(challenge.id, "flag{one}");
  arena.setFault("submit", { status: 409, code: "challenge_not_started", message: "Start the challenge first" });
  const args = () => ({ challenge_id: challenge.id, candidate_id: candidate.candidate.id,
    review_revision: run.board.challenge(challenge.id).review_revision, expected_revision: run.board.challenge(challenge.id).revision });
  await assert.rejects(run.submit(args(), randomUUID()), (error) => error.code === "challenge_not_started");
  const failed = run.board.challenge(challenge.id);
  assert.equal(failed.phase, "reviewing");
  assert.equal(failed.submissions[0].status, "not_sent");
  assert.equal(failed.facts.some((fact) => fact.statement.includes("incorrect")), false);
  await run.startChallenge(challenge.id);
  assert.equal((await run.submit(args(), randomUUID())).outcome, "accepted");
  assert.equal(arena.stats.submits, 2);
});

test("first assignment notification persists its exact envelope and retries after delivery failure", async (t) => {
  const { run, pool, create } = await setup(t);
  const notify = pool.notify.bind(pool);
  let failed;
  let persistedAtFailure;
  pool.notify = async (id, text, options) => {
    if (!failed && options.eventId.startsWith("assignment:")) {
      failed = { id, text, ...options };
      persistedAtFailure = JSON.stringify(run.board.getMeta("pending_notifications"));
      throw new Error("Synthetic first delivery failure");
    }
    return notify(id, text, options);
  };
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await waitFor(() => failed !== undefined, "first assignment delivery attempt");
  assert.ok(persistedAtFailure.includes(failed.eventId));
  await waitFor(() => pool.notifications.some((notice) => notice.eventId === failed.eventId), "durable assignment retry");
  assert.deepEqual(pool.notifications.find((notice) => notice.eventId === failed.eventId), failed);
  assert.equal(JSON.stringify(run.board.getMeta("pending_notifications")).includes(failed.eventId), false);
  assert.equal(run.board.challenge(challenge.id).members.length, 1);
  assert.equal(run.board.events().filter((event) => event.type === "worker.assigned").length, 1);
});

test("assignment notification carries compact task state and payload metrics", async (t) => {
  const { run, pool, create, pump } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const notice = pool.notifications.find((item) => item.eventId.startsWith("assignment:"));
  assert.ok(notice);
  const payload = notificationPayload(notice);
  assert.equal(payload.task_state.challenge_id, challenge.id);
  assert.equal(payload.task_state.phase, "solving");
  assert.equal(payload.task_state.needs_task_read, false);
  assert.equal(payload.task_state.fact_count, 0);
  assert.equal(payload.task_state.intent_count, 0);
  assert.equal(payload.task_state.candidate_count, 0);
  assert.equal(Number.isSafeInteger(payload.task_state.event_cursor), true);
  assert.equal(Object.hasOwn(payload.task_state, "evidence"), false);
  assert.equal(Object.hasOwn(payload.task_state, "notes"), false);
  assert.equal(Object.hasOwn(payload.task_state, "receipt"), false);
  assert.ok(run.metrics.notification_payload_bytes >= Buffer.byteLength(notice.text, "utf8"));
});

test("assignment task state exposes only current ready unclaimed parallel directions", async (t) => {
  const { run, pool, create, pump } = await setup(t, undefined, { initialWorkers: 5 });
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const owner = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(owner);
  const basis = run.board.execute(owner, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "The target exposes three independently testable branches",
    evidence: [{ type: "text", summary: "Synthetic fixture observation" }],
  }, context).fact;
  const postIntent = (statement, extra = {}) => run.board.execute(owner, "post_intent", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement,
    based_on: [basis.id],
    expected: "A distinct observable result",
    method: "Run the focused branch probe",
    ...extra,
  }, context).intent;
  const open = postIntent("Probe the open branch", {
    parallel: true,
    parallel_key: "open-branch",
  });
  const blocked = postIntent("Probe the dependent branch", {
    parallel: true,
    parallel_key: "dependent-branch",
    depends_on: [open.id],
  });
  const claimed = postIntent("Probe the already-held branch", {
    parallel: true,
    parallel_key: "claimed-branch",
    claim: true,
  });
  await pump();

  const assistant = pool.notifications
    .filter(notice => notice.id !== "lead" && notice.eventId.startsWith("assignment:"))
    .map(notificationPayload)
    .find(payload => payload.task_state.assignment_role === "assistant");
  assert.ok(assistant);
  assert.deepEqual(assistant.task_state.unclaimed_parallel_intents.map(item => item.id), [open.id]);
  assert.equal(assistant.task_state.unclaimed_parallel_intents.some(item => item.id === blocked.id), false);
  assert.equal(assistant.task_state.unclaimed_parallel_intents.some(item => item.id === claimed.id), false);
  const claimedContext = assistant.task_state.latest_intents.find(item => item.id === claimed.id);
  assert.equal(claimedContext.status, "claimed");
  assert.equal(claimedContext.holder, owner);
  assert.equal(Object.hasOwn(assistant.task_state, "independent_direction"), false);
  assert.match(assistant.task_state.assignment_reason, /no direction is preassigned/);
});

test("next Intents with disputes emit one batched team notification", async (t) => {
  const { run, pool, create, pump } = await setup(t, undefined, { initialWorkers: 2 });
  const challenge = create("one", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const current = run.board.challenge(challenge.id);
  const owner = current.owner_id;
  const teammate = current.members.find(member => member.worker_id !== owner).worker_id;
  const context = run.board.context(owner);
  const basis = run.board.execute(owner, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "Initial parser observation",
    evidence: [{ type: "text", summary: "Owner fixture" }],
  }, context).fact;
  const target = run.board.execute(owner, "post_intent", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "Inspect the original parser path",
    based_on: [basis.id],
    expected: "The original path accepts the fixture",
    method: "Run the original parser",
  }, context).intent;
  const targetTwo = run.board.execute(owner, "post_intent", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "Inspect the second parser path",
    based_on: [basis.id],
    expected: "The second path accepts the fixture",
    method: "Run the second parser",
  }, context).intent;
  await pump();
  pool.notifications.length = 0;

  const claimRevision = run.board.challenge(challenge.id).claim_revision;
  run.board.execute(owner, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "The original parser path is contradicted by a second fixture",
    evidence: [{ type: "text", summary: "Counter fixture" }],
    next_intents: [
      {
        statement: "Inspect the contradicted first parser path",
        expected: "The counter fixture reaches the same first sink",
        method: "Run the first counter fixture",
        disputes: [target.id],
      },
      {
        statement: "Inspect the contradicted second parser path",
        expected: "The counter fixture reaches the same second sink",
        method: "Run the second counter fixture",
        disputes: [targetTwo.id],
      },
    ],
  }, context);
  const events = run.board.events();
  assert.deepEqual(events.slice(-3).map(event => event.type), ["fact.posted", "intent.posted", "intent.posted"]);
  assert.equal(events.at(-2).intent_id !== events.at(-1).intent_id, true);
  assert.equal(run.board.challenge(challenge.id).claim_revision, claimRevision);
  await pump();

  const teamNotices = pool.notifications.filter(notice => notice.id === teammate
    && notice.eventId.startsWith("board:"));
  assert.equal(teamNotices.length, 1);
  const payload = notificationPayload(teamNotices[0]);
  assert.deepEqual(payload.events.slice(-3).map(event => event.type), ["fact.posted", "intent.posted", "intent.posted"]);
  const intentChanges = payload.changes.filter(change => change.entity === "intent");
  assert.equal(intentChanges.length, 2);
  assert.deepEqual(new Set(intentChanges.map(change => change.data.disputed_refs[0].id)), new Set([target.id, targetTwo.id]));
  assert.equal(pool.notifications.some(notice => notice.id === "lead"), false);
});

test("assistance assignment exposes disputed Facts and Intents in task state", async (t) => {
  const { run, pool, create, pump } = await setup(t, undefined, { initialWorkers: 3 });
  const challenge = create("one", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const initial = run.board.challenge(challenge.id);
  const owner = initial.owner_id;
  const assistant = initial.members.find(member => member.worker_id !== owner).worker_id;
  const idle = run.board.workers().find(worker => !initial.members.some(member => member.worker_id === worker.id)
    && worker.status === "idle").id;
  const ownerContext = run.board.context(owner);
  const assistantContext = run.board.context(assistant);
  const targetFact = run.board.execute(owner, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "Target Fact for assistance projection",
    evidence: [{ type: "text", summary: "Owner fixture" }],
  }, ownerContext).fact;
  const blockerFact = run.board.execute(owner, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "The current execution is blocked on a missing generator",
    evidence: [{ type: "text", summary: "Concrete blocker fixture" }],
  }, ownerContext).fact;
  const targetIntent = run.board.execute(owner, "post_intent", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "Target Intent for assistance projection",
    based_on: [targetFact.id],
    expected: "A distinct observable result",
    method: "Run the target direction",
    parallel: true,
    parallel_key: "disputed-assignment-direction",
  }, ownerContext).intent;
  run.board.execute(assistant, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "A conflicting target observation",
    evidence: [{ type: "text", summary: "Assistant fixture" }],
    disputes: [targetFact.id],
  }, assistantContext);
  run.board.execute(assistant, "post_intent", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "A conflicting target direction",
    based_on: [targetFact.id],
    expected: "A different observable result",
    method: "Run the conflicting direction",
    disputes: [targetIntent.id],
  }, assistantContext);
  run.board.execute(owner, "request_assistance", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    expected_revision: run.board.challenge(challenge.id).revision,
    reason: "Add one independent assistant",
    additional_workers: 2,
    intent_ids: [targetIntent.id],
    blocker_fact_id: blockerFact.id,
  }, ownerContext);
  pool.notifications.length = 0;
  await pump();

  const notice = pool.notifications.find(item => item.id === idle && item.eventId.startsWith("assignment:"));
  assert.ok(notice);
  const state = notificationPayload(notice).task_state;
  const disputedFact = state.latest_facts.find(item => item.id === targetFact.id);
  assert.equal(disputedFact.status, "disputed");
  assert.equal(disputedFact.disputed_by.length, 1);
  const disputedIntent = state.latest_intents.find(item => item.id === targetIntent.id);
  assert.equal(disputedIntent.disputed, true);
  assert.equal(disputedIntent.disputed_by.length, 1);
  const availableDisputed = state.unclaimed_parallel_intents.find(item => item.id === targetIntent.id);
  assert.equal(availableDisputed.disputed, true);
  assert.equal(state.assistance.target, 3);
  assert.equal(state.assistance.requested_directions[0].id, targetIntent.id);
  assert.equal(state.assistance.blocker_facts[0].id, blockerFact.id);
  assert.equal(state.event_cursor, run.board.getMeta("event_cursor"));
  assert.ok(Number.isSafeInteger(state.assignment_event_id));
});

test("assignment metrics observe task reads without gating local tools", async (t) => {
  const { run, create, pump } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);

  run.beginAssignmentMetrics(worker);
  run.sessionEvent({ type: "tool_start", agentId: worker, tool: "bash", context });
  run.sessionEvent({ type: "tool_start", agentId: worker, tool: "board_read", context });
  assert.equal(run.metrics.assignment_first_tool[worker], "bash");
  assert.equal(run.metrics.task_read_before_local_tool, 0);
  assert.equal(Number.isSafeInteger(run.metrics.task_read_latency_ms[worker]), true);

  run.beginAssignmentMetrics(worker);
  run.sessionEvent({ type: "tool_start", agentId: worker, tool: "board_read", context });
  assert.equal(run.metrics.task_read_before_local_tool, 1);
});

test("ordinary Fact and Intent writes update metrics without waking Lead", async (t) => {
  const { run, pool, create, pump } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  pool.notifications.length = 0;
  const fact = run.board.execute(worker, "post_fact", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "The fixture has a stable input",
    evidence: [{ type: "text", summary: "Read the fixture description" }],
  }, context);
  run.board.execute(worker, "post_intent", {
    request_id: randomUUID(),
    challenge_id: challenge.id,
    statement: "Inspect the stable input",
    based_on: [fact.fact.id],
    expected: "A reproducible result",
    method: "Read the fixture",
  }, context);
  await pump();
  assert.equal(run.metrics.fact_write_count, 1);
  assert.equal(run.metrics.intent_write_count, 1);
  assert.equal(pool.notifications.some((notice) => notice.id === "lead"
    && notice.eventId.startsWith("lead-batch:")), false);
});

test("restart replays the saved assignment envelope after its initial delivery failed", async (t) => {
  const { run, pool, config, create } = await setup(t);
  const notify = pool.notify.bind(pool);
  let failed;
  pool.notify = async (id, text, options) => {
    if (options.eventId.startsWith("assignment:")) {
      failed = { id, text, ...options };
      throw new Error("Synthetic unavailable delivery transport");
    }
    return notify(id, text, options);
  };
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await waitFor(() => failed !== undefined, "persisted failed assignment notification");
  assert.ok(JSON.stringify(run.board.getMeta("pending_notifications")).includes(failed.eventId));
  await run.stop("simulated_restart");
  let restartedPool;
  const restarted = await ContestRun.create(config, { poolFactory: async (options) => {
    restartedPool = new ScriptedPool(options);
    return restartedPool;
  } });
  t.after(() => restarted.stop("test_complete"));
  await restarted.start();
  await waitFor(() => restartedPool.notifications.some((notice) => notice.eventId === failed.eventId), "saved assignment replay");
  assert.deepEqual(restartedPool.notifications.find((notice) => notice.eventId === failed.eventId), failed);
  assert.equal(JSON.stringify(restarted.board.getMeta("pending_notifications")).includes(failed.eventId), false);
  assert.equal(restarted.board.challenge(challenge.id).members.length, 1);
  assert.equal(restarted.board.events().filter((event) => event.type === "worker.assigned").length, 1);
});

test("restart replays an accepted but unconsumed notification envelope", async (t) => {
  const { run, pool, config, create } = await setup(t);
  const notify = pool.notify.bind(pool);
  let unconsumed;
  pool.notify = async (id, text, options) => {
    if (options.eventId.startsWith("assignment:")) {
      unconsumed = { id, text, ...options };
      pool.notifications.push(unconsumed);
      return { delivered: true, consumed: false, eventId: options.eventId };
    }
    return notify(id, text, options);
  };
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await waitFor(() => unconsumed !== undefined, "unconsumed assignment notification");
  assert.ok(JSON.stringify(run.board.getMeta("pending_notifications")).includes(unconsumed.eventId));
  await run.stop("simulated_restart");

  let restartedPool;
  const restarted = await ContestRun.create(config, { poolFactory: async (options) => {
    restartedPool = new ScriptedPool(options);
    return restartedPool;
  } });
  t.after(() => restarted.stop("test_complete"));
  await restarted.start();
  await waitFor(() => restartedPool.notifications.some(notice => notice.eventId === unconsumed.eventId),
    "unconsumed notification replay");
  assert.deepEqual(restartedPool.notifications.find(notice => notice.eventId === unconsumed.eventId), unconsumed);
  assert.equal(JSON.stringify(restarted.board.getMeta("pending_notifications")).includes(unconsumed.eventId), false);
});

test("event logging skips model deltas and recovers after one append failure", async (t) => {
  const { run } = await setup(t);
  const writes = [];
  let failNext = true;
  run.logFile.appendFile = async line => {
    if (failNext) {
      failNext = false;
      throw new Error("Synthetic log write failure");
    }
    writes.push(line);
  };
  run.sessionEvent({ type: "model_delta", agentId: "worker-1", kind: "text_delta", text: "stream" });
  run.log({ type: "first_boundary" });
  run.log({ type: "second_boundary" });
  await run.logWrites;
  assert.equal(writes.length, 1);
  assert.match(writes[0], /second_boundary/);
  assert.equal(run.logError.message, "Synthetic log write failure");
});

test("stop force-closes a session pool that never acknowledges shutdown", async (t) => {
  const { run, pool } = await setup(t);
  run.stopGraceMs = 20;
  pool.close = () => new Promise(() => {});
  let forced = false;
  pool.forceClose = () => { forced = true; pool.closed = true; };
  const startedAt = Date.now();
  await run.stop("hung_pool");
  assert.equal(forced, true);
  assert.equal(run.closed, true);
  assert.equal(pool.closed, true);
  assert.ok(Date.now() - startedAt < 500);
});

test("finish success followed by disconnect stays unknown and restart only reconciles with GET", { timeout: 5000 }, async (t) => {
  const { run, arena, config } = await setup(t);
  arena.setFault("finish", { kind: "finished_disconnect" });
  await run.finish("Synthetic explicit stop").catch((error) => assert.equal(error.outcomeUnknown, true));
  assert.equal(run.board.getMeta("finish_attempt").status, "unknown");
  assert.equal(arena.stats.finishes, 1);
  await run.finished;
  await run.stop("simulated_restart");
  const callsBefore = arena.calls.length;
  let restartedPool;
  const restarted = await ContestRun.create(config, { poolFactory: async (options) => {
    restartedPool = new ScriptedPool(options);
    return restartedPool;
  } });
  t.after(() => restarted.stop("test_complete"));
  await restarted.start();
  await restarted.finished;
  const reconciliation = arena.calls.slice(callsBefore);
  assert.ok(reconciliation.length >= 1);
  assert.ok(reconciliation.every((call) => call.method === "GET"));
  assert.equal(arena.stats.finishes, 1);
  assert.equal(restartedPool.notifications.length, 0);
  assert.ok(["unknown", "confirmed"].includes(restarted.board.getMeta("finish_attempt").status));
});

test("definite finish rejection persists not_sent and permits a later explicit retry", async (t) => {
  const { run, arena } = await setup(t);
  arena.setFault("finish", { status: 400, code: "invalid_request", message: "Synthetic technical rejection" });
  await assert.rejects(run.finish("Synthetic stop"), (error) => error.code === "invalid_request");
  assert.equal(run.board.getMeta("finish_attempt").status, "not_sent");
  assert.ok(!run.ending);
  assert.equal(arena.stats.finishes, 1);
  await run.finish("Explicit retry after rejection");
  assert.equal(run.board.getMeta("finish_attempt").status, "confirmed");
  assert.equal(arena.stats.finishes, 2);
});

test("connectivity probe uses one probe session, skips environment calls and ends on the verdict", { timeout: 5000 }, async (t) => {
  for (const expectedOutcome of ["accepted", "rejected"]) {
    const arenaFlag = expectedOutcome === "accepted" ? "flag{probe}" : "flag{other}";
    const { run, pool, arena } = await setup(t,
      [{ unique_code: "opaque-code", flag: arenaFlag, description: "Return flag{probe} from this synthetic statement" }],
      { mode: "connectivity_test" });
    const result = await run.finished;
    assert.deepEqual(pool.status().map(item => item.id), ["probe"]);
    assert.equal(pool.status()[0].model_requests, 1);
    assert.equal(arena.stats.starts, 0);
    assert.equal(arena.stats.submits, 1);
    assert.equal(arena.stats.closes, 0);
    assert.equal(arena.stats.finishes, 0);
    assert.equal(result.reason, "connectivity_verdict");
    assert.equal(result.completed, expectedOutcome === "accepted");
    assert.equal(run.board.getMeta("finished").completed, expectedOutcome === "accepted");
  }
});

test("connectivity probe waits for a nonempty streamed delta", () => {
  const run = Object.create(ContestRun.prototype);
  let observed = 0;
  run.log = () => {};
  run.notices = new Map();
  run.retries = new Map();
  run.retryExhausted = new Set();
  run.settledAgents = new Set();
  run.schedule = () => {};
  run.connectivityProbeOutput = () => { observed += 1; };

  run.sessionEvent({
    type: "message",
    agentId: "probe",
    content: [{ type: "text", text: "complete message without a delta" }],
    stopReason: "stop",
  });
  run.sessionEvent({ type: "model_delta", agentId: "probe", text: "" });
  assert.equal(observed, 0);

  run.sessionEvent({ type: "model_delta", agentId: "probe", kind: "text_delta", text: "flag{probe}" });
  assert.equal(observed, 1);
});

test("connectivity probe submits after a bounded abort even when the probe session hangs", { timeout: 5000 }, async (t) => {
  let forced = false;
  const { run, arena } = await setup(t,
    [{ unique_code: "opaque-code", flag: "flag{probe}", description: "Return flag{probe} from this synthetic statement" }],
    {
      mode: "connectivity_test",
      beforeStart: (_arena, preparedRun) => {
        preparedRun.connectivityProbeAbortGraceMs = 20;
        preparedRun.pool.abort = () => new Promise(() => {});
        preparedRun.pool.forceClose = () => {
          forced = true;
          preparedRun.pool.closed = true;
        };
      },
    });
  await run.finished;
  assert.equal(forced, true);
  assert.equal(arena.stats.submits, 1);
  assert.equal(run.board.getMeta("finished").completed, true);
});

test("reopening through repeated pending responses advances the environment generation exactly once", async (t) => {
  const { run, pool, arena, create, pump } = await setup(t,
    [{ unique_code: "one", flag: "flag{one}", container: true }]);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const original = run.board.challenge(challenge.id);
  await run.defer({ challenge_id: challenge.id, expected_revision: original.revision,
    reason: "Synthetic environment restart" }, randomUUID());
  const deferred = run.board.challenge(challenge.id);
  arena.setFault("start", { kind: "pending", times: 2 });
  await pool.tool("lead", "resume_challenge", { challenge_id: challenge.id, expected_revision: deferred.revision });
  await pump();
  assert.equal(run.board.challenge(challenge.id).environment.status, "active");
  assert.equal(run.board.challenge(challenge.id).generation, original.generation + 1);
  assert.equal(run.board.challenge(challenge.id).members.length, 1);
  const reopened = run.board.challenge(challenge.id);
  assert.equal(reopened.environment.status, "active");
  assert.equal(reopened.generation, original.generation + 1);
  assert.equal(reopened.members.length, 1);
  await run.startChallenge(challenge.id);
  await run.reconcileEnvironments();
  assert.equal(run.board.challenge(challenge.id).generation, reopened.generation);
});

test("start re-reads a reconciled active environment without issuing a second start", async (t) => {
  const { run, arena, create, pump } = await setup(t, [
    { unique_code: "one", flag: "flag{one}", container: true },
  ]);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  assert.equal(arena.stats.starts, 1);
  run.board.execute("platform", "set_environment", {
    challenge_id: challenge.id,
    status: "unknown",
    ready: false,
    online: true,
    connection: { code: "unknown_outcome" },
  });
  await run.startChallenge(challenge.id);
  assert.equal(arena.stats.starts, 1);
  assert.equal(run.board.challenge(challenge.id).environment.status, "active");
  assert.equal(run.board.challenge(challenge.id).ready, true);
});

test("start reopens an assembling primary after its environment closes outside the coordinator", async (t) => {
  const { run, arena, lead, pump } = await setup(t, [
    { unique_code: "hard", flag: "flag{hard}", container: true, difficulty: "hard" },
  ], { initialWorkers: 1 });
  const challenge = lead("create_challenge", {
    unique_code: "hard",
    title: "hard",
    ready: false,
    difficulty: "hard",
  });
  await run.startChallenge(challenge.id);
  await pump();
  const assembling = run.board.challenge(challenge.id);
  assert.equal(assembling.phase, "assembling");
  assert.equal(assembling.members.length, 1);
  assert.equal(arena.stats.starts, 1);

  await run.arena.close("hard");
  run.setEnvironment({
    challenge_id: challenge.id,
    status: "unknown",
    ready: false,
    online: true,
    connection: { code: "synthetic_external_close" },
  });
  await run.startChallenge(challenge.id);

  const reopened = run.board.challenge(challenge.id);
  assert.equal(reopened.phase, "deferred");
  assert.equal(reopened.environment.status, "active");
  assert.equal(reopened.generation, assembling.generation + 1);
  assert.equal(reopened.members.length, 0);
  assert.equal(arena.stats.starts, 2);
});

test("a queued old-assignment notice is discarded after that Worker claims another task", async (t) => {
  const { run, pool, create, pump } = await setup(t,
    [{ unique_code: "one", flag: "flag{one}" }, { unique_code: "two", flag: "flag{two}" }]);
  const first = create("one");
  await run.startChallenge(first.id);
  await pump();
  const original = run.board.challenge(first.id);
  const worker = original.owner_id;
  const oldContext = run.board.context(worker);
  const notify = pool.notify.bind(pool);
  let attempts = 0;
  pool.notify = async (id, text, options) => {
    if (options.eventId === "old-assignment-notice") {
      attempts += 1;
      throw new Error("Keep the old notice pending until reassignment");
    }
    return notify(id, text, options);
  };
  await assert.rejects(run.notify(worker, "Synthetic old task update", {
    eventId: "old-assignment-notice", scope: first.id, version: original.revision,
  }), /old notice/);
  await run.defer({ challenge_id: first.id, expected_revision: original.revision,
    close_environment: false, reason: "Switch to the second local task" }, randomUUID());
  const second = create("two");
  await run.startChallenge(second.id);
  const current = run.board.challenge(second.id);
  run.board.execute(worker, "claim", { challenge_id: second.id, expected_claim_revision: current.claim_revision,
    request_id: randomUUID() }, run.board.context(worker));
  assert.notEqual(run.board.context(worker).assignment_id, oldContext.assignment_id);
  await run.flushNotifications();
  assert.equal(attempts, 1);
  assert.equal(pool.notifications.some((notice) => notice.eventId === "old-assignment-notice"), false);
  assert.equal(JSON.stringify(run.board.getMeta("pending_notifications")).includes("old-assignment-notice"), false);
  assert.equal(run.board.context(worker).challenge_id, second.id);
});

test("an idle Lead receives one recovery notice when every unfinished task is deferred", async (t) => {
  const { run, pool, arena, create, pump } = await setup(t,
    [{ unique_code: "one", flag: "flag{one}" }, { unique_code: "two", flag: "flag{two}" }]);
  const first = create("one");
  const second = create("two");
  await run.startChallenge(first.id);
  await run.startChallenge(second.id);
  await pump();
  await pool.begin("lead");
  for (const challenge of [first, second]) {
    const current = run.board.challenge(challenge.id);
    await run.defer({ challenge_id: challenge.id, expected_revision: current.revision,
      reason: "Review the remaining strategy" }, randomUUID());
  }
  await pump();
  const notices = () => pool.notifications.filter((notice) => notice.id === "lead" && notice.eventId.startsWith("deferred:"));
  assert.equal(notices().length, 0);
  await pool.idle("lead");
  await pump();
  assert.equal(notices().length, 1);
  assert.match(notices()[0].text, /恢复题目/);
  await pump();
  assert.equal(notices().length, 1);
  assert.equal(arena.stats.finishes, 0);
});

test("a partial accepted flag keeps the same team solving until all flags complete", async (t) => {
  const { run, pool, arena, create, pump, submit } = await setup(t,
    [{ unique_code: "stages", flags: ["flag{first}", "flag{second}"], container: true }]);
  const challenge = create("stages", { difficulty: "hard" });
  await run.startChallenge(challenge.id);
  await pump();
  const members = run.board.challenge(challenge.id).members;
  assert.equal(members.length, 2);
  await pool.begin(members[0].worker_id);
  const first = await submit(challenge.id, "flag{first}");
  await pump();
  assert.equal(first.outcome, "accepted");
  const partial = run.board.challenge(challenge.id);
  assert.equal(partial.phase, "solving");
  assert.equal(partial.environment.status, "active");
  assert.deepEqual(partial.members.map((member) => member.id), members.map((member) => member.id));
  assert.ok(partial.members.every((member) => run.board.context(member.worker_id).challenge_id === challenge.id));
  assert.equal(partial.submissions.filter((submission) => submission.status === "accepted").length, 1);
  assert.equal(pool.abortCalls.includes(partial.owner_id), false);
  assert.equal(arena.stats.finishes, 0);
  await pool.begin(partial.owner_id);
  const second = await submit(challenge.id, "flag{second}");
  await pump();
  assert.equal(second.outcome, "accepted");
  assert.equal(run.board.challenge(challenge.id).phase, "completed");
  assert.equal(run.board.challenge(challenge.id).members.length, 0);
  assert.ok(pool.abortCalls.includes(partial.owner_id));
  const releaseNotices = () => pool.notifications.filter(notice => notice.id === "lead"
    && notice.text.includes("online_environment_released"));
  assert.equal(releaseNotices().length, 1);
  await pool.idle(partial.owner_id);
  await pump();
  assert.equal(run.board.challenge(challenge.id).members.length, 0);
  await pump();
  assert.equal(releaseNotices().length, 1);
  assert.equal(arena.stats.submits, 2);
  assert.equal(run.board.getMeta("cumulative_score"), 100);
});

test("offline completion does not announce an online environment slot release", async (t) => {
  const { run, pool, create, pump, submit } = await setup(t, [
    { unique_code: "offline", flag: "flag{offline}", container: false },
  ]);
  const challenge = create("offline");
  await run.startChallenge(challenge.id);
  await pump();
  assert.equal((await submit(challenge.id, "flag{offline}")).outcome, "accepted");
  await pump();
  await pump();
  assert.equal(pool.notifications.some(notice => notice.id === "lead"
    && notice.text.includes("online_environment_released")), false);
});

test("invalid attempt token from a Lead arena tool stops local work without finishing remotely", { timeout: 5000 }, async (t) => {
  const { run, pool, arena } = await setup(t);
  arena.setFault("list", { status: 404, code: "task_not_found", message: "The attempt token is no longer valid" });
  await assert.rejects(pool.tool("lead", "arena_list", {}), (error) => error.code === "task_not_found");
  const result = await run.finished;
  assert.equal(result.reason, "invalid_attempt_token");
  assert.equal(run.ending, true);
  assert.equal(run.started, false);
  assert.equal(arena.stats.finishes, 0);
});

test("reconciliation leaves an unstarted offline challenge pending and unassigned", async (t) => {
  const { run, pool, arena, create, pump } = await setup(t);
  const challenge = create("one");
  await pool.tool("lead", "arena_reconcile", {});
  await pump();
  const current = run.board.challenge(challenge.id);
  assert.equal(current.phase, "pending");
  assert.equal(current.ready, false);
  assert.equal(current.members.length, 0);
  assert.equal(arena.stats.starts, 0);
  await run.startChallenge(challenge.id);
  await pump();
  assert.equal(run.board.challenge(challenge.id).phase, "solving");
  assert.equal(arena.stats.starts, 1);
});

test("reconciliation notices an active environment that stopped outside the coordinator", async (t) => {
  const { run, pool, arena, create, pump } = await setup(t, [
    { unique_code: "one", flag: "flag{one}", container: true },
  ]);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  assert.equal(run.board.challenge(challenge.id).environment.status, "active");
  // Simulate a stop after the Board's active receipt but before its marker write.
  run.board.setMeta(`environment_activated:${challenge.id}:1`, false);
  const listChallenges = run.arena.listChallenges.bind(run.arena);
  run.arena.listChallenges = async (...args) => (await listChallenges(...args))
    .map(item => ({ ...item, container_status: "unrecognized" }));
  await run.reconcileEnvironments();
  assert.equal(run.board.challenge(challenge.id).environment.status, "unknown");
  assert.equal(run.board.getMeta(`environment_activated:${challenge.id}:1`), true);
  run.arena.listChallenges = listChallenges;
  await run.arena.close("one");
  await run.reconcileEnvironments();
  await run.flushNotifications();
  const reconciled = run.board.challenge(challenge.id);
  assert.equal(reconciled.environment.status, "closed");
  assert.equal(reconciled.ready, false);
  assert.equal(reconciled.phase, "deferred");
  assert.equal(reconciled.members.length, 0);
  assert.equal(run.board.getMeta(`environment_activated:${challenge.id}:1`), true);
  assert.equal(arena.stats.starts, 1);
  assert.equal(run.board.getMeta(`external_environment_closed:${challenge.id}:${reconciled.generation}`).status,
    "handled");
  const notices = () => pool.notifications.filter(notice => notice.id === "lead"
    && notice.eventId.startsWith("external-close:"));
  assert.equal(notices().length, 1);
  await run.reconcileEnvironments();
  await run.flushNotifications();
  assert.equal(notices().length, 1);
  await pool.tool("lead", "resume_challenge", {
    challenge_id: challenge.id, expected_revision: run.board.challenge(challenge.id).revision,
  });
  assert.equal(run.board.challenge(challenge.id).generation, 2);
});

test("selected materials permit local work before remote start without changing download-only behavior", async (t) => {
  const { run, pool, arena, create, pump } = await setup(t, [{
    unique_code: "online", flag: "flag{online}", container: true,
    handout: { path: "handouts/source.txt", content: "Local source fixture" },
  }]);
  const challenge = create("online");
  await pool.tool("lead", "arena_files", { challenge_id: challenge.id, path: "handouts/source.txt" });
  await pump();
  assert.equal(run.board.challenge(challenge.id).ready, false);
  assert.equal(run.board.challenge(challenge.id).members.length, 0);
  const prepared = await pool.tool("lead", "arena_files", {
    challenge_id: challenge.id, prepare_paths: ["handouts/source.txt"],
  });
  await pump();
  const local = run.board.challenge(challenge.id);
  assert.equal(arena.stats.starts, 0);
  assert.equal(local.ready, true);
  assert.equal(local.environment.status, "pending");
  assert.equal(local.members.length, 1);
  assert.equal(prepared.materials.scope, "selected");
  const filesBefore = arena.calls.filter(call => call.operation === "files").length;
  const factsBefore = local.facts.length;
  const cached = await pool.tool("lead", "arena_files", {
    challenge_id: challenge.id, prepare_paths: ["handouts/source.txt"],
  });
  assert.equal(cached.cached, true);
  assert.equal(arena.calls.filter(call => call.operation === "files").length, filesBefore);
  assert.equal(run.board.challenge(challenge.id).facts.length, factsBefore);
  for (const args of [
    { path: "handouts/source.txt", prepare_paths: ["handouts/source.txt"] },
    { prepare_paths: [] },
    { prepare_paths: ["handouts/source.txt", "handouts/source.txt"] },
    { prepare_paths: ["unlisted.txt"] },
  ]) {
    await assert.rejects(pool.tool("lead", "arena_files", { challenge_id: challenge.id, ...args }),
      error => ["invalid_argument", "material_not_listed"].includes(error.code));
  }
  assert.equal(run.board.challenge(challenge.id).ready, true);
  const context = run.board.context(local.owner_id);
  await run.reconcileEnvironments();
  assert.equal(run.board.challenge(challenge.id).environment.status, "closed");
  assert.deepEqual(run.board.context(local.owner_id), context);
  assert.equal(run.board.challenge(challenge.id).ready, true);
  await run.startChallenge(challenge.id);
  assert.equal(run.board.challenge(challenge.id).generation, 1);
  assert.deepEqual(run.board.context(local.owner_id), context);
  assert.equal(run.board.challenge(challenge.id).environment.status, "active");
});

test("model retries follow local material readiness before remote activation", async (t) => {
  const { run, pool, arena, create, pump } = await setup(t, [{
    unique_code: "online", flag: "flag{online}", container: true,
    handout: { path: "source.txt", content: "local retry fixture" },
  }]);
  const challenge = create("online");
  await pool.tool("lead", "arena_files", { challenge_id: challenge.id, prepare_paths: ["source.txt"] });
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  run.retryDelayBaseMs = 0;
  const retries = () => pool.notifications.filter(notice => notice.id === worker
    && notice.eventId.startsWith("retry:"));
  for (const state of ["pending", "closed"]) {
    if (state === "closed") await run.reconcileEnvironments();
    assert.equal(run.board.challenge(challenge.id).environment.status, state);
    assert.equal(run.board.challenge(challenge.id).ready, true);
    const before = retries().length;
    await pool.begin(worker);
    await pool.error(worker, "Temporary model failure during local preparation");
    await waitFor(() => retries().length === before + 1, `local retry with ${state} remote`);
  }
  assert.equal(arena.stats.starts, 0);
  run.board.execute("platform", "set_environment", { challenge_id: challenge.id,
    status: "closed", ready: false, online: true });
  const before = retries().length;
  await pool.begin(worker);
  await pool.error(worker, "Temporary failure after materials became unavailable");
  await delay(20);
  assert.equal(retries().length, before);
});

test("quota failure and process recovery preserve local work until the first actual activation", async (t) => {
  const definitions = ["a", "b", "c", "d"].map(unique_code => ({
    unique_code, flag: `flag{${unique_code}}`, container: true,
    handout: { path: "source.txt", content: `${unique_code} source fixture` },
  }));
  const { run, pool, arena, config, create, pump } = await setup(t, definitions);
  const challenges = definitions.map(item => create(item.unique_code));
  const target = challenges[3];
  for (const challenge of challenges.slice(0, 3)) await run.startChallenge(challenge.id);
  await assert.rejects(run.startChallenge(target.id), error => error.code === "environment_limit");
  assert.equal(run.board.challenge(target.id).ready, false);
  await pool.tool("lead", "arena_files", { challenge_id: target.id, prepare_paths: ["source.txt"] });
  await pump();
  const worker = run.board.challenge(target.id).owner_id;
  const context = run.board.context(worker);
  await assert.rejects(run.startChallenge(target.id), error => error.code === "environment_limit");
  await run.reconcileEnvironments();
  assert.equal(run.board.challenge(target.id).ready, true);
  assert.equal(run.board.challenge(target.id).phase, "solving");
  assert.deepEqual(run.board.context(worker), context);
  await run.stop("synthetic_process_restart");
  const recovered = await ContestRun.create(config, { poolFactory: async options => new ScriptedPool(options) });
  t.after(() => recovered.stop("test_complete"));
  await recovered.start();
  assert.equal(recovered.board.challenge(target.id).ready, true);
  assert.deepEqual(recovered.board.context(worker), context);
  const first = recovered.board.challenge(challenges[0].id);
  await recovered.defer({ challenge_id: first.id, expected_revision: first.revision,
    reason: "Release one synthetic remote slot" }, randomUUID());
  await recovered.startChallenge(target.id);
  assert.equal(recovered.board.challenge(target.id).generation, 1);
  assert.equal(recovered.board.challenge(target.id).environment.status, "active");
  assert.deepEqual(recovered.board.context(worker), context);
  const recorded = recovered.board.execute(worker, "post_fact", {
    request_id: randomUUID(), challenge_id: target.id, statement: "Local work survived first activation",
    evidence: [{ type: "text", summary: "Synthetic generation continuity" }],
  }, context);
  assert.equal(recorded.fact.environment_generation, 1);
  assert.equal(arena.stats.activeMax, 3);
});

test("selected preparation never caches itself as a complete offline file listing", async (t) => {
  const { run, pool, create } = await setup(t, [{ unique_code: "offline", container: false, flag: "flag{offline}" }]);
  const challenge = create("offline");
  const downloads = [];
  run.arena.listFiles = async () => [{ path: "source.txt" }, { path: "runtime.txt" }];
  run.arena.readFile = async (_code, path) => {
    downloads.push(path);
    return new Response(`${path} fixture`);
  };
  await pool.tool("lead", "arena_files", { challenge_id: challenge.id, prepare_paths: ["source.txt"] });
  assert.deepEqual(downloads, ["source.txt"]);
  await pool.tool("lead", "arena_files", { challenge_id: challenge.id, path: "runtime.txt" });
  assert.equal(run.board.challenge(challenge.id).ready, true);
  assert.equal((await run.validatePreparedInputs(run.board.challenge(challenge.id))).valid, true);
  const full = await run.prepareOffline();
  assert.equal(full.failed, 0);
  assert.equal(full.tasks[0].materials.scope, "listed");
  assert.equal(full.tasks[0].files.length, 2);
  assert.ok(downloads.includes("runtime.txt"));
});

for (const stage of ["listing", "download"]) test(`preparation rejects a generation change during ${stage}`, async (t) => {
  const { run, pool, create, pump } = await setup(t, [{
    unique_code: "online", container: true, flag: "flag{online}",
    handout: { path: "source.txt", content: "fixture" },
  }]);
  const challenge = create("online");
  await pump();
  run.started = false;
  run.board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "active", ready: true });
  let reachedGate;
  const reached = new Promise(resolve => { reachedGate = resolve; });
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const pause = async () => { reachedGate(); await gate; };
  const listFiles = run.arena.listFiles.bind(run.arena);
  run.arena.listFiles = async (...args) => { if (stage === "listing") await pause(); return listFiles(...args); };
  run.arena.readFile = async () => {
    if (stage === "download") await pause();
    return new Response("old generation fixture");
  };
  const preparation = pool.tool("lead", "arena_files", {
    challenge_id: challenge.id, prepare_paths: ["source.txt"],
  });
  const rejected = assert.rejects(preparation, error => error.code === "stale_context");
  await reached;
  run.board.execute("platform", "set_environment", {
    challenge_id: challenge.id, status: "pending", ready: false, new_generation: true,
  });
  releaseGate();
  await rejected;
  assert.equal(run.board.challenge(challenge.id).generation, 2);
  assert.equal(run.board.challenge(challenge.id).ready, false);
  assert.equal(run.board.getMeta(`offline_prepared:${challenge.id}:2`), null);
});

test("a confirmed remote restart still advances generation and rejects former local contexts", async (t) => {
  const { run, pool, create, pump } = await setup(t, [{
    unique_code: "online", container: true, flag: "flag{online}",
    handout: { path: "source.txt", content: "fixture" },
  }]);
  const challenge = create("online");
  await pool.tool("lead", "arena_files", { challenge_id: challenge.id, prepare_paths: ["source.txt"] });
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  await run.startChallenge(challenge.id);
  const current = run.board.challenge(challenge.id);
  await run.defer({ challenge_id: challenge.id, expected_revision: current.revision,
    reason: "Restart the synthetic remote environment" }, randomUUID());
  const deferred = run.board.challenge(challenge.id);
  await pool.tool("lead", "resume_challenge", { challenge_id: challenge.id, expected_revision: deferred.revision });
  await pump();
  assert.equal(run.board.challenge(challenge.id).generation, 2);
  assert.throws(() => run.board.execute(worker, "post_fact", {
    request_id: randomUUID(), challenge_id: challenge.id, statement: "Old generation result",
    evidence: [{ type: "text", summary: "Old context must be refused" }],
  }, context), error => error.code === "stale_context");
});

test("candidate contract errors are separate from claim conflicts and Lead sees live deadline context", async (t) => {
  const { run, pool, create, pump, review } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  await assert.rejects(pool.tool(worker, "board_act", {
    action: "submit_review", args: { challenge_id: challenge.id, flag: "flag{one}", summary: "Fixture" },
  }), error => error.code === "invalid_argument");
  await assert.rejects(pool.tool(worker, "board_act", {
    action: "submit_review", args: { challenge_id: challenge.id, expected_revision: 1,
      flag: "flag{one}", summary: "Fixture" },
  }), error => error.code === "revision_conflict");
  assert.equal(run.metrics.claim_conflicts, 0);
  assert.equal(run.metrics.tool_errors["board_act.submit_review:invalid_argument"], 1);
  assert.equal(run.metrics.tool_errors["board_act.submit_review:revision_conflict"], 1);
  run.config.arena.expiresAt = Date.now() + 90000;
  await review(challenge.id, "flag{one}");
  await pump();
  const batch = pool.notifications.findLast(notice => notice.id === "lead" && notice.eventId.startsWith("lead-batch:"));
  const clock = notificationPayload(batch).clock;
  assert.ok(clock.remaining_seconds >= 88 && clock.remaining_seconds <= 90);
  assert.equal(clock.expires_at, new Date(run.config.arena.expiresAt).toISOString());
  const snapshot = await pool.tool("lead", "board_read", { view: "task", challenge_id: challenge.id });
  assert.ok(snapshot.remaining_seconds >= 88 && snapshot.remaining_seconds <= 90);
  assert.equal(snapshot.expires_at, clock.expires_at);
});

test("repeat detection separates tools and assignments and does not infer that results are unchanged", async (t) => {
  const { run, create, pump } = await setup(t);
  const challenge = create("one");
  await run.startChallenge(challenge.id);
  await pump();
  const worker = run.board.challenge(challenge.id).owner_id;
  const context = run.board.context(worker);
  const emit = (tool, assignment = context.assignment_id) => run.sessionEvent({
    type: "tool_end", agentId: worker, tool, args_digest: "same-args", isError: false,
    context: { ...context, assignment_id: assignment },
  });
  const cursor = run.board.getMeta("event_cursor");
  emit("bash");
  emit("bash");
  emit("board_read");
  emit("bash", "prior-assignment");
  emit("bash");
  assert.equal(run.board.events(cursor).filter(event => event.type === "progress.stalled").length, 0);
  emit("bash");
  emit("bash");
  const notices = run.board.events(cursor).filter(event => event.type === "progress.stalled");
  assert.equal(notices.length, 1);
  assert.match(notices[0].reason, /inspect its results/);
  assert.doesNotMatch(notices[0].reason, /without a new result/);
});
