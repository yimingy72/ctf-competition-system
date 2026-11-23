import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Board, ASSISTANCE_REMINDER_MS } from "../src/board.mjs";

function setup(t, count = 20) {
  let time = 1000;
  const directory = mkdtempSync(join(tmpdir(), "bbx-ctf-board-"));
  const path = join(directory, "board.sqlite");
  const board = new Board({ path, initialWorkers: count, clock: () => time });
  t.after(() => { board.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const worker of board.workers()) board.execute("platform", "worker_ready", { worker_id: worker.id });
  const lead = (action, args = {}) => board.execute("lead", action, { request_id: randomUUID(), ...args });
  const create = (args = {}) => lead("create_challenge", { unique_code: randomUUID(), title: "Fixture", ...args });
  const call = (workerId, action, args = {}, context = board.context(workerId)) => {
    const challenge = board.challenge(context.challenge_id ?? args.challenge_id);
    return board.execute(workerId, action, {
      request_id: randomUUID(),
      ...(action === "claim"
        ? { expected_claim_revision: challenge.claim_revision }
        : { expected_revision: challenge.revision }),
      ...args,
    }, context);
  };
  return { board, path, lead, create, call, advance: (delta) => { time += delta; } };
}
function fact(call, worker, challenge, extra = {}) {
  return call(worker, "post_fact", { challenge_id: challenge, statement: "The fixture has an input",
    kind: "observation", evidence: [{ type: "text", summary: "Read fixture description" }], ...extra }).fact;
}
function intent(call, worker, challenge, basis, extra = {}) {
  return call(worker, "post_intent", { challenge_id: challenge, statement: "Inspect an input",
    expected: "A reproducible result", method: "Read the fixture", based_on: [basis], ...extra }).intent;
}
function review(call, worker, challenge, flag = "flag{fixture}") {
  return call(worker, "submit_review", { challenge_id: challenge, flag, summary: "Candidate from fixture" });
}
function accepted(board, lead, call, worker, challenge) {
  const result = review(call, worker, challenge);
  const started = lead("begin_submission", { challenge_id: challenge, candidate_id: result.candidate.id,
    review_revision: result.challenge.review_revision, expected_revision: board.challenge(challenge).revision });
  board.execute("platform", "submission_result", { submission_id: started.submission.id, status: "accepted", receipt: { correct: true, awarded: 0 } });
}
function fails(fn, code) { assert.throws(fn, (error) => error.code === code); }

test("twenty Workers start as records and preparation reports real readiness", (t) => {
  const board = new Board(); t.after(() => board.close());
  assert.equal(board.workers().length, 20);
  assert.ok(board.workers().every((item) => item.status === "starting" && !item.has_worked));
  const request = { request_id: "grow", target_total: 22 };
  const first = board.execute("lead", "grow_workers", request);
  assert.deepEqual(first.created, ["worker-21", "worker-22"]);
  assert.deepEqual(first.succeeded, []);
  board.execute("platform", "worker_ready", { worker_id: "worker-21" });
  board.execute("platform", "worker_failed", { worker_id: "worker-22", error: "Preparation failed" });
  const again = board.execute("lead", "grow_workers", request);
  assert.deepEqual(again.succeeded, ["worker-21"]);
  assert.deepEqual(again.failed, [{ worker_id: "worker-22", error: "Preparation failed" }]);
  const retry = board.execute("lead", "grow_workers", { request_id: "retry", target_total: 22 });
  assert.deepEqual(retry.created, ["worker-23"]);
  assert.equal(board.workers().length, 23);
  fails(() => board.execute("lead", "grow_workers", { ...request, target_total: 23 }), "request_conflict");
});

test("a configured namespace keeps challenge identity stable within one attempt", (t) => {
  const first = new Board({ initialWorkers: 0 });
  const second = new Board({ initialWorkers: 0 });
  const other = new Board({ initialWorkers: 0 });
  t.after(() => {
    first.close();
    second.close();
    other.close();
  });
  first.setMeta("challenge_namespace", "attempt-a");
  second.setMeta("challenge_namespace", "attempt-a");
  other.setMeta("challenge_namespace", "attempt-b");
  const create = board => board.execute("lead", "create_challenge", {
    request_id: `create-${board === first ? "first" : board === second ? "second" : "other"}`,
    unique_code: "same-code",
    title: "Stable fixture",
  });
  const firstChallenge = create(first);
  const secondChallenge = create(second);
  const otherChallenge = create(other);
  assert.equal(firstChallenge.id, secondChallenge.id);
  assert.notEqual(firstChallenge.id, otherChallenge.id);
  assert.match(firstChallenge.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("a prepared Worker can be quarantined after a later session recovery failure", (t) => {
  const { board } = setup(t, 2);
  const worker = board.workers().find(item => item.id === "worker-2");
  board.execute("platform", "activity", {
    worker_id: worker.id,
    context: board.context(worker.id),
    running: true,
  });
  board.execute("platform", "worker_failed", {
    worker_id: worker.id,
    error: "Persisted session could not be restored",
  });
  const failed = board.workers().find(item => item.id === worker.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.active, false);
  assert.equal(failed.execution_context, null);
  assert.match(failed.error, /could not be restored/);
});

test("20 Workers start one primary on each of 20 hard challenges before assistance", (t) => {
  const { board, create } = setup(t);
  const challenges = Array.from({ length: 20 }, (_, index) => create({ title: String(index), difficulty: "hard" }));
  const dispatched = board.execute("platform", "dispatch");
  assert.equal(dispatched.assignments.length, 20);
  assert.equal(new Set(dispatched.assignments.map((item) => item.challenge.id)).size, 20);
  assert.equal(dispatched.available.new_challenges.length, 0);
  assert.ok(dispatched.assignments.every((item) => item.challenge.members.length === 1));
  assert.ok(dispatched.assignments.every((item) => item.challenge.members[0]?.role === "primary"));
  assert.ok(challenges.every((challenge) => board.challenge(challenge.id).phase === "assembling"));
  assert.ok(challenges.every((challenge) => board.challenge(challenge.id).needs_assistance));
  assert.equal(board.snapshot("lead").challenges.length, challenges.length);
  const cursor = board.getMeta("event_cursor");
  assert.deepEqual(board.execute("platform", "dispatch").assignments, []);
  assert.equal(board.getMeta("event_cursor"), cursor);
});

test("Lead priority controls dispatch order for offline and online challenges", (t) => {
  const { board, create } = setup(t, 2);
  const online = create({ priority: 3, requires_online_environment: true });
  const offline = create({ priority: 0, requires_online_environment: false });
  const assigned = board.execute("platform", "dispatch").assignments;
  assert.equal(assigned[0].challenge.id, offline.id);
  assert.equal(assigned[1].challenge.id, online.id);
});

test("a hard primary starts assembling and receives its assistant before solving", (t) => {
  const { board, create, advance } = setup(t, 1);
  const challenge = create({ difficulty: "hard" });
  const dispatched = board.execute("platform", "dispatch");
  assert.equal(dispatched.assignments.length, 1);
  assert.equal(board.challenge(challenge.id).phase, "assembling");
  assert.equal(board.challenge(challenge.id).owner_id, "worker-1");
  assert.equal(board.challenge(challenge.id).solve_started_at, null);
  assert.equal(board.challenge(challenge.id).needs_assistance, true);
  advance(10 * 60 * 1000);
  assert.deepEqual(board.execute("platform", "tick").reminded, []);
  const grown = board.execute("lead", "grow_workers", { request_id: "grow", target_total: 2 });
  board.execute("platform", "worker_ready", { worker_id: grown.created[0] });
  assert.equal(board.execute("platform", "dispatch").assignments.length, 1);
  const solving = board.challenge(challenge.id);
  assert.equal(solving.phase, "solving");
  assert.equal(solving.members.length, 2);
  assert.equal(solving.solve_started_at, 10 * 60 * 1000 + 1000);
});

test("a hard primary can record and submit work while assistance is assembling", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  const basis = fact(call, "worker-1", challenge.id);
  const direction = intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  assert.equal(board.challenge(challenge.id).facts.length, 1);
  assert.equal(board.challenge(challenge.id).intents[0].id, direction.id);
  review(call, "worker-1", challenge.id);
  assert.equal(board.challenge(challenge.id).phase, "reviewing");
  lead("reject_review", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    review_revision: 1,
    reason: "Needs an independent second perspective",
  });
  assert.equal(board.challenge(challenge.id).phase, "assembling");
  assert.equal(board.challenge(challenge.id).solve_started_at, null);
});

test("hard challenges get a primary and assistant; same team knowledge syncs", (t) => {
  const { board, create, call } = setup(t, 4);
  const challenge = create({ multi_stage: true });
  assert.equal(challenge.difficulty, "hard");
  const assigned = board.execute("platform", "dispatch").assignments;
  assert.equal(assigned.length, 2);
  const [primary, assistant] = assigned.map((item) => item.worker_id);
  const eventCursor = board.getMeta("event_cursor");
  const observation = fact(call, assistant, challenge.id);
  assert.equal(observation.author, assistant);
  const event = board.events(eventCursor).at(-1);
  assert.deepEqual(new Set(event.worker_ids), new Set([primary, assistant]));
  assert.equal(board.challenge(challenge.id).owner_id, primary);
  fails(() => board.snapshot("worker-3", { challengeId: challenge.id }), "forbidden");
});

test("team_ready is emitted only for the assembling to solving transition", (t) => {
  const { board, create, call } = setup(t, 3);
  const challenge = create({ difficulty: "hard" });
  const cursor = board.getMeta("event_cursor");
  board.execute("platform", "dispatch");
  const initial = board.events(cursor).filter((event) => event.type === "worker.assigned");
  assert.equal(initial.length, 2);
  assert.equal(initial[0].team_ready, false);
  assert.equal(initial.filter((event) => event.team_ready).length, 1);
  const basis = fact(call, "worker-1", challenge.id);
  const direction = intent(call, "worker-1", challenge.id, basis.id, {
    parallel: true,
    parallel_key: "independent-direction",
  });
  call("worker-1", "request_assistance", {
    challenge_id: challenge.id,
    reason: "An independent direction is ready",
    intent_ids: [direction.id],
  });
  const assistanceCursor = board.getMeta("event_cursor");
  board.execute("platform", "dispatch");
  const later = board.events(assistanceCursor).filter((event) => event.type === "worker.assigned");
  assert.equal(later.length, 1);
  assert.equal(later[0].team_ready, false);
});

test("ready parallel directions open assistance seats and cap at nine", (t) => {
  const { board, create, call } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  board.execute("platform", "activity", {
    worker_id: "worker-1",
    context: board.context("worker-1"),
    running: true,
  });
  const basis = fact(call, "worker-1", challenge.id);
  for (let index = 0; index < 9; index++) {
    intent(call, "worker-1", challenge.id, basis.id, {
      parallel: true,
      parallel_key: `capacity-${index}`,
    });
  }
  assert.equal(board.challenge(challenge.id).assistance_target, 9);
  const alreadyOpen = call("worker-1", "request_assistance", {
    challenge_id: challenge.id,
    reason: "No new independent capacity",
  });
  assert.equal(alreadyOpen.assistance_already_open, true);
  assert.equal(board.challenge(challenge.id).assistance_target, 9);
});

test("explicit assistance confirmation is idempotent after a parallel Intent auto-opens the seat", (t) => {
  const { board, create, call } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  board.execute("platform", "activity", {
    worker_id: "worker-1",
    context: board.context("worker-1"),
    running: true,
  });
  const basis = fact(call, "worker-1", challenge.id);
  const direction = intent(call, "worker-1", challenge.id, basis.id, {
    parallel: true,
    parallel_key: "already-open",
  });
  assert.equal(board.challenge(challenge.id).assistance_target, 1);
  const receipt = call("worker-1", "request_assistance", {
    challenge_id: challenge.id,
    reason: "Confirm the automatically opened assistance slot",
    intent_ids: [direction.id],
  });
  assert.equal(receipt.assistance_already_open, true);
  assert.equal(receipt.assistance_target, 1);
});

test("request_assistance requires a current direction or concrete blocker", (t) => {
  const { board, create, call } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  fails(() => call("worker-1", "request_assistance", {
    challenge_id: challenge.id,
    reason: "More people might help",
  }), "assistance_evidence_required");
  const blocker = fact(call, "worker-1", challenge.id, {
    statement: "The only current path needs an unavailable server component",
  });
  call("worker-1", "request_assistance", {
    challenge_id: challenge.id,
    reason: "The blocker needs an independent workaround",
    blocker_fact_id: blocker.id,
  });
  assert.equal(board.challenge(challenge.id).assistance_target, 1);
  assert.equal(board.challenge(challenge.id).assistance_blocker_facts[0].fact_id, blocker.id);
  fails(() => call("worker-1", "request_assistance", {
    challenge_id: challenge.id,
    reason: "Repeat the same blocker",
    blocker_fact_id: blocker.id,
  }), "assistance_evidence_required");
  fact(call, "worker-1", challenge.id, {
    statement: "The reported blocker is contradicted by a local control test",
    disputes: [blocker.id],
  });
  assert.equal(board.challenge(challenge.id).assistance_target, 0);
  fails(() => call("worker-1", "request_assistance", {
    challenge_id: challenge.id,
    reason: "Use the disputed blocker",
    blocker_fact_id: blocker.id,
  }), "invalid_reference");
});

test("lowering difficulty removes the default hard assistance target", (t) => {
  const { board, create, lead } = setup(t, 2);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  assert.equal(board.challenge(challenge.id).assistance_target, 1);
  lead("update_challenge", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    difficulty: "medium",
  });
  assert.equal(board.challenge(challenge.id).assistance_target, 0);
});

test("downgrading a hard challenge preserves evidence-backed assistance", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  board.execute("platform", "activity", {
    worker_id: "worker-1",
    context: board.context("worker-1"),
    running: true,
  });
  const basis = fact(call, "worker-1", challenge.id);
  for (const parallelKey of ["downgrade-a", "downgrade-b"]) {
    intent(call, "worker-1", challenge.id, basis.id, { parallel: true, parallel_key: parallelKey });
  }
  assert.equal(board.challenge(challenge.id).assistance_target, 3);
  lead("update_challenge", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    difficulty: "medium",
  });
  assert.equal(board.challenge(challenge.id).assistance_target, 2);
});

test("upgrading to hard pauses timing while downgrading preserves explicit assistance", (t) => {
  const { board, create, call, lead, advance } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  advance(5000);
  board.execute("platform", "activity", {
    worker_id: "worker-1",
    context: board.context("worker-1"),
    running: true,
  });
  const basis = fact(call, "worker-1", challenge.id);
  for (const parallelKey of ["upgrade-a", "upgrade-b"]) {
    intent(call, "worker-1", challenge.id, basis.id, { parallel: true, parallel_key: parallelKey });
  }
  assert.equal(board.challenge(challenge.id).assistance_target, 2);
  lead("update_challenge", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    difficulty: "hard",
  });
  const assembling = board.challenge(challenge.id);
  assert.equal(assembling.phase, "assembling");
  assert.equal(assembling.assistance_target, 3);
  assert.equal(assembling.solve_started_at, null);
  assert.equal(assembling.solve_elapsed_ms, 5000);
  advance(5000);
  lead("update_challenge", {
    challenge_id: challenge.id,
    expected_revision: assembling.revision,
    difficulty: "medium",
  });
  const downgraded = board.challenge(challenge.id);
  assert.equal(downgraded.phase, "solving");
  assert.equal(downgraded.assistance_target, 2);
  assert.equal(downgraded.solve_started_at, 1000 + 10_000);
});

test("Lead can defer an assembling hard challenge", (t) => {
  const { board, create, call, lead } = setup(t, 3);
  const seed = create();
  board.execute("platform", "dispatch");
  accepted(board, lead, call, "worker-1", seed.id);
  board.execute("platform", "release_finished");
  const challenge = create({ difficulty: "hard" });
  call("worker-1", "claim", { challenge_id: challenge.id });
  assert.equal(board.challenge(challenge.id).phase, "assembling");
  lead("defer", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    reason: "Pairing cannot complete with current resources",
  });
  assert.equal(board.challenge(challenge.id).phase, "deferred");
});

test("subsequent tasks are chosen in an active idle response with frozen identity", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const a = create();
  board.execute("platform", "dispatch");
  accepted(board, lead, call, "worker-1", a.id);
  assert.deepEqual(board.execute("platform", "release_finished").released, ["worker-1"]);
  const b = create();
  const next = board.execute("platform", "dispatch");
  assert.equal(next.assignments.length, 0);
  assert.equal(next.notifications[0].worker_id, "worker-1");
  const idle = board.context("worker-1");
  board.execute("platform", "activity", { worker_id: "worker-1", context: idle, running: true });
  const args = { request_id: "claim-b", challenge_id: b.id, expected_revision: b.revision };
  const selected = board.execute("worker-1", "claim", args, idle);
  assert.equal(selected.challenge.id, b.id);
  assert.equal(board.execute("worker-1", "claim", args, idle).context.assignment_id, selected.context.assignment_id);
  fails(() => call("worker-1", "post_fact", { challenge_id: b.id, statement: "Stale", evidence: [{type:"text",summary:"stale"}] }, idle), "stale_context");
  board.execute("platform", "activity", { worker_id: "worker-1", context: idle, running: false });
  assert.equal(fact(call, "worker-1", b.id).assignment_ref.assignment_id, selected.context.assignment_id);
});

test("new work outranks assistance during dispatch", (t) => {
  const { board, create, call } = setup(t, 4);
  const assistance = create();
  board.execute("platform", "dispatch");
  board.execute("platform", "activity", {
    worker_id: "worker-1",
    context: board.context("worker-1"),
    running: true,
  });
  const basis = fact(call, "worker-1", assistance.id);
  intent(call, "worker-1", assistance.id, basis.id, {
    parallel: true,
    parallel_key: "second-direction",
  });
  assert.equal(board.challenge(assistance.id).assistance_target, 1);
  const fresh = create();
  const dispatched = board.execute("platform", "dispatch");
  assert.equal(dispatched.assignments[0].challenge.id, fresh.id);
  assert.equal(dispatched.assignments[1].challenge.id, assistance.id);
});

test("a Worker cannot claim assistance while any new challenge is available", (t) => {
  const { board, create, call, lead } = setup(t, 2);
  const assisted = create();
  board.execute("platform", "dispatch");
  board.execute("platform", "activity", {
    worker_id: "worker-1",
    context: board.context("worker-1"),
    running: true,
  });
  const basis = fact(call, "worker-1", assisted.id);
  intent(call, "worker-1", assisted.id, basis.id, {
    parallel: true,
    parallel_key: "assistance-direction",
  });
  const releasedWork = create();
  board.execute("platform", "dispatch");
  accepted(board, lead, call, "worker-2", releasedWork.id);
  board.execute("platform", "release_finished");
  create();
  fails(() => call("worker-2", "claim", { challenge_id: assisted.id }), "work_changed");
});

test("competing claims fail without assigning an alternative challenge", (t) => {
  const { board, create, call, lead } = setup(t, 2);
  const firstSeed = create();
  const secondSeed = create();
  board.execute("platform", "dispatch");
  accepted(board, lead, call, "worker-1", firstSeed.id);
  accepted(board, lead, call, "worker-2", secondSeed.id);
  board.execute("platform", "release_finished");
  const fresh = create();
  const claimRevision = fresh.claim_revision;
  call("worker-1", "claim", { challenge_id: fresh.id, expected_claim_revision: claimRevision });
  fails(() => call("worker-2", "claim", { challenge_id: fresh.id, expected_claim_revision: claimRevision }), "work_changed");
  assert.equal(board.context("worker-2").assignment_id, null);
});

test("claim revision changes only when claimability changes", (t) => {
  const { board, create, call } = setup(t, 2);
  const challenge = create();
  board.execute("platform", "dispatch");
  const assigned = board.challenge(challenge.id);
  const claimRevision = assigned.claim_revision;
  assert.ok(claimRevision > 1);
  fact(call, "worker-1", challenge.id);
  assert.equal(board.challenge(challenge.id).claim_revision, claimRevision);
  intent(call, "worker-1", challenge.id, board.challenge(challenge.id).facts[0].id);
  assert.equal(board.challenge(challenge.id).claim_revision, claimRevision);
  review(call, "worker-1", challenge.id);
  assert.ok(board.challenge(challenge.id).claim_revision > claimRevision);
});

test("board views return incremental entity bodies and exact entity reads", (t) => {
  const { board, create, call, lead } = setup(t, 2);
  const challenge = create();
  board.execute("platform", "dispatch");
  const cursor = board.getMeta("event_cursor");
  const saved = fact(call, "worker-1", challenge.id);
  const direction = intent(call, "worker-1", challenge.id, saved.id);
  lead("update_challenge", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    title: "Updated fixture",
  });
  const updates = board.snapshot("worker-1", {
    view: "updates",
    challengeId: challenge.id,
    sinceRevision: cursor,
  });
  const factChange = updates.changes.find((change) => change.entity === "fact");
  assert.equal(factChange.data.statement, saved.statement);
  assert.equal(factChange.data.evidence[0].summary, "Read fixture description");
  const challengeChange = updates.changes.find((change) => change.entity === "challenge");
  assert.equal(challengeChange.data.id, challenge.id);
  assert.equal(Object.hasOwn(challengeChange.data, "facts"), false);
  assert.equal(Object.hasOwn(challengeChange.data, "intents"), false);
  const compactFact = board._eventChange(board.events().find((event) => event.fact_id === saved.id));
  assert.equal(compactFact.data.kind, "observation");
  assert.equal(compactFact.data.provenance, "self_reported");
  assert.equal(compactFact.data.environment_generation, saved.environment_generation);
  assert.equal(Object.hasOwn(compactFact.data, "evidence"), false);
  assert.equal(Object.hasOwn(compactFact.data, "notes"), false);
  assert.equal(Object.hasOwn(compactFact.data, "disputes"), false);
  assert.equal(Object.hasOwn(compactFact.data, "disputed_by"), false);
  assert.equal(Object.hasOwn(compactFact.data, "disputed_refs"), false);
  assert.ok(updates.changes.some((change) => change.entity === "intent"
    && change.data.statement === direction.statement));
  assert.equal(updates.next_cursor, board.getMeta("event_cursor"));
  const task = board.snapshot("worker-1", { view: "task", challengeId: challenge.id });
  assert.equal(task.challenge.id, challenge.id);
  assert.equal(task.event_cursor, board.getMeta("event_cursor"));
  const entity = board.snapshot("worker-1", {
    view: "entity",
    entityKind: "fact",
    entityId: saved.id,
  });
  assert.equal(entity.data.id, saved.id);
  assert.equal(entity.data.evidence[0].summary, "Read fixture description");
});

test("compact Fact events retain inference provenance without promoting it to truth", (t) => {
  const { board, create, call } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "set_environment", {
    challenge_id: challenge.id, status: "active", ready: true, new_generation: true,
  });
  board.execute("platform", "dispatch");
  const basis = fact(call, "worker-1", challenge.id);
  const artifact = board.execute("platform", "register_artifact", {
    challenge_id: challenge.id, worker_id: "worker-1", context: board.context("worker-1"),
    path: "/workspace/fixture-output", uri: "artifacts/fixture-output", sha256: "a".repeat(64),
    size: 4, call_id: "fixture-tool-call",
  });
  const inferred = fact(call, "worker-1", challenge.id, {
    kind: "inference", derived_from: [basis.id],
    evidence: [{ artifact_id: artifact.id, summary: "The output supports this hypothesis" }],
  });
  const change = board._eventChange(board.events().find(event => event.fact_id === inferred.id));
  assert.equal(change.data.kind, "inference");
  assert.equal(change.data.provenance, "tool_backed");
  assert.equal(change.data.environment_generation, 2);
  assert.equal(change.data.status, "proposed");
  assert.deepEqual(change.data.derived_from, [basis.id]);
  assert.equal(change.data.artifact_refs[0].id, artifact.id);
});

test("submission event summaries retain only compact receipt fields", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const reviewed = review(call, "worker-1", challenge.id);
  const started = lead("begin_submission", {
    challenge_id: challenge.id,
    candidate_id: reviewed.candidate.id,
    review_revision: reviewed.challenge.review_revision,
  });
  board.execute("platform", "submission_result", {
    submission_id: started.submission.id,
    status: "accepted",
    challenge_completed: true,
    reason: "Official flag accepted",
    receipt: {
      correct: true,
      correct_flag_count: 2,
      total_flag_count: 2,
      cumulative_score: 100,
      logs: ["full official response body"],
      nested: { evidence: "must not be projected" },
    },
  });
  const event = board.events().find((item) => item.type === "submission.accepted");
  const change = board._eventChange(event);
  assert.equal(change.data.status, "accepted");
  assert.equal(change.data.correct, true);
  assert.equal(change.data.correct_flag_count, 2);
  assert.equal(change.data.total_flag_count, 2);
  assert.equal(change.data.cumulative_score, 100);
  assert.equal(change.data.challenge_completed, true);
  assert.equal(Object.hasOwn(change.data, "receipt"), false);
  assert.equal(Object.hasOwn(change.data, "logs"), false);
  assert.equal(Object.hasOwn(change.data, "nested"), false);
});

test("post_fact can atomically publish next Intents and independent appends ignore stale revisions", (t) => {
  const { board, create, call } = setup(t, 2);
  const challenge = create();
  board.execute("platform", "dispatch");
  const staleRevision = board.challenge(challenge.id).revision;
  const result = call("worker-1", "post_fact", {
    challenge_id: challenge.id,
    expected_revision: staleRevision,
    statement: "The parser reaches a controllable return",
    evidence: [{ type: "text", summary: "Local reproduction" }],
    next_intents: [{
      statement: "Build a minimal control-flow proof",
      expected: "The return address becomes controllable",
      method: "Use the parser output as a local fixture",
    }],
  });
  assert.equal(result.intents.length, 1);
  assert.equal(result.intents[0].based_on[0], result.fact.id);
  const later = call("worker-1", "post_intent", {
    challenge_id: challenge.id,
    expected_revision: staleRevision,
    statement: "Check the second independent path",
    based_on: [result.fact.id],
    expected: "A second path reaches the same sink",
    method: "Compare both parser branches",
  });
  assert.equal(later.intent.statement, "Check the second independent path");
  assert.equal(board.challenge(challenge.id).facts.length, 1);
  assert.equal(board.challenge(challenge.id).intents.length, 2);
});

test("worker failure atomically releases assignment, owner and held Intent", (t) => {
  const { board, create, call } = setup(t, 2);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  const basis = fact(call, "worker-1", challenge.id);
  const direction = intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  const before = board.challenge(challenge.id);
  board.execute("platform", "worker_failed", {
    worker_id: "worker-1",
    error: "Provider permission_error: insufficient balance",
  });
  const after = board.challenge(challenge.id);
  assert.equal(after.owner_id, null);
  assert.equal(after.members.some((member) => member.worker_id === "worker-1"), false);
  assert.equal(after.intents.find((item) => item.id === direction.id).status, "open");
  assert.equal(after.intents.find((item) => item.id === direction.id).holder, null);
  assert.ok(after.claim_revision > before.claim_revision);
  assert.equal(board.context("worker-1").assignment_id, null);
});

test("catalog completion reconciles a stale pending challenge without recreating it", (t) => {
  const { board, create } = setup(t, 1);
  const challenge = create();
  const before = board.challenge(challenge.id);
  const receipt = board.execute("platform", "reconcile_completed", {
    challenge_id: challenge.id,
  });
  const after = board.challenge(challenge.id);
  assert.equal(receipt.phase, "completed");
  assert.equal(after.phase, "completed");
  assert.equal(after.ready, false);
  assert.equal(after.environment.status, "closed");
  assert.ok(after.claim_revision > before.claim_revision);
});

test("subsequent claims may start multiple hard challenges before assistance", (t) => {
  const { board, create, call, lead } = setup(t, 4);
  const seed = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  accepted(board, lead, call, "worker-1", seed.id);
  board.execute("platform", "release_finished");
  const first = create({ difficulty: "hard" });
  const second = create({ difficulty: "hard" });
  call("worker-1", "claim", { challenge_id: first.id });
  assert.equal(board.challenge(first.id).phase, "assembling");
  call("worker-2", "claim", { challenge_id: second.id });
  assert.equal(board.challenge(first.id).phase, "assembling");
  assert.equal(board.challenge(second.id).phase, "assembling");
  assert.equal(board.challenge(first.id).members.length, 1);
  assert.equal(board.challenge(second.id).members.length, 1);
});

test("an already-worked Worker can claim online work when Lead leaves it unclaimed", (t) => {
  const { board, create, call, lead } = setup(t, 2);
  const seed = create();
  board.execute("platform", "dispatch");
  accepted(board, lead, call, "worker-1", seed.id);
  board.execute("platform", "release_finished");
  const online = create({ requires_online_environment: true, priority: 0 });
  const offline = create({ requires_online_environment: false, priority: 3 });
  call("worker-1", "claim", { challenge_id: online.id });
  assert.equal(board.context("worker-1").challenge_id, online.id);
  assert.equal(board.challenge(offline.id).owner_id, null);
});

test("Intent facts, ownership, three holdings and parallel direction dependencies", (t) => {
  const { board, create, call } = setup(t, 12);
  const challenge = create(); board.execute("platform", "dispatch");
  const basis = fact(call, "worker-1", challenge.id);
  const first = intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  fails(() => intent(call, "worker-1", challenge.id, basis.id, { claim: true }), "intent_limit");
  assert.equal(board.challenge(challenge.id).intents.length, 3);
  intent(call, "worker-1", challenge.id, basis.id, { parallel: true, parallel_key: "branch-a", depends_on: [first.id] });
  assert.equal(board.challenge(challenge.id).assistance_target, 0);
  fact(call, "worker-1", challenge.id, { resolves: first.id, result: "confirmed" });
  assert.equal(board.challenge(challenge.id).assistance_target, 1);
  board.execute("platform", "dispatch");
  fails(() => fact(call, "worker-2", challenge.id, { resolves: board.challenge(challenge.id).intents[1].id, result: "confirmed" }), "intent_not_held");
  fails(() => intent(call, "worker-1", challenge.id, basis.id, { parallel: true, parallel_key: "branch-a" }), "duplicate_direction");
  for (let index = 0; index < 15; index++) intent(call, "worker-1", challenge.id, basis.id, { parallel: true, parallel_key: `other-${index}` });
  board.execute("platform", "dispatch");
  assert.equal(board.challenge(challenge.id).members.length, 10);
  assert.equal(board.challenge(challenge.id).assistance_target, 9);
  const held = board.challenge(challenge.id).intents.find((item) => item.status === "claimed");
  call("worker-1", "release_intent", { challenge_id: challenge.id, intent_id: held.id, note: "Use another direction" });
  assert.equal(board.challenge(challenge.id).intents.find((item) => item.id === held.id).attempts, 1);
});

test("references are scoped and immutable file evidence keeps the registered version", (t) => {
  const { board, create, call } = setup(t, 2);
  const a = create(); const b = create(); board.execute("platform", "dispatch");
  const first = fact(call, "worker-1", a.id);
  fails(() => fact(call, "worker-2", b.id, { kind: "inference", derived_from: [first.id] }), "invalid_reference");
  fails(() => fact(call, "worker-1", a.id, { evidence: [{ type: "file", path: "/tmp/x", sha256: "a".repeat(64), summary: "Forged" }] }), "invalid_evidence");
  const artifact = board.execute("platform", "register_artifact", { challenge_id: a.id,
    worker_id: "worker-1", context: board.context("worker-1"), path: "/workspace/output", uri: "artifacts/one",
    sha256: "a".repeat(64), size: 4, call_id: "tool-call-1" });
  const saved = fact(call, "worker-1", a.id, { evidence: [{ artifact_id: artifact.id, summary: "Captured output" }] });
  board.execute("platform", "register_artifact", { challenge_id: a.id, worker_id: "worker-1",
    context: board.context("worker-1"), path: "/workspace/output", uri: "artifacts/two", sha256: "b".repeat(64), size: 5 });
  assert.equal(saved.evidence[0].sha256, "a".repeat(64));
  assert.equal(saved.provenance, "tool_backed");
  fact(call, "worker-1", a.id, { disputes: [first.id] });
  const old = board.challenge(a.id).facts.find((item) => item.id === first.id);
  assert.equal(old.statement, first.statement);
  assert.equal(old.status, "disputed");
});

test("Fact disputes are permanent, deduplicated, versioned and projected", (t) => {
  const { board, create, lead, call } = setup(t, 2);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  const other = create();
  const original = fact(call, "worker-1", challenge.id);
  const dispute = fact(call, "worker-2", challenge.id, {
    statement: "The fixture input is synthetic",
    disputes: [original.id, original.id],
  });
  const firstDisputed = board.challenge(challenge.id).facts.find(item => item.id === original.id);
  assert.equal(firstDisputed.status, "disputed");
  assert.equal(firstDisputed.version, original.version + 1);
  assert.deepEqual(firstDisputed.disputed_by, [dispute.id]);
  const persistedTarget = board._get("fact", original.id);
  assert.equal(persistedTarget.status, "proposed");
  assert.equal(Object.hasOwn(persistedTarget, "disputed_by"), false);

  const cursor = board.getMeta("event_cursor");
  const counterDispute = fact(call, "worker-1", challenge.id, {
    statement: "The synthetic fixture still exercises the parser",
    disputes: [dispute.id],
  });
  const facts = board.challenge(challenge.id).facts;
  assert.equal(facts.find(item => item.id === original.id).status, "disputed");
  assert.deepEqual(facts.find(item => item.id === dispute.id).disputed_by, [counterDispute.id]);

  const posted = board.events().find(event => event.fact_id === dispute.id);
  const change = board._eventChange(posted);
  assert.equal(change.data.disputed_refs[0].id, original.id);
  assert.equal(change.data.disputed_refs[0].environment_generation, challenge.generation);
  assert.equal(Object.hasOwn(change.data.disputed_refs[0], "evidence"), false);
  assert.equal(Object.hasOwn(change.data.disputed_refs[0], "version"), false);
  const updates = board.snapshot("worker-2", {
    view: "updates", challengeId: challenge.id, sinceRevision: cursor,
  });
  const counterChange = updates.changes.find(item => item.entity === "fact" && item.id === counterDispute.id);
  assert.deepEqual(counterChange.data.disputes, [dispute.id]);
  assert.ok(Array.isArray(counterChange.data.disputed_by));

  const entity = board.snapshot("worker-1", {
    view: "entity", entityKind: "fact", entityId: original.id,
  });
  assert.equal(entity.data.status, "disputed");
  assert.deepEqual(entity.data.disputed_by, [dispute.id]);

  const foreign = lead("post_fact", {
    challenge_id: other.id,
    statement: "A different challenge has its own fact",
    evidence: [{ type: "text", summary: "Separate fixture" }],
  }).fact;
  fails(() => fact(call, "worker-2", challenge.id, { disputes: [foreign.id] }), "invalid_reference");
  fails(() => fact(call, "worker-2", challenge.id, { disputes: [randomUUID()] }), "invalid_reference");
});

test("replaying a dispute request does not duplicate versions or relations", (t) => {
  const { board, create, call } = setup(t, 2);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  const target = fact(call, "worker-1", challenge.id);
  const context = board.context("worker-2");
  const args = {
    request_id: "replayed-fact-dispute",
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    statement: "Replay-safe counterevidence",
    evidence: [{ type: "text", summary: "Replay fixture" }],
    disputes: [target.id],
  };
  const first = board.execute("worker-2", "post_fact", args, context);
  const beforeReplay = board.challenge(challenge.id).facts.find(item => item.id === target.id);
  const eventCursor = board.getMeta("event_cursor");
  const replay = board.execute("worker-2", "post_fact", args, context);
  const afterReplay = board.challenge(challenge.id).facts.find(item => item.id === target.id);
  assert.deepEqual(replay, first);
  assert.equal(afterReplay.version, beforeReplay.version);
  assert.deepEqual(afterReplay.disputed_by, beforeReplay.disputed_by);
  assert.equal(board.getMeta("event_cursor"), eventCursor);

  const basis = fact(call, "worker-1", challenge.id);
  const intentTarget = intent(call, "worker-1", challenge.id, basis.id);
  const intentArgs = {
    request_id: "replayed-intent-dispute",
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    statement: "Replay-safe direction dispute",
    based_on: [basis.id],
    expected: "A distinct replay result",
    method: "Run the replay direction",
    disputes: [intentTarget.id],
  };
  const firstIntent = board.execute("worker-2", "post_intent", intentArgs, context).intent;
  const beforeIntentReplay = board.challenge(challenge.id).intents.find(item => item.id === intentTarget.id);
  const intentCursor = board.getMeta("event_cursor");
  const replayIntent = board.execute("worker-2", "post_intent", intentArgs, context).intent;
  const afterIntentReplay = board.challenge(challenge.id).intents.find(item => item.id === intentTarget.id);
  assert.deepEqual(replayIntent, firstIntent);
  assert.equal(afterIntentReplay.version, beforeIntentReplay.version);
  assert.deepEqual(afterIntentReplay.disputed_by, beforeIntentReplay.disputed_by);
  assert.equal(board.getMeta("event_cursor"), intentCursor);
});

test("a failed next Intent rolls back the Fact and every dispute mutation", (t) => {
  const { board, create, call } = setup(t, 2);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  const target = fact(call, "worker-1", challenge.id);
  const before = board.challenge(challenge.id);
  const cursor = board.getMeta("event_cursor");
  assert.throws(() => board.execute("worker-2", "post_fact", {
    request_id: "rollback-disputed-next-intents",
    challenge_id: challenge.id,
    expected_revision: before.revision,
    statement: "This whole transaction must roll back",
    evidence: [{ type: "text", summary: "Rollback fixture" }],
    disputes: [target.id],
    next_intents: [
      {
        statement: "Valid first direction",
        expected: "The first direction remains valid",
        method: "Run the first direction",
      },
      {
        statement: "Invalid second direction",
        expected: "The second direction cannot reference missing intent",
        method: "Trigger validation failure",
        disputes: [randomUUID()],
      },
    ],
  }, board.context("worker-2")), error => error.code === "invalid_reference");
  const after = board.challenge(challenge.id);
  assert.equal(after.facts.length, before.facts.length);
  assert.equal(after.intents.length, before.intents.length);
  assert.equal(after.facts.find(item => item.id === target.id).version, target.version);
  assert.equal(board.getMeta("event_cursor"), cursor);
});

test("compact dispute projections are bounded while full entities retain every relation", (t) => {
  const { board, create, call } = setup(t, 2);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  const targets = Array.from({ length: 9 }, (_, index) => fact(call, "worker-1", challenge.id, {
    statement: `Target ${index}`,
  }));
  const multi = fact(call, "worker-2", challenge.id, {
    statement: "Disputes many targets",
    disputes: targets.map(item => item.id),
  });
  const multiEvent = board.events().find(event => event.fact_id === multi.id);
  const multiChange = board._eventChange(multiEvent);
  assert.equal(multiChange.data.disputes.length, 8);
  assert.equal(multiChange.data.disputes_count, 9);
  assert.equal(multiChange.data.disputes_truncated, true);
  assert.equal(multiChange.data.disputed_refs.length, 8);
  assert.equal(multiChange.data.disputed_refs_total, 9);
  assert.equal(multiChange.data.disputed_refs_truncated, true);

  for (let index = 0; index < 9; index++) {
    fact(call, index % 2 === 0 ? "worker-1" : "worker-2", challenge.id, {
      statement: `Additional dispute ${index}`,
      disputes: [targets[0].id],
    });
  }
  const firstEvent = board.events().find(event => event.fact_id === targets[0].id);
  const firstChange = board._eventChange(firstEvent);
  assert.equal(firstChange.data.disputed_by.length, 8);
  assert.equal(firstChange.data.disputed_by_count, 10);
  assert.equal(firstChange.data.disputed_by_truncated, true);
  const full = board.snapshot("worker-1", {
    view: "entity", entityKind: "fact", entityId: targets[0].id,
  });
  assert.equal(full.data.disputed_by.length, 10);
  const source = board.snapshot("worker-1", {
    view: "entity", entityKind: "fact", entityId: multi.id,
  });
  assert.equal(source.data.disputes.length, 9);
});

test("Intent disputes leave lifecycle unchanged, allow claiming and reject wrong scopes", (t) => {
  const { board, create, call } = setup(t, 2);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  const basis = fact(call, "worker-1", challenge.id);
  const target = intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  const beforeDisputes = board.challenge(challenge.id).intents.find(item => item.id === target.id);
  const disputedByOne = intent(call, "worker-2", challenge.id, basis.id, {
    statement: "Test the opposite parser branch",
    disputes: [target.id],
  });
  const disputedByTwo = intent(call, "worker-1", challenge.id, basis.id, {
    statement: "Add independent parser evidence",
    disputes: [target.id, target.id],
  });
  const current = board.challenge(challenge.id).intents.find(item => item.id === target.id);
  assert.equal(current.status, "claimed");
  assert.equal(current.holder, "worker-1");
  assert.equal(current.disputed, true);
  assert.equal(current.version, target.version + 2);
  assert.deepEqual(new Set(current.disputed_by), new Set([disputedByOne.id, disputedByTwo.id]));
  for (const field of ["status", "holder", "environment_generation", "depends_on", "result", "result_facts"]) {
    assert.deepEqual(current[field], beforeDisputes[field]);
  }
  const persisted = board._get("intent", target.id);
  assert.equal(Object.hasOwn(persisted, "disputed"), false);
  assert.equal(Object.hasOwn(persisted, "disputed_by"), false);

  const direction = intent(call, "worker-1", challenge.id, basis.id, {
    statement: "Probe a disputed but open supported direction",
    parallel: true,
    parallel_key: "disputed-open-direction",
  });
  intent(call, "worker-2", challenge.id, basis.id, {
    statement: "Challenge that direction before it is claimed",
    disputes: [direction.id],
  });
  const disputedOpen = board.challenge(challenge.id).intents.find(item => item.id === direction.id);
  const claimed = call("worker-2", "claim_intent", {
    challenge_id: challenge.id,
    intent_id: direction.id,
    expected_version: disputedOpen.version,
  }).intent;
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.holder, "worker-2");
  const opaqueRelation = intent(call, "worker-1", challenge.id, basis.id, {
    statement: "Keep an opaque acceptance relation",
    relates_to: ["acceptance-outside-this-board"],
  });
  assert.deepEqual(opaqueRelation.relates_to, ["acceptance-outside-this-board"]);

  fails(() => intent(call, "worker-1", challenge.id, basis.id, { disputes: [basis.id] }), "invalid_reference");
  fails(() => intent(call, "worker-1", challenge.id, basis.id, { disputes: [randomUUID()] }), "invalid_reference");
});

test("legacy dispute edges derive reverse relations without rewriting history", (t) => {
  const { board, create, call } = setup(t, 2);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  const target = fact(call, "worker-1", challenge.id);
  const source = {
    id: randomUUID(), challenge_id: challenge.id, kind: "observation",
    statement: "Legacy counter observation",
    evidence: [{ type: "text", summary: "Legacy fixture", author: "worker-2" }],
    derived_from: [], disputes: [target.id], resolves: null, result: null,
    author: "worker-2", assignment_ref: null, environment_generation: challenge.generation,
    status: "proposed", provenance: "self_reported", version: 1, created_at: 2000,
  };
  board._save("fact", source);
  const current = board.challenge(challenge.id).facts.find(item => item.id === target.id);
  assert.equal(current.status, "disputed");
  assert.equal(current.version, target.version);
  assert.deepEqual(current.disputed_by, [source.id]);
  const persisted = board._get("fact", target.id);
  assert.equal(persisted.status, "proposed");
  assert.equal(Object.hasOwn(persisted, "disputed_by"), false);

  const stale = {
    ...source,
    id: randomUUID(),
    statement: "Legacy cached dispute without a forward edge",
    disputes: [],
    status: "disputed",
  };
  board._save("fact", stale);
  const staleView = board.challenge(challenge.id).facts.find(item => item.id === stale.id);
  assert.equal(staleView.status, "proposed");
  assert.deepEqual(staleView.disputed_by, []);
});

test("dispute relations survive reopening the same SQLite board", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "bbx-ctf-dispute-restart-"));
  const path = join(directory, "board.sqlite");
  let board = new Board({ path, initialWorkers: 2 });
  t.after(() => {
    board.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const worker of board.workers()) board.execute("platform", "worker_ready", { worker_id: worker.id });
  const challenge = board.execute("lead", "create_challenge", {
    request_id: "restart-create",
    unique_code: "restart-dispute",
    title: "Restart dispute",
    difficulty: "hard",
  });
  board.execute("platform", "dispatch");
  const first = board.execute("worker-1", "post_fact", {
    request_id: "restart-target",
    challenge_id: challenge.id,
    statement: "Persisted target",
    evidence: [{ type: "text", summary: "Target fixture" }],
  }, board.context("worker-1")).fact;
  board.execute("worker-2", "post_fact", {
    request_id: "restart-dispute",
    challenge_id: challenge.id,
    statement: "Persisted dispute",
    evidence: [{ type: "text", summary: "Dispute fixture" }],
    disputes: [first.id],
  }, board.context("worker-2"));
  board.close();
  board = new Board({ path, initialWorkers: 2 });
  const reopened = board.challenge(challenge.id).facts.find(item => item.id === first.id);
  assert.equal(reopened.status, "disputed");
  assert.equal(reopened.version, first.version + 1);
  assert.equal(reopened.disputed_by.length, 1);
});

test("review revisions distinguish invalid input from stale state without writing", (t) => {
  const { board, create } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const revision = board.challenge(challenge.id).revision;
  const cursor = board.getMeta("event_cursor");
  const submit = args => board.execute("worker-1", "submit_review", {
    request_id: randomUUID(), challenge_id: challenge.id, flag: "flag{fixture}", summary: "Fixture candidate", ...args,
  }, board.context("worker-1"));
  for (const args of [{}, { expected_revision: String(revision) }, { expected_revision: 0 }, { expected_revision: 1.5 }]) {
    assert.throws(() => submit(args), error => error.code === "invalid_argument"
      && error.message.includes("expected_revision") && error.details.revision === revision);
  }
  for (const expected_revision of [revision - 1, revision + 1]) {
    assert.throws(() => submit({ expected_revision }), error => error.code === "revision_conflict"
      && error.details.revision === revision);
  }
  assert.equal(board.challenge(challenge.id).phase, "solving");
  assert.equal(board.challenge(challenge.id).candidates.length, 0);
  assert.deepEqual(board.events(cursor), []);
  assert.equal(submit({ expected_revision: revision }).candidate.flag, "flag{fixture}");
});

test("parallel review candidates survive; rejection atomically records feedback", (t) => {
  const { board, create, call, lead } = setup(t, 3);
  const challenge = create({ difficulty: "hard" }); board.execute("platform", "dispatch");
  const revision = board.challenge(challenge.id).revision;
  const a = call("worker-1", "submit_review", { challenge_id: challenge.id, expected_revision: revision, flag: "flag{one}", summary: "one" });
  call("worker-2", "submit_review", { challenge_id: challenge.id, expected_revision: revision, flag: "flag{two}", summary: "two" });
  assert.equal(board.challenge(challenge.id).candidates.length, 2);
  assert.equal(board.challenge(challenge.id).review_revision, 1);
  assert.deepEqual(board.available().assistance, []);
  assert.deepEqual(new Set(board.events().at(-1).worker_ids), new Set(["lead", "worker-1", "worker-2"]));
  const started = lead("begin_submission", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision,
    candidate_id: a.candidate.id, review_revision: 1 });
  board.execute("platform", "submission_result", { submission_id: started.submission.id, status: "rejected",
    reason: "Official response: incorrect flag", receipt: { correct: false } });
  const result = board.challenge(challenge.id);
  assert.equal(result.phase, "solving");
  assert.equal(result.facts.find((item) => item.id === result.feedback_fact_id).statement, "Official response: incorrect flag");
  assert.equal(result.members.length, 2);
});

test("unknown submission survives retries and deferral cannot discard it", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create(); board.execute("platform", "dispatch");
  const submitted = review(call, "worker-1", challenge.id);
  const request = { request_id: "submit", challenge_id: challenge.id, candidate_id: submitted.candidate.id,
    expected_revision: board.challenge(challenge.id).revision, review_revision: 1 };
  const started = board.execute("lead", "begin_submission", request);
  assert.equal(started.should_submit, true);
  board.execute("platform", "submission_result", { submission_id: started.submission.id, status: "unknown", receipt: {} });
  assert.equal(board.execute("lead", "begin_submission", request).should_submit, false);
  fails(() => lead("defer", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision, reason: "Later" }), "submission_unresolved");
  board.execute("platform", "submission_result", { submission_id: started.submission.id, status: "accepted", receipt: { correct: true, awarded: 0 } });
  assert.equal(board.challenge(challenge.id).phase, "completed");
  fails(() => board.execute("platform", "submission_result", { submission_id: started.submission.id, status: "rejected", reason: "Late" }), "receipt_conflict");
});

test("reviewing freezes Worker facts while Lead can still record its verdict", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const worker = board.challenge(challenge.id).owner_id;
  review(call, worker, challenge.id);
  fails(() => fact(call, worker, challenge.id), "invalid_phase");
  const verdict = lead("post_fact", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    statement: "Lead is reviewing the submitted candidate",
    kind: "observation",
    evidence: [{ type: "text", summary: "Lead review is in progress" }],
  });
  assert.equal(verdict.fact.author, "lead");
});

test("an unknown submission retries only its exact candidate and review round", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const worker = board.challenge(challenge.id).owner_id;
  const reviewed = review(call, worker, challenge.id, "flag{first}");
  const request = candidateId => ({ request_id: randomUUID(), challenge_id: challenge.id, candidate_id: candidateId,
    expected_revision: board.challenge(challenge.id).revision, review_revision: 1 });
  const started = lead("begin_submission", request(reviewed.candidate.id));
  board.execute("platform", "submission_result", {
    submission_id: started.submission.id,
    status: "unknown",
    receipt: { code: "transport_error" },
  });

  const other = review(call, worker, challenge.id, "flag{second}");
  fails(() => lead("begin_submission", request(other.candidate.id)), "submission_unresolved");
  const reconcile = lead("begin_submission", request(reviewed.candidate.id));
  assert.equal(reconcile.should_submit, false);
  assert.equal(reconcile.reconcile_required, true);
  const retried = lead("begin_submission", { ...request(reviewed.candidate.id), reconciled_unknown: true });
  assert.equal(retried.should_submit, true);
  assert.equal(retried.retry, true);
  assert.equal(retried.submission.id, started.submission.id);
  assert.equal(retried.submission.retry_count, 1);
  assert.equal(retried.submission.status, "pending");
  fails(() => lead("begin_submission", request(reviewed.candidate.id)), "submission_unresolved");

  board.execute("platform", "submission_result", {
    submission_id: started.submission.id,
    status: "accepted",
    challenge_completed: true,
    receipt: { correct: true, awarded: 100 },
  });
  assert.equal(board.challenge(challenge.id).phase, "completed");
});

test("partial acceptance preserves the team and resumes solving until the final flag", (t) => {
  const { board, create, call, lead, advance } = setup(t, 2);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  const contexts = board.workers().map((worker) => board.context(worker.id));
  advance(2 * 60 * 1000);
  const first = review(call, "worker-1", challenge.id, "flag{first}");
  const started = lead("begin_submission", { challenge_id: challenge.id, candidate_id: first.candidate.id,
    expected_revision: board.challenge(challenge.id).revision, review_revision: first.challenge.review_revision });
  advance(4 * 60 * 1000);
  const partial = board.execute("platform", "submission_result", { submission_id: started.submission.id,
    status: "accepted", challenge_completed: false, receipt: { correct: true, flag_count: 1, total_flag_count: 2 } });
  assert.equal(partial.submission.challenge_completed, false);
  assert.equal(partial.challenge.phase, "solving");
  assert.equal(partial.challenge.environment.status, "active");
  assert.equal(partial.challenge.ready, true);
  assert.equal(partial.challenge.members.length, 2);
  assert.equal(partial.challenge.solve_elapsed_ms, 2 * 60 * 1000);
  assert.deepEqual(board.workers().map((worker) => board.context(worker.id)), contexts);
  assert.deepEqual(board.execute("platform", "release_finished").released, []);
  const progress = partial.challenge.facts.find((item) => item.id === partial.challenge.feedback_fact_id);
  assert.match(progress.statement, /accepted.*remaining flags/);
  assert.match(progress.evidence[0].summary, new RegExp(started.submission.id));
  assert.deepEqual(new Set(board.events().at(-1).worker_ids), new Set(["lead", "worker-1", "worker-2"]));

  advance(3 * 60 * 1000);
  const final = review(call, "worker-2", challenge.id, "flag{final}");
  const ending = lead("begin_submission", { challenge_id: challenge.id, candidate_id: final.candidate.id,
    expected_revision: board.challenge(challenge.id).revision, review_revision: final.challenge.review_revision });
  const completed = board.execute("platform", "submission_result", { submission_id: ending.submission.id,
    status: "accepted", challenge_completed: true, receipt: { correct: true, flag_count: 2, total_flag_count: 2 } });
  assert.equal(completed.challenge.phase, "completed");
  assert.equal(completed.challenge.environment.status, "closed");
  assert.equal(completed.challenge.solve_elapsed_ms, 5 * 60 * 1000);
  assert.equal(completed.challenge.solve_started_at, null);
  assert.equal(completed.challenge.submissions.length, 2);
  assert.deepEqual(board.execute("platform", "release_finished").released, ["worker-1", "worker-2"]);
});

test("accepted receipt retries only upgrade completion when explicitly confirmed", (t) => {
  const { board, create, call, lead, advance } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const reviewed = review(call, "worker-1", challenge.id);
  const started = lead("begin_submission", { challenge_id: challenge.id, candidate_id: reviewed.candidate.id,
    expected_revision: board.challenge(challenge.id).revision, review_revision: reviewed.challenge.review_revision });
  const receipt = { submission_id: started.submission.id, status: "accepted", challenge_completed: false,
    receipt: { correct: true, flag_count: 1, total_flag_count: 2 } };
  const partial = board.execute("platform", "submission_result", receipt);
  const cursor = board.getMeta("event_cursor");
  advance(1000);
  assert.deepEqual(board.execute("platform", "submission_result", receipt), partial);
  assert.deepEqual(board.execute("platform", "submission_result", {
    submission_id: started.submission.id, status: "accepted",
  }), partial);
  assert.equal(board.getMeta("event_cursor"), cursor);

  const completion = { ...receipt, challenge_completed: true,
    receipt: { correct: true, flag_count: 2, total_flag_count: 2 } };
  const completed = board.execute("platform", "submission_result", completion);
  assert.equal(completed.challenge.phase, "completed");
  assert.equal(completed.challenge.solve_elapsed_ms, 1000);
  assert.equal(completed.challenge.solve_started_at, null);
  assert.equal(completed.submission.challenge_completed, true);
  assert.equal(completed.challenge.facts.length, partial.challenge.facts.length);
  const finalCursor = board.getMeta("event_cursor");
  assert.deepEqual(board.execute("platform", "submission_result", completion), completed);
  assert.deepEqual(board.execute("platform", "submission_result", receipt), completed);
  assert.equal(board.getMeta("event_cursor"), finalCursor);
});

test("whole-challenge confirmation may finish a later review in the same environment", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const first = review(call, "worker-1", challenge.id, "flag{first}");
  const started = lead("begin_submission", { challenge_id: challenge.id, candidate_id: first.candidate.id,
    expected_revision: board.challenge(challenge.id).revision, review_revision: first.challenge.review_revision });
  board.execute("platform", "submission_result", {
    submission_id: started.submission.id, status: "accepted", challenge_completed: false,
  });
  const later = review(call, "worker-1", challenge.id, "flag{later}");
  assert.equal(later.challenge.review_revision, first.challenge.review_revision + 1);
  const completed = board.execute("platform", "submission_result", {
    submission_id: started.submission.id, status: "accepted", challenge_completed: true,
  });
  assert.equal(completed.challenge.phase, "completed");
});

test("completion receipts from an old environment cannot finish a new attempt", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const first = review(call, "worker-1", challenge.id);
  const started = lead("begin_submission", { challenge_id: challenge.id, candidate_id: first.candidate.id,
    expected_revision: board.challenge(challenge.id).revision, review_revision: first.challenge.review_revision });
  board.execute("platform", "submission_result", {
    submission_id: started.submission.id, status: "accepted", challenge_completed: false,
  });
  lead("defer", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision,
    reason: "Resume with a fresh challenge environment" });
  board.execute("platform", "release_finished");
  board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "closed" });
  lead("resume", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision });
  board.execute("platform", "set_environment", {
    challenge_id: challenge.id, status: "active", ready: true, new_generation: true,
  });
  call("worker-1", "claim", { challenge_id: challenge.id });
  const later = review(call, "worker-1", challenge.id, "flag{new-environment}");
  const result = board.execute("platform", "submission_result", {
    submission_id: started.submission.id, status: "accepted", challenge_completed: true,
  });
  const current = board.challenge(challenge.id);
  assert.equal(result.challenge.phase, "reviewing");
  assert.equal(result.challenge.environment.status, "active");
  assert.equal(result.challenge.generation, current.generation);
  assert.equal(result.challenge.facts.length, current.facts.length);
  assert.deepEqual(result.challenge.members, current.members);
});

test("submission completion accepts boolean input and rejects malformed values atomically", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const reviewed = review(call, "worker-1", challenge.id);
  const started = lead("begin_submission", { challenge_id: challenge.id, candidate_id: reviewed.candidate.id,
    expected_revision: board.challenge(challenge.id).revision, review_revision: reviewed.challenge.review_revision });
  const cursor = board.getMeta("event_cursor");
  for (const value of [null, "false", 0, [], {}]) {
    fails(() => board.execute("platform", "submission_result", {
      submission_id: started.submission.id, status: "accepted", challenge_completed: value,
    }), "invalid_argument");
  }
  assert.equal(board.getMeta("event_cursor"), cursor);
  assert.equal(board.challenge(challenge.id).submissions[0].status, "pending");
  assert.equal(board.challenge(challenge.id).phase, "reviewing");
});

test("each finished execution releases separately; active recovery is preserved", (t) => {
  const { board, create, call, lead, path } = setup(t, 2);
  const challenge = create({ difficulty: "hard" }); board.execute("platform", "dispatch");
  const a = board.context("worker-1"); const b = board.context("worker-2");
  board.execute("platform", "activity", { worker_id: "worker-1", context: a, running: true });
  board.execute("platform", "activity", { worker_id: "worker-2", context: b, running: true });
  accepted(board, lead, call, "worker-1", challenge.id);
  assert.deepEqual(board.execute("platform", "release_finished").released, []);
  board.execute("platform", "activity", { worker_id: "worker-1", context: a, running: false });
  assert.deepEqual(board.execute("platform", "release_finished").released, ["worker-1"]);
  const recovered = new Board({ path });
  assert.equal(recovered.workers().find((item) => item.id === "worker-2").active, true);
  assert.deepEqual(recovered.execute("platform", "release_finished").released, []);
  recovered.close();
  board.execute("platform", "activity", { worker_id: "worker-2", context: b, running: false });
  assert.deepEqual(board.execute("platform", "release_finished").released, ["worker-2"]);
});

test("deferral retains progress, resumes explicitly and invalidates old assignment/environment", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create(); board.execute("platform", "dispatch");
  const old = board.context("worker-1");
  const basis = fact(call, "worker-1", challenge.id);
  const direction = intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  lead("defer", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision, reason: "Save progress" });
  assert.equal(board.available().new_challenges.length, 0);
  board.execute("platform", "release_finished");
  const kept = board.challenge(challenge.id);
  assert.equal(kept.intents.find((item) => item.id === direction.id).status, "open");
  board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "closed" });
  lead("resume", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision });
  assert.equal(board.available().new_challenges.length, 0);
  board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "pending" });
  assert.equal(board.challenge(challenge.id).generation, 1);
  board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "active", ready: true,
    connection: { host: "new-host" }, new_generation: true });
  call("worker-1", "claim", { challenge_id: challenge.id });
  assert.equal(board.context("worker-1").environment_generation, 2);
  fails(() => call("worker-1", "post_fact", { challenge_id: challenge.id, statement: "Late", evidence: [{ type: "text", summary: "old" }] }, old), "stale_context");
  assert.ok(board.challenge(challenge.id).facts.some((item) => item.id === basis.id));
});

test("thirty minute wall clock excludes review and deferral and fires only once", (t) => {
  const { board, create, call, lead, advance } = setup(t, 1);
  const challenge = create(); board.execute("platform", "dispatch");
  advance(10 * 60 * 1000);
  review(call, "worker-1", challenge.id);
  assert.equal(board.nextReminderAt(), null);
  advance(ASSISTANCE_REMINDER_MS);
  assert.deepEqual(board.execute("platform", "tick").reminded, []);
  lead("reject_review", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision, review_revision: 1, reason: "Need evidence" });
  advance(20 * 60 * 1000);
  assert.deepEqual(board.execute("platform", "tick").reminded, [challenge.id]);
  assert.equal(board.challenge(challenge.id).solve_elapsed_ms, ASSISTANCE_REMINDER_MS);
  assert.equal(board.challenge(challenge.id).assistance_target, 1);
  assert.equal(board.nextReminderAt(), null);
  assert.deepEqual(board.execute("platform", "tick").reminded, []);
});

test("existing assistance gets a reminder without automatic new seats", (t) => {
  const { board, create, advance } = setup(t, 4);
  const challenge = create({ difficulty: "hard" }); board.execute("platform", "dispatch");
  advance(ASSISTANCE_REMINDER_MS);
  board.execute("platform", "tick");
  assert.equal(board.challenge(challenge.id).assistance_target, 1);
  assert.equal(board.execute("platform", "dispatch").assignments.length, 0);
});

test("change listeners see committed state; rollback emits no partial facts", (t) => {
  const { board, create, call, path } = setup(t, 1);
  const reader = new Board({ path }); t.after(() => reader.close());
  const seen = [];
  board.on("change", (event) => { if (event.challenge_id) seen.push(reader.challenge(event.challenge_id).revision); });
  const challenge = create(); board.execute("platform", "dispatch");
  assert.equal(seen.at(-1), board.challenge(challenge.id).revision);
  const cursor = board.getMeta("event_cursor");
  fails(() => fact(call, "worker-1", challenge.id, { kind: "inference", derived_from: [] }), "invalid_fact");
  assert.deepEqual(board.events(cursor), []);
  board.setMeta("coordinator_cursor", cursor);
  assert.equal(reader.getMeta("coordinator_cursor"), cursor);
});

test("one held direction can trigger independent assistance before three holdings", (t) => {
  const { board, create, call } = setup(t, 2);
  const challenge = create(); board.execute("platform", "dispatch");
  const basis = fact(call, "worker-1", challenge.id);
  intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  intent(call, "worker-1", challenge.id, basis.id, { parallel: true, parallel_key: "independent" });
  assert.equal(board.challenge(challenge.id).assistance_target, 1);
  assert.equal(board.execute("platform", "dispatch").assignments[0].worker_id, "worker-2");
});

test("a Worker can ask Lead to consider deferral with durable evidence", (t) => {
  const { board, create, call } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const cursor = board.getMeta("event_cursor");
  const request = call("worker-1", "request_deferral", {
    challenge_id: challenge.id,
    reason: "The service is gone and every independent branch is exhausted",
  });
  assert.match(request.fact.statement, /exhausted/);
  const event = board.events(cursor).find((item) => item.type === "deferral.requested");
  assert.ok(event.worker_ids.includes("lead"));
  assert.equal(board.challenge(challenge.id).phase, "solving");
});

test("normal snapshots omit event history and explicit cursors return scoped deltas", (t) => {
  const { board, create, call, lead } = setup(t, 2);
  const first = create();
  lead("post_fact", { challenge_id: first.id, expected_revision: first.revision,
    statement: "Actual challenge description", evidence: [{ type: "text", summary: first.title }] });
  const second = create(); board.execute("platform", "dispatch");
  const cursor = board.getMeta("event_cursor");
  fact(call, "worker-1", first.id);
  fact(call, "worker-2", second.id);
  assert.equal(board.snapshot("worker-1").events, undefined);
  const delta = board.snapshot("worker-1", { challengeId: first.id, sinceRevision: cursor });
  assert.equal(delta.events.length, 1);
  assert.equal(delta.events[0].actor_id, "worker-1");
  assert.equal(delta.challenge.facts, undefined);
  assert.equal(delta.event_cursor, board.getMeta("event_cursor"));
});

test("catalog description changes emit one task update and repeat reads are idempotent", (t) => {
  const { board, create } = setup(t, 1);
  const challenge = create({ description: "Initial task text" });
  const initialRevision = challenge.revision;
  const initialClaimRevision = challenge.claim_revision;
  const cursor = board.getMeta("event_cursor");

  const updated = board.execute("platform", "apply_catalog_metadata", {
    challenge_id: challenge.id,
    description: "Official task text",
  });
  assert.equal(updated.description, "Official task text");
  assert.equal(updated.revision, initialRevision + 1);
  assert.equal(updated.claim_revision, initialClaimRevision);
  const event = board.events(cursor).find(item => item.type === "challenge.updated"
    && item.challenge_id === challenge.id);
  assert.equal(event.source, "catalog");

  const stable = board.execute("platform", "apply_catalog_metadata", {
    challenge_id: challenge.id,
    description: "Official task text",
  });
  assert.equal(stable.revision, updated.revision);
  assert.equal(board.events(cursor).filter(item => item.type === "challenge.updated"
    && item.challenge_id === challenge.id).length, 1);
});

test("late candidate writes from an earlier review cannot enter a new round", (t) => {
  const { board, create, call, lead } = setup(t, 2);
  const challenge = create({ difficulty: "hard" }); board.execute("platform", "dispatch");
  const oldRevision = board.challenge(challenge.id).revision;
  review(call, "worker-1", challenge.id, "flag{one}");
  lead("reject_review", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision,
    review_revision: 1, reason: "Wrong result" });
  review(call, "worker-1", challenge.id, "flag{new}");
  fails(() => call("worker-2", "submit_review", { challenge_id: challenge.id, expected_revision: oldRevision,
    flag: "flag{late}", summary: "Old computation" }), "stale_review");
  assert.equal(board.challenge(challenge.id).candidates.length, 2);
});

test("definitive technical submission refusal permits retry without wrong-answer feedback", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create(); board.execute("platform", "dispatch");
  const candidate = review(call, "worker-1", challenge.id).candidate;
  const submit = () => lead("begin_submission", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision,
    review_revision: 1, candidate_id: candidate.id });
  const attempt = submit();
  const receipt = { submission_id: attempt.submission.id, status: "not_sent", reason: "challenge_not_started", receipt: { status: 409 } };
  board.execute("platform", "submission_result", receipt);
  board.execute("platform", "submission_result", receipt);
  assert.equal(board.challenge(challenge.id).phase, "reviewing");
  assert.equal(board.challenge(challenge.id).facts.length, 0);
  const retry = submit();
  assert.equal(retry.should_submit, true);
  assert.notEqual(retry.submission.id, attempt.submission.id);
});

test("automatic assistance closes when members take the independent work", (t) => {
  const { board, create, call } = setup(t, 2);
  const challenge = create(); board.execute("platform", "dispatch");
  const basis = fact(call, "worker-1", challenge.id);
  intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  const direction = intent(call, "worker-1", challenge.id, basis.id, { parallel: true, parallel_key: "independent" });
  assert.equal(board.challenge(challenge.id).assistance_target, 1);
  call("worker-1", "claim_intent", { challenge_id: challenge.id, intent_id: direction.id, expected_version: direction.version });
  assert.equal(board.challenge(challenge.id).assistance_target, 0);
  assert.deepEqual(board.execute("platform", "dispatch").assignments, []);
  fails(() => call("worker-1", "request_assistance", {
    challenge_id: challenge.id,
    reason: "A second perspective is required",
  }), "assistance_evidence_required");
});

test("invalid argument shapes fail with domain codes before writing", (t) => {
  const { board, create, call } = setup(t, 1);
  fails(() => create({ ready: "false" }), "invalid_argument");
  const challenge = create(); board.execute("platform", "dispatch");
  fails(() => fact(call, "worker-1", challenge.id, { evidence: [null] }), "invalid_evidence");
  fails(() => board.execute("platform", "register_artifact", { challenge_id: challenge.id, worker_id: "worker-1" }), "stale_context");
  fails(() => board.execute("worker-1", "post_fact", null), "invalid_argument");
});

test("closed environments only retain explicitly confirmed local readiness", (t) => {
  const { board, create } = setup(t, 1);
  const challenge = create({ ready: false, requires_online_environment: true });
  for (const args of [{}, { ready: false }]) {
    board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "closed", ready: true });
    assert.equal(board.available().new_challenges[0].id, challenge.id);
    board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "closed", ...args });
    assert.equal(board.challenge(challenge.id).ready, false);
    assert.deepEqual(board.available().new_challenges, []);
    assert.deepEqual(board.execute("platform", "dispatch").assignments, []);
  }
});

test("prepared local work keeps its assignment when the first remote instance becomes active", (t) => {
  const { board, create, call } = setup(t, 1);
  const challenge = create({ ready: false, requires_online_environment: true });
  board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "closed", ready: true });
  assert.equal(board.execute("platform", "dispatch").assignments.length, 1);
  const context = board.context("worker-1");
  assert.equal(context.environment_generation, 1);
  assert.equal(board.challenge(challenge.id).environment.status, "closed");
  fact(call, "worker-1", challenge.id);
  board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "active", ready: true, online: true });
  assert.deepEqual(board.context("worker-1"), context);
  assert.equal(board.challenge(challenge.id).generation, 1);
  fails(() => board.execute("platform", "set_environment", {
    challenge_id: challenge.id, status: "closed", ready: true, new_generation: true,
  }), "team_not_released");
  assert.equal(board.challenge(challenge.id).environment.status, "active");
  assert.deepEqual(board.context("worker-1"), context);
});

test("explicit local readiness cannot make completed or deferred work claimable", (t) => {
  const { board, create, lead } = setup(t, 1);
  const deferred = create({ ready: false });
  lead("defer", { challenge_id: deferred.id, expected_revision: deferred.revision, reason: "Missing required fixture" });
  const completed = create({ ready: false });
  board.execute("platform", "reconcile_completed", { challenge_id: completed.id });
  for (const [challenge, phase] of [[deferred, "deferred"], [completed, "completed"]]) {
    board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "closed", ready: true });
    assert.equal(board.challenge(challenge.id).phase, phase);
  }
  assert.deepEqual(board.available(), { new_challenges: [], assistance: [] });
  assert.deepEqual(board.execute("platform", "dispatch").assignments, []);
});

test("resume waits for environment confirmation even when the old environment stayed open", (t) => {
  const { board, create, lead } = setup(t, 1);
  const challenge = create(); board.execute("platform", "dispatch");
  lead("defer", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision, reason: "Temporary pause" });
  board.execute("platform", "release_finished");
  assert.equal(board.challenge(challenge.id).environment.status, "active");
  lead("resume", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision });
  assert.equal(board.challenge(challenge.id).ready, false);
  assert.equal(board.challenge(challenge.id).environment.status, "active");
  assert.equal(board.available().new_challenges.length, 0);
  board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "active", ready: true });
  assert.equal(board.available().new_challenges.length, 1);
  assert.equal(board.challenge(challenge.id).generation, 1);
});

test("a new environment generation restores the hard assistance floor", (t) => {
  const { board, create, lead } = setup(t, 2);
  const challenge = create({ difficulty: "hard" });
  board.execute("platform", "dispatch");
  lead("defer", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    reason: "Recreate the environment",
  });
  board.execute("platform", "release_finished");
  board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "closed" });
  lead("resume", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
  });
  board.execute("platform", "set_environment", {
    challenge_id: challenge.id,
    status: "active",
    ready: true,
    new_generation: true,
  });
  assert.equal(board.challenge(challenge.id).generation, 2);
  assert.equal(board.challenge(challenge.id).assistance_target, 1);
});

test("assignment events persist the exact worker and assignment for delivery retries", (t) => {
  const { board, create, path } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const context = board.context("worker-1");
  const event = board.events().find((item) => item.type === "worker.assigned");
  assert.equal(event.challenge_id, challenge.id);
  assert.equal(event.assigned_worker_id, "worker-1");
  assert.equal(event.assignment_id, context.assignment_id);
  assert.ok(event.worker_ids.includes("worker-1"));
  const reader = new Board({ path, initialWorkers: 1 });
  try {
    assert.deepEqual(reader.events(event.id - 1)[0], event);
  } finally {
    reader.close();
  }
});

test("new environments preserve prior directions while requiring current-generation attempts", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const basis = fact(call, "worker-1", challenge.id);
  const previous = intent(call, "worker-1", challenge.id, basis.id, {
    parallel: true, parallel_key: "parse-input",
  });
  const dependency = intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  fact(call, "worker-1", challenge.id, { resolves: dependency.id, result: "confirmed" });
  const oldCandidate = review(call, "worker-1", challenge.id, "flag{previous-environment}");
  lead("defer", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    reason: "Save progress before recreating the environment",
  });
  board.execute("platform", "release_finished");
  board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "closed" });
  lead("resume", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision });
  board.execute("platform", "set_environment", {
    challenge_id: challenge.id, status: "active", ready: true, new_generation: true,
  });
  call("worker-1", "claim", { challenge_id: challenge.id });
  const current = board.challenge(challenge.id);
  assert.equal(current.assistance_target, 0);
  assert.ok(current.facts.some((item) => item.id === basis.id));
  fails(() => call("worker-1", "claim_intent", {
    challenge_id: challenge.id, intent_id: previous.id, expected_version: previous.version,
  }), "stale_intent");
  const replacement = intent(call, "worker-1", challenge.id, basis.id, {
    parallel: true, parallel_key: "parse-input", retry_of: previous.id, claim: true,
  });
  assert.equal(replacement.environment_generation, current.generation);
  assert.equal(replacement.retry_of, previous.id);
  const dependent = intent(call, "worker-1", challenge.id, basis.id, { depends_on: [dependency.id] });
  fails(() => call("worker-1", "claim_intent", {
    challenge_id: challenge.id, intent_id: dependent.id, expected_version: dependent.version,
  }), "intent_unavailable");
  const newCandidate = review(call, "worker-1", challenge.id, "flag{current-environment}");
  fails(() => lead("begin_submission", {
    challenge_id: challenge.id,
    candidate_id: oldCandidate.candidate.id,
    review_revision: newCandidate.challenge.review_revision,
    expected_revision: board.challenge(challenge.id).revision,
  }), "stale_candidate");
  assert.equal(board.challenge(challenge.id).candidates.length, 2);
});

test("resuming the same environment allows a released direction to continue", (t) => {
  const { board, create, call, lead } = setup(t, 1);
  const challenge = create();
  board.execute("platform", "dispatch");
  const basis = fact(call, "worker-1", challenge.id);
  const direction = intent(call, "worker-1", challenge.id, basis.id, { claim: true });
  lead("defer", {
    challenge_id: challenge.id,
    expected_revision: board.challenge(challenge.id).revision,
    reason: "Resume after checking environment availability",
  });
  board.execute("platform", "release_finished");
  lead("resume", { challenge_id: challenge.id, expected_revision: board.challenge(challenge.id).revision });
  board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "active", ready: true });
  call("worker-1", "claim", { challenge_id: challenge.id });
  const saved = board.challenge(challenge.id).intents.find((item) => item.id === direction.id);
  const result = call("worker-1", "claim_intent", {
    challenge_id: challenge.id, intent_id: direction.id, expected_version: saved.version,
  });
  assert.equal(result.intent.environment_generation, direction.environment_generation);
  assert.equal(result.intent.id, direction.id);
});

test("legacy assistance requests without current evidence are retired during migration", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "bbx-ctf-board-migration-"));
  const path = join(directory, "board.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = new Board({ path, initialWorkers: 1 });
  const legacyChallenge = (id, uniqueCode) => ({
    id,
    unique_code: uniqueCode,
    title: uniqueCode,
    description: "",
    difficulty: "hard",
    multi_stage: false,
    priority: 1,
    phase: "pending",
    revision: 1,
    generation: 1,
    ready: false,
    owner_id: null,
    assistance_target: 1,
    assistance_requested: 1,
    assistance_reminded: false,
    solve_elapsed_ms: 0,
    solve_started_at: null,
    review_revision: 0,
    environment: { status: "pending", online: false, connection: null },
    created_at: 1,
    review_summary: null,
  });
  const defaults = legacyChallenge("legacy-default", "legacy-default");
  const explicit = legacyChallenge("legacy-explicit", "legacy-explicit");
  const insert = original.db.prepare("INSERT INTO records(kind,id,challenge_id,data) VALUES(?,?,?,?)");
  insert.run("challenge", defaults.id, defaults.id, JSON.stringify(defaults));
  insert.run("challenge", explicit.id, explicit.id, JSON.stringify(explicit));
  original.db.prepare("INSERT INTO events(data) VALUES(?)").run(JSON.stringify({
    type: "assistance.requested",
    actor_id: "worker-1",
    challenge_id: explicit.id,
    revision: 1,
    worker_ids: ["worker-1"],
    at: 2,
  }));
  original.close();

  const migrated = new Board({ path, initialWorkers: 1 });
  t.after(() => migrated.close());
  assert.equal(migrated.challenge(defaults.id).assistance_requested, 0);
  assert.equal(migrated.challenge(defaults.id).assistance_target, 1);
  assert.equal(migrated.challenge(explicit.id).assistance_requested, 0);
  assert.equal(migrated.challenge(explicit.id).assistance_target, 1);
  for (const id of [defaults.id, explicit.id]) {
    migrated.execute("lead", "update_challenge", {
      request_id: `downgrade-${id}`,
      challenge_id: id,
      expected_revision: migrated.challenge(id).revision,
      difficulty: "medium",
    });
  }
  assert.equal(migrated.challenge(defaults.id).assistance_target, 0);
  assert.equal(migrated.challenge(explicit.id).assistance_target, 0);
});
