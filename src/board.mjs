import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_CHALLENGE_WORKERS = 10;
export const MAX_WORKER_INTENTS = 3;
export const ASSISTANCE_REMINDER_MS = 30 * 60 * 1000;
export const MAX_COMPACT_DISPUTE_REFS = 8;
const BOARD_STATE_VERSION = 3;

export class BoardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function requireValue(condition, code, message, details) {
  if (!condition) throw new BoardError(code, message, details);
}
function text(value, name) {
  requireValue(typeof value === "string" && value.trim().length > 0,
    "invalid_argument", `${name} must be nonblank`);
  return value;
}
function integer(value, minimum, maximum, name) {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    "invalid_argument", `${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function stableUuid(namespace, uniqueCode) {
  const hex = createHash("sha256").update(namespace).update("\0").update(uniqueCode).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}`
    + `-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(MAX_CHALLENGE_WORKERS - 1, value)
    : 0;
}

function hardAssistanceFloor(challenge) {
  return challenge.difficulty === "hard" ? 1 : 0;
}

function minimumTeamSize(challenge) {
  return 1 + hardAssistanceFloor(challenge);
}

function compactDescription(value, limit = 600) {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** A single local writer owns business state and its durable change stream. */
export class Board extends EventEmitter {
  constructor({ path = ":memory:", initialWorkers = 20, clock = Date.now } = {}) {
    super();
    this.clock = clock;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, challenge_id TEXT,
        data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_scope ON records(kind,challenge_id);
      CREATE TABLE IF NOT EXISTS requests (
        actor TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(actor,id));
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (!this.getMeta("initialized")) {
      integer(initialWorkers, 0, Number.MAX_SAFE_INTEGER, "initialWorkers");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index < initialWorkers; index++) this._newWorker();
        this.setMeta("initialized", true);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    this._migrateChallenges();
  }
  close() { this.db.close(); }
  getMeta(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(value));
    return value;
  }
  _get(kind, id) {
    if (typeof id !== "string" || !id) return null;
    const row = this.db.prepare("SELECT data FROM records WHERE kind=? AND id=?").get(kind, id);
    return row ? JSON.parse(row.data) : null;
  }
  _all(kind, challengeId) {
    const rows = challengeId === undefined
      ? this.db.prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid").all(kind)
      : this.db.prepare("SELECT data FROM records WHERE kind=? AND challenge_id=? ORDER BY rowid").all(kind, challengeId);
    return rows.map((row) => JSON.parse(row.data));
  }
  _save(kind, value) {
    this.db.prepare(`INSERT INTO records(kind,id,challenge_id,data) VALUES(?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET challenge_id=excluded.challenge_id,data=excluded.data`)
      .run(kind, value.id, value.challenge_id ?? null, JSON.stringify(value));
    return value;
  }
  _newWorker() {
    const sequence = this.getMeta("worker_sequence", 0) + 1;
    this.setMeta("worker_sequence", sequence);
    return this._save("worker", { id: `worker-${sequence}`, status: "starting", has_worked: false,
      generation: 0, idle_generation: 0, assignment_id: null, active: false,
      execution_context: null, error: null });
  }
  _migrateChallenges() {
    for (const challenge of this._all("challenge")) {
      if (challenge.state_version === BOARD_STATE_VERSION
        && Number.isSafeInteger(challenge.claim_revision)
        && Array.isArray(challenge.assistance_blocker_facts)
        && Array.isArray(challenge.assistance_direction_intents)) continue;
      const floor = hardAssistanceFloor(challenge);
      challenge.hard_assistance_target = floor;
      challenge.requires_online_environment ??= null;
      challenge.points ??= null;
      challenge.total_score ??= null;
      challenge.flag_count ??= null;
      challenge.correct_flag_count ??= null;
      challenge.assistance_blocker_facts ??= [];
      challenge.assistance_direction_intents ??= [];
      challenge.claim_revision ??= challenge.revision;
      challenge.assistance_blocker_facts = challenge.assistance_blocker_facts
        .filter(item => item?.generation === challenge.generation);
      challenge.assistance_direction_intents = challenge.assistance_direction_intents
        .filter(item => item?.generation === challenge.generation);
      challenge.assistance_target = this._assistanceCapacity(challenge);
      challenge.assistance_requested = Math.max(0,
        challenge.assistance_target - hardAssistanceFloor(challenge));
      challenge.state_version = BOARD_STATE_VERSION;
      this._save("challenge", challenge);
    }
  }
  workers() { return this._all("worker"); }
  _worker(id) {
    const worker = this._get("worker", id);
    requireValue(worker, "worker_not_found", "Worker does not exist");
    return worker;
  }
  context(id) {
    const worker = this._worker(id);
    const assignment = worker.assignment_id ? this._get("assignment", worker.assignment_id) : null;
    return { worker_id: id, assignment_id: worker.assignment_id,
      challenge_id: assignment?.challenge_id ?? null, generation: worker.generation,
      environment_generation: assignment?.environment_generation ?? null };
  }
  _context(actor, context, requireAssignment = true) {
    const actual = this.context(actor);
    requireValue(context && Object.keys(actual).every((key) => context[key] === actual[key]),
      "stale_context", "The model response belongs to an older assignment", { context: actual });
    if (requireAssignment) requireValue(actual.assignment_id, "assignment_required", "Claim work first");
    return actual;
  }
  _challenge(id) {
    const challenge = this._get("challenge", id);
    requireValue(challenge, "challenge_not_found", "Challenge does not exist");
    return challenge;
  }
  _members(id) {
    return this._all("assignment", id).filter((item) => item.released_at === null)
      .map((item) => ({ ...item, worker_id: item.worker_id, assignment_id: item.id,
        active: this._worker(item.worker_id).active }));
  }
  challenge(id) {
    const challenge = this._challenge(id);
    const disputes = this._disputeIndex(id);
    return { ...challenge, members: this._members(id),
      facts: [...disputes.entities.fact.values()].map(item => this._withDisputeRelations("fact", item, disputes)),
      intents: [...disputes.entities.intent.values()].map(item => this._withDisputeRelations("intent", item, disputes)),
      candidates: this._all("candidate", id),
      submissions: this._all("submission", id), artifacts: this._all("artifact", id),
      needs_assistance: this._slots(challenge) > 0 };
  }
  _disputeIndex(challengeId) {
    const entities = {
      fact: new Map(this._all("fact", challengeId).map(item => [item.id, item])),
      intent: new Map(this._all("intent", challengeId).map(item => [item.id, item])),
    };
    const disputedBy = { fact: new Map(), intent: new Map() };
    for (const kind of ["fact", "intent"]) {
      const ids = new Set(entities[kind].keys());
      for (const source of entities[kind].values()) {
        for (const targetId of [...new Set(Array.isArray(source.disputes) ? source.disputes : [])]) {
          if (targetId === source.id || !ids.has(targetId)) continue;
          const incoming = disputedBy[kind].get(targetId) ?? [];
          incoming.push(source.id);
          disputedBy[kind].set(targetId, incoming);
        }
      }
    }
    return { entities, disputedBy };
  }
  _withDisputeRelations(kind, entity, index = this._disputeIndex(entity.challenge_id)) {
    if (!entity) return null;
    const disputes = Array.isArray(entity.disputes) ? [...new Set(entity.disputes)] : [];
    const disputedBy = index.disputedBy[kind].get(entity.id) ?? [];
    const result = { ...entity, disputes, disputed_by: disputedBy };
    if (kind === "fact") {
      result.status = disputedBy.length ? "disputed" : "proposed";
    } else {
      result.disputed = disputedBy.length > 0;
    }
    return result;
  }
  _disputeRefs(kind, ids, index) {
    const refs = [];
    let total = 0;
    for (const id of Array.isArray(ids) ? [...new Set(ids)] : []) {
      const target = index.entities[kind].get(id);
      if (!target) continue;
      total += 1;
      if (refs.length >= MAX_COMPACT_DISPUTE_REFS) continue;
      const view = this._withDisputeRelations(kind, target, index);
      refs.push({
        id: target.id,
        author: target.author ?? null,
        status: view.status ?? null,
        environment_generation: target.environment_generation ?? null,
        statement: compactDescription(target.statement, 240),
        ...(kind === "intent" ? { disputed: view.disputed } : {}),
      });
    }
    return { refs, total };
  }
  _compactDisputeFields(kind, data, index) {
    const fields = {};
    const disputes = Array.isArray(data.disputes) ? data.disputes : [];
    const disputedBy = Array.isArray(data.disputed_by) ? data.disputed_by : [];
    if (disputes.length) {
      const { refs, total } = this._disputeRefs(kind, disputes, index);
      Object.assign(fields, {
        disputes: disputes.slice(0, MAX_COMPACT_DISPUTE_REFS),
        disputes_count: disputes.length,
        disputes_truncated: disputes.length > MAX_COMPACT_DISPUTE_REFS,
        disputed_refs: refs,
        disputed_refs_total: total,
        disputed_refs_truncated: total > MAX_COMPACT_DISPUTE_REFS,
      });
    }
    if (disputedBy.length) {
      Object.assign(fields, {
        disputed_by: disputedBy.slice(-MAX_COMPACT_DISPUTE_REFS),
        disputed_by_count: disputedBy.length,
        disputed_by_truncated: disputedBy.length > MAX_COMPACT_DISPUTE_REFS,
      });
    }
    return fields;
  }
  _challengeReceipt(challenge) {
    const members = this._members(challenge.id);
    return {
      id: challenge.id,
      unique_code: challenge.unique_code,
      title: challenge.title,
      phase: challenge.phase,
      revision: challenge.revision,
      claim_revision: challenge.claim_revision,
      generation: challenge.generation,
      ready: challenge.ready,
      owner_id: challenge.owner_id,
      member_count: members.length,
      members: members.map((member) => ({
        worker_id: member.worker_id,
        assignment_id: member.assignment_id,
        role: member.role,
        generation: member.generation,
        environment_generation: member.environment_generation,
        active: member.active,
      })),
      assistance_target: challenge.assistance_target ?? 0,
      open_assistance_slots: this._slots(challenge),
      needs_assistance: this._slots(challenge) > 0,
      review_revision: challenge.review_revision,
      flag_count: challenge.flag_count ?? null,
      correct_flag_count: challenge.correct_flag_count ?? null,
      environment: {
        status: challenge.environment?.status ?? null,
        online: challenge.environment?.online === true,
      },
    };
  }
  _slots(challenge) {
    if (!["assembling", "solving"].includes(challenge.phase) || !challenge.owner_id || !challenge.ready) return 0;
    const members = this._members(challenge.id);
    const assistants = members.filter((item) => item.role === "assistant").length;
    return Math.max(0, Math.min(MAX_CHALLENGE_WORKERS - members.length,
      challenge.assistance_target - assistants));
  }
  available() {
    const fresh = [], assistance = [];
    for (const challenge of this._all("challenge")) {
      const item = { challenge_id: challenge.id, id: challenge.id, revision: challenge.revision,
        claim_revision: challenge.claim_revision, title: challenge.title,
        description: compactDescription(challenge.description), difficulty: challenge.difficulty,
        priority: challenge.priority, created_at: challenge.created_at,
        offline: challenge.requires_online_environment === false,
        points: challenge.points ?? null, flag_count: challenge.flag_count ?? null };
      if (challenge.phase === "pending" && challenge.ready && !challenge.owner_id && this._members(challenge.id).length === 0) {
        fresh.push(item);
      } else if (this._slots(challenge)) assistance.push({ ...item, open_slots: this._slots(challenge) });
    }
    const order = (a, b) => a.priority - b.priority || a.created_at - b.created_at;
    return { new_challenges: fresh.sort(order), assistance: assistance.sort(order) };
  }
  _readable(actor, challenge) {
    if (["lead", "platform"].includes(actor)) return true;
    this._worker(actor);
    return this._members(challenge.id).some((member) => member.worker_id === actor)
      || challenge.phase === "pending" || this._slots(challenge) > 0;
  }
  _eventSummary(entity, data, event, disputeIndex = null) {
    if (!data) return null;
    if (entity === "challenge") return this._challengeReceipt(data);
    if (entity === "fact") {
      const index = disputeIndex ?? this._disputeIndex(data.challenge_id);
      return {
        id: data.id,
        version: data.version,
        statement: data.statement,
        status: data.status,
        author: data.author,
        derived_from: data.derived_from ?? [],
        ...this._compactDisputeFields("fact", data, index),
        resolves: data.resolves ?? null,
        result: data.result ?? null,
        artifact_refs: (data.evidence ?? [])
          .filter((item) => item.artifact_id)
          .map((item) => ({
            id: item.artifact_id,
            path: item.path ?? null,
            sha256: item.sha256 ?? null,
            size: item.size ?? null,
            type: item.type ?? null,
          })),
      };
    }
    if (entity === "intent") {
      const index = disputeIndex ?? this._disputeIndex(data.challenge_id);
      return {
        id: data.id,
        version: data.version,
        statement: data.statement,
        status: data.status,
        holder: data.holder ?? null,
        based_on: data.based_on ?? [],
        expected: data.expected ?? null,
        method: data.method ?? null,
        relates_to: data.relates_to ?? [],
        retry_of: data.retry_of ?? null,
        depends_on: data.depends_on ?? [],
        ...this._compactDisputeFields("intent", data, index),
        ...(data.disputed === true ? { disputed: true } : {}),
        parallel: data.parallel === true,
        parallel_key: data.parallel_key ?? null,
        result: data.result ?? null,
      };
    }
    if (entity === "candidate") {
      return {
        id: data.id,
        version: event.revision,
        summary: data.summary,
        author: data.author,
        review_revision: data.review_revision,
        environment_generation: data.environment_generation,
        flag: data.flag,
      };
    }
    if (entity === "artifact") {
      return {
        id: data.id,
        version: event.revision,
        type: data.type,
        path: data.path,
        uri: data.uri,
        sha256: data.sha256,
        size: data.size,
        capture: data.capture,
      };
    }
    if (entity === "submission") {
      const receipt = data.receipt ?? {};
      return {
        id: data.id,
        version: event.revision,
        candidate_id: data.candidate_id,
        status: data.status,
        review_revision: data.review_revision,
        environment_generation: data.environment_generation,
        challenge_completed: data.challenge_completed === true,
        correct: typeof receipt.correct === "boolean" ? receipt.correct : null,
        correct_flag_count: Number.isSafeInteger(receipt.correct_flag_count)
          ? receipt.correct_flag_count : null,
        total_flag_count: Number.isSafeInteger(receipt.total_flag_count)
          ? receipt.total_flag_count : null,
        cumulative_score: Number.isFinite(receipt.cumulative_score)
          ? receipt.cumulative_score : null,
        code: compactDescription(receipt.code ?? receipt.status ?? "", 120) || null,
        reason: compactDescription(data.reason ?? receipt.message ?? receipt.reason ?? "", 300) || null,
      };
    }
    if (entity === "worker") {
      return {
        id: data.id,
        status: data.status,
        assignment_id: data.assignment_id ?? null,
        active: data.active === true,
        error: data.error ?? null,
      };
    }
    return { id: data.id ?? null, version: event.revision };
  }
  _eventChange(event, { full = false, disputeIndexes = null } = {}) {
    const entity = event.fact_id ? "fact"
      : event.intent_id ? "intent"
        : event.artifact_id ? "artifact"
          : event.candidate_id ? "candidate"
            : event.submission_id ? "submission"
              : event.type.startsWith("worker.") ? "worker"
                : "challenge";
    const id = event.fact_id ?? event.intent_id ?? event.artifact_id ?? event.candidate_id
      ?? event.submission_id ?? event.assigned_worker_id ?? event.worker_id ?? event.challenge_id ?? null;
    const raw = id ? this._get(entity, id) : null;
    let disputeIndex = raw && ["fact", "intent"].includes(entity)
      ? disputeIndexes?.get(raw.challenge_id)
      : null;
    if (raw && ["fact", "intent"].includes(entity) && !disputeIndex) {
      disputeIndex = this._disputeIndex(raw.challenge_id);
      disputeIndexes?.set(raw.challenge_id, disputeIndex);
    }
    const current = disputeIndex ? this._withDisputeRelations(entity, raw, disputeIndex) : raw;
    const data = full && entity !== "challenge" ? current : this._eventSummary(entity, current, event, disputeIndex);
    return {
      entity,
      id,
      version: data?.version ?? event.revision,
      event_id: event.id,
      event_type: event.type,
      at: event.at,
      ...(data ? { data } : { details: event }),
    };
  }
  _visibleEvents(actor, { challengeId, after = 0, limit = 200 } = {}) {
    const rows = this.events(after).filter((event) => (!challengeId || event.challenge_id === challengeId)
      && (["lead", "platform"].includes(actor) || event.worker_ids.includes(actor)));
    const page = rows.slice(0, limit);
    return { page, has_more: rows.length > page.length };
  }
  snapshot(actor, { challengeId, sinceRevision, view, entityKind, entityId, limit = 200 } = {}) {
    if (!["lead", "platform"].includes(actor)) this._worker(actor);
    if (view === "available") {
      return { available: this.available(), context: ["lead", "platform"].includes(actor) ? null : this.context(actor),
        event_cursor: this.getMeta("event_cursor", 0) };
    }
    if (view === "task") {
      const id = challengeId ?? (["lead", "platform"].includes(actor) ? null : this.context(actor).challenge_id);
      requireValue(id, "invalid_argument", "task view requires challenge_id");
      const challenge = this._challenge(id);
      requireValue(this._readable(actor, challenge), "forbidden", "Challenge is not visible to this Worker");
      return { challenge: this.challenge(id), context: ["lead", "platform"].includes(actor) ? null : this.context(actor),
        event_cursor: this.getMeta("event_cursor", 0) };
    }
    if (view === "updates" || view === "history") {
      requireValue(Number.isSafeInteger(sinceRevision ?? 0) && (sinceRevision ?? 0) >= 0,
        "invalid_argument", "since_cursor must be a nonnegative integer");
      integer(limit, 1, 1000, "limit");
      const from = sinceRevision ?? 0;
      const { page, has_more } = this._visibleEvents(actor, { challengeId, after: from, limit });
      const disputeIndexes = new Map();
      const changes = page.map((event) => this._eventChange(event, { full: true, disputeIndexes }));
      return {
        from_cursor: from,
        to_cursor: this.getMeta("event_cursor", 0),
        next_cursor: page.at(-1)?.id ?? from,
        has_more,
        challenge_id: challengeId ?? null,
        context: ["lead", "platform"].includes(actor) ? null : this.context(actor),
        changes,
        events: page,
      };
    }
    if (view === "entity") {
      requireValue(["fact", "intent", "candidate", "artifact", "submission"].includes(entityKind),
        "invalid_argument", "entity view requires fact, intent, candidate, artifact, or submission");
      const data = this._get(entityKind, entityId);
      requireValue(data, "not_found", "Entity does not exist");
      const challenge = this._challenge(data.challenge_id);
      requireValue(this._readable(actor, challenge), "forbidden", "Challenge is not visible to this Worker");
      const index = ["fact", "intent"].includes(entityKind) ? this._disputeIndex(data.challenge_id) : null;
      const current = index ? this._withDisputeRelations(entityKind, data, index) : data;
      return { entity: entityKind, data: current, context: ["lead", "platform"].includes(actor) ? null : this.context(actor),
        event_cursor: this.getMeta("event_cursor", 0) };
    }
    if (challengeId) {
      const challenge = this._challenge(challengeId);
      requireValue(this._readable(actor, challenge), "forbidden", "Challenge is not visible to this Worker");
      if (sinceRevision === undefined) return this.challenge(challengeId);
    }
    if (sinceRevision !== undefined) {
      integer(sinceRevision, 0, Number.MAX_SAFE_INTEGER, "sinceRevision");
      return { event_cursor: this.getMeta("event_cursor", 0),
        context: ["lead", "platform"].includes(actor) ? null : this.context(actor),
        challenge: challengeId ? this._challenge(challengeId) : null,
        events: this.events(sinceRevision).filter((event) => (!challengeId || event.challenge_id === challengeId)
          && (["lead", "platform"].includes(actor) || event.worker_ids.includes(actor))) };
    }
    const challenges = this._all("challenge").filter((item) => this._readable(actor, item));
    return { challenges: challenges.map((item) => this.challenge(item.id)), available: this.available(),
      workers: ["lead", "platform"].includes(actor) ? this.workers() : [this._worker(actor)],
      context: ["lead", "platform"].includes(actor) ? null : this.context(actor),
      event_cursor: this.getMeta("event_cursor", 0) };
  }
  events(after = 0) {
    return this.db.prepare("SELECT id,data FROM events WHERE id>? ORDER BY id").all(after)
      .map((row) => ({ id: row.id, ...JSON.parse(row.data) }));
  }
  _event(type, challenge = null, workerIds = [], details = {}) {
    const recipients = new Set([...workerIds, ...(challenge ? this._members(challenge.id).map((member) => member.worker_id) : [])]);
    const event = { type, actor_id: this.currentActor, challenge_id: challenge?.id ?? null,
      revision: challenge?.revision ?? null, claim_revision: challenge?.claim_revision ?? null,
      worker_ids: [...recipients], at: this.clock(), ...details };
    const row = this.db.prepare("INSERT INTO events(data) VALUES(?)").run(JSON.stringify(event));
    event.id = Number(row.lastInsertRowid);
    this.setMeta("event_cursor", event.id);
    this.pendingEvents.push(event);
    return event;
  }
  _touch(challenge, type, workerIds = [], details = {}, { claim = false } = {}) {
    challenge.revision++;
    if (claim) challenge.claim_revision = (challenge.claim_revision ?? challenge.revision - 1) + 1;
    this._save("challenge", challenge);
    this._event(type, challenge, workerIds, details);
    return challenge;
  }
  _revision(challenge, args, allowEarlier = false) {
    requireValue(Number.isSafeInteger(args.expected_revision)
      && (allowEarlier ? args.expected_revision <= challenge.revision : args.expected_revision === challenge.revision)
      && args.expected_revision >= 1, "revision_conflict", "Refresh the challenge before retrying",
    { revision: challenge.revision });
  }
  _claimRevision(challenge, args) {
    const expected = args.expected_claim_revision ?? args.expected_revision;
    requireValue(Number.isSafeInteger(expected) && expected >= 1,
      "invalid_argument", "expected_claim_revision must be a positive integer");
    requireValue(expected === challenge.claim_revision, "work_changed",
      "Available work changed; choose from the latest available cards",
      { claim_revision: challenge.claim_revision, available: this.available() });
  }
  _authority(actor, args, context, { phases = ["solving", "reviewing"], revision = true } = {}) {
    const challenge = this._challenge(text(args.challenge_id, "challenge_id"));
    if (!["lead", "platform"].includes(actor)) {
      const captured = this._context(actor, context);
      requireValue(captured.challenge_id === challenge.id && captured.environment_generation === challenge.generation,
        "stale_context", "Work context does not match the current challenge environment");
    }
    requireValue(phases.includes(challenge.phase), "invalid_phase", `Action unavailable while ${challenge.phase}`);
    if (revision && actor !== "platform") this._revision(challenge, args);
    return challenge;
  }
  _lead(actor) { requireValue(actor === "lead", "forbidden", "This action belongs to Lead"); }
  _platform(actor) { requireValue(actor === "platform", "forbidden", "This action belongs to the coordinator"); }

  execute(actor, action, args = {}, context = null) {
    requireValue(args && typeof args === "object" && !Array.isArray(args), "invalid_argument", "Action arguments must be an object");
    requireValue(actor === "lead" || actor === "platform" || this._get("worker", actor), "forbidden", "Unknown actor");
    const requestId = args.request_id;
    if (actor !== "platform") text(requestId, "request_id");
    const hash = digest({ action, args, context });
    this.pendingEvents = [];
    this.currentActor = actor;
    this.db.exec("BEGIN IMMEDIATE");
    let result;
    try {
      const old = requestId && this.db.prepare("SELECT digest,result FROM requests WHERE actor=? AND id=?").get(actor, requestId);
      if (old) {
        requireValue(old.digest === hash, "request_conflict", "request_id has different parameters");
        result = JSON.parse(old.result);
        if (action === "grow_workers") result = this._growthReceipt(result);
        if (action === "begin_submission") result = { ...result, should_submit: false };
      } else {
        result = this._execute(actor, action, args, context);
        if (requestId) this.db.prepare("INSERT INTO requests(actor,id,digest,result) VALUES(?,?,?,?)")
          .run(actor, requestId, hash, JSON.stringify(result));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.pendingEvents = [];
      throw error;
    }
    const events = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of events) this.emit("change", event);
    return result;
  }

  _execute(actor, action, args, context) {
    switch (action) {
      case "grow_workers": {
        this._lead(actor);
        integer(args.target_total, 0, Number.MAX_SAFE_INTEGER, "target_total");
        const created = [];
        const active = this.workers().filter((worker) => worker.status !== "failed").length;
        for (let index = active; index < args.target_total; index++) created.push(this._newWorker().id);
        if (created.length) this._event("workers.created", null, ["lead"], { created });
        return this._growthReceipt({ request_id: args.request_id, target_total: args.target_total, created });
      }
      case "worker_ready": case "worker_failed": case "worker_degraded": {
        this._platform(actor);
        const worker = this._worker(args.worker_id);
        const canReport = action === "worker_ready"
          ? ["starting", "idle", "degraded"].includes(worker.status)
          : worker.status !== "failed";
        requireValue(canReport, "invalid_worker_state", "Worker cannot report this preparation state");
        if (action === "worker_ready") {
          worker.status = "idle";
          worker.error = null;
        } else {
          const failureStatus = action === "worker_failed" ? "failed" : "degraded";
          const failureEvent = action === "worker_failed" ? "worker.failed" : "worker.degraded";
          const assignment = worker.assignment_id ? this._get("assignment", worker.assignment_id) : null;
          if (assignment) {
            const challenge = this._challenge(assignment.challenge_id);
            assignment.released_at = this.clock();
            this._save("assignment", assignment);
            for (const intent of this._all("intent", challenge.id)) {
              if (intent.status === "claimed" && intent.holder === worker.id) {
                intent.status = "open";
                intent.holder = null;
                intent.claim_assignment_ref = null;
                intent.attempts++;
                intent.version++;
                intent.notes ??= [];
                intent.notes.push({ by: "platform", at: this.clock(),
                  text: "Holder failed; direction is open for another Worker" });
                this._save("intent", intent);
              }
            }
            if (challenge.owner_id === worker.id) challenge.owner_id = null;
            worker.assignment_id = null;
            this._touch(challenge, failureEvent, [worker.id, "lead"], {
              worker_id: worker.id,
              assignment_id: assignment.id,
              error: text(args.error, "error"),
            }, { claim: true });
          }
          worker.status = failureStatus;
          worker.error = text(args.error, "error");
          worker.active = false;
          worker.execution_context = null;
          worker.assignment_id = null;
          if (!assignment) this._event(failureEvent, null, [worker.id, "lead"], {
            worker_id: worker.id,
            error: worker.error,
          });
        }
        this._save("worker", worker);
        if (action === "worker_ready") this._event("worker.ready", null, [worker.id, "lead"]);
        return worker;
      }
      case "create_challenge": return this._createChallenge(actor, args);
      case "update_challenge": return this._updateChallenge(actor, args);
      case "set_environment": return this._environment(actor, args);
      case "apply_catalog_metadata": return this._applyCatalogMetadata(actor, args);
      case "reconcile_completed": return this._reconcileCompleted(actor, args);
      case "dispatch": return this._dispatch(actor);
      case "claim": return this._claimAction(actor, args, context);
      case "activity": return this._activity(actor, args);
      case "release_finished": return this._releaseFinished(actor, args);
      case "post_fact": return this._postFactAction(actor, args, context);
      case "post_intent": return this._postIntent(actor, args, context);
      case "claim_intent": return this._claimIntentAction(actor, args, context);
      case "release_intent": return this._releaseIntent(actor, args, context);
      case "register_artifact": return this._registerArtifact(actor, args);
      case "request_assistance": return this._requestAssistance(actor, args, context);
      case "request_deferral": return this._requestDeferral(actor, args, context);
      case "submit_review": return this._submitReview(actor, args, context);
      case "begin_submission": return this._beginSubmission(actor, args);
      case "submission_result": return this._submissionResult(actor, args);
      case "reject_review": return this._rejectReview(actor, args);
      case "defer": return this._defer(actor, args);
      case "resume": return this._resume(actor, args);
      case "progress_stalled": return this._progressStalled(actor, args);
      case "tick": return this._tick(actor);
      default: throw new BoardError("unknown_action", `Unknown board action ${action}`);
    }
  }
  _growthReceipt(receipt) {
    const members = receipt.created.map((id) => this._worker(id));
    return { ...receipt, succeeded: members.filter((item) => !["starting", "failed"].includes(item.status)).map((item) => item.id),
      starting: members.filter((item) => item.status === "starting").map((item) => item.id),
      failed: members.filter((item) => item.status === "failed").map((item) => ({ worker_id: item.id, error: item.error })),
      total: this.workers().filter((item) => item.status !== "failed").length };
  }
  _createChallenge(actor, args) {
    this._lead(actor);
    const uniqueCode = text(args.unique_code, "unique_code");
    requireValue(args.description === undefined || typeof args.description === "string", "invalid_argument", "description must be a string");
    requireValue(args.multi_stage === undefined || typeof args.multi_stage === "boolean", "invalid_argument", "multi_stage must be boolean");
    requireValue(args.ready === undefined || typeof args.ready === "boolean", "invalid_argument", "ready must be boolean");
    requireValue(args.requires_online_environment === undefined || typeof args.requires_online_environment === "boolean",
      "invalid_argument", "requires_online_environment must be boolean");
    requireValue(!this._all("challenge").some((item) => item.unique_code === uniqueCode),
      "duplicate_challenge", "External challenge already exists");
    const difficulty = args.difficulty ?? (args.multi_stage ? "hard" : "medium");
    requireValue(["easy", "medium", "hard"].includes(difficulty), "invalid_argument", "Invalid difficulty");
    const namespace = this.getMeta("challenge_namespace");
    const challenge = {
      id: typeof namespace === "string" && namespace ? stableUuid(namespace, uniqueCode) : randomUUID(),
      unique_code: uniqueCode, title: text(args.title, "title"),
      description: args.description ?? "", difficulty, multi_stage: args.multi_stage ?? false,
      priority: integer(args.priority ?? 1, 0, 3, "priority"), phase: "pending", revision: 1,
      claim_revision: 1,
      generation: 1, ready: args.ready ?? true, owner_id: null,
      requires_online_environment: args.requires_online_environment ?? null,
      assistance_target: difficulty === "hard" ? 1 : 0,
      hard_assistance_target: difficulty === "hard" ? 1 : 0,
      assistance_requested: 0, assistance_reminded: false,
      assistance_blocker_facts: [], assistance_direction_intents: [],
      solve_elapsed_ms: 0, solve_started_at: null, review_revision: 0,
      environment: { status: args.ready === false ? "pending" : "active", online: false, connection: null },
      flag_count: null, correct_flag_count: null,
      created_at: this.clock(), review_summary: null, state_version: BOARD_STATE_VERSION };
    this._save("challenge", challenge);
    this._event("challenge.created", challenge, ["lead"]);
    return this.challenge(challenge.id);
  }
  _updateChallenge(actor, args) {
    this._lead(actor);
    const challenge = this._authority(actor, args, null, { phases: ["pending", "assembling", "solving", "reviewing", "deferred"] });
    requireValue(args.description === undefined || typeof args.description === "string", "invalid_argument", "description must be a string");
    requireValue(args.multi_stage === undefined || typeof args.multi_stage === "boolean", "invalid_argument", "multi_stage must be boolean");
    for (const name of ["title", "description", "multi_stage"]) if (args[name] !== undefined) challenge[name] = args[name];
    text(challenge.title, "title");
    const previousDifficulty = challenge.difficulty;
    if (args.difficulty !== undefined) {
      requireValue(["easy", "medium", "hard"].includes(args.difficulty), "invalid_argument", "Invalid difficulty");
      challenge.difficulty = args.difficulty;
    } else if (args.multi_stage) challenge.difficulty = "hard";
    if (args.priority !== undefined) challenge.priority = integer(args.priority, 0, 3, "priority");
    challenge.hard_assistance_target = hardAssistanceFloor(challenge);
    challenge.assistance_blocker_facts = (challenge.assistance_blocker_facts ?? [])
      .filter(item => item.generation === challenge.generation);
    challenge.assistance_direction_intents = (challenge.assistance_direction_intents ?? [])
      .filter(item => item.generation === challenge.generation);
    const upgradedToHard = previousDifficulty !== "hard" && challenge.difficulty === "hard";
    if (upgradedToHard && ["pending", "solving"].includes(challenge.phase) && challenge.owner_id) {
      challenge.phase = "assembling";
      this._clock(challenge, false);
    }
    if (["assembling", "solving"].includes(challenge.phase)
      && this._members(challenge.id).length >= minimumTeamSize(challenge)) {
      challenge.phase = "solving";
      if (challenge.solve_started_at === null) this._clock(challenge, true);
    }
    this._autoAssistance(challenge);
    this._touch(challenge, "challenge.updated", [], {}, { claim: true });
    return this._challengeReceipt(challenge);
  }
  _environment(actor, args) {
    this._platform(actor);
    const challenge = this._challenge(args.challenge_id);
    requireValue(["pending", "active", "closing", "unknown", "closed"].includes(args.status), "invalid_argument", "Invalid environment status");
    if (args.new_generation) {
      requireValue(this._members(challenge.id).length === 0, "team_not_released", "Release prior work before reopening the environment");
      challenge.generation++;
      challenge.hard_assistance_target = hardAssistanceFloor(challenge);
      challenge.assistance_target = hardAssistanceFloor(challenge);
      challenge.assistance_requested = 0;
      challenge.assistance_reminded = false;
      challenge.assistance_blocker_facts = [];
      challenge.assistance_direction_intents = [];
    }
    challenge.environment = { ...challenge.environment, status: args.status,
      ...(args.connection !== undefined ? { connection: args.connection } : {}),
      ...(args.online !== undefined ? { online: args.online } : {}) };
    if (args.ready !== undefined) challenge.ready = Boolean(args.ready);
    if (args.status === "closed") challenge.ready = false;
    this._touch(challenge, "environment.updated", ["lead"], {}, { claim: true });
    return this.challenge(challenge.id);
  }

  _applyCatalogMetadata(actor, args) {
    this._platform(actor);
    const challenge = this._challenge(args.challenge_id);
    const updates = {};
    if (args.description !== undefined) {
      requireValue(typeof args.description === "string", "invalid_argument", "description must be a string");
      if (args.description.trim() && args.description !== challenge.description) {
        updates.description = args.description;
      }
    }
    if (args.requires_online_environment !== undefined) {
      requireValue(typeof args.requires_online_environment === "boolean",
        "invalid_argument", "requires_online_environment must be boolean");
      updates.requires_online_environment = args.requires_online_environment;
    }
    for (const name of ["points", "total_score"]) {
      if (args[name] === undefined) continue;
      requireValue(typeof args[name] === "number" && Number.isFinite(args[name]) && args[name] >= 0,
        "invalid_argument", `${name} must be a nonnegative number`);
      updates[name] = args[name];
    }
    if (args.flag_count !== undefined) {
      updates.flag_count = integer(args.flag_count, 0, Number.MAX_SAFE_INTEGER, "flag_count");
    }
    if (args.correct_flag_count !== undefined) {
      updates.correct_flag_count = integer(
        args.correct_flag_count, 0, Number.MAX_SAFE_INTEGER, "correct_flag_count");
    }
    if (!Object.keys(updates).length) return challenge;
    Object.assign(challenge, updates);
    if (updates.description !== undefined) {
      this._touch(challenge, "challenge.updated", [], { source: "catalog" });
    } else {
      this._save("challenge", challenge);
    }
    return this.challenge(challenge.id);
  }
  _reconcileCompleted(actor, args) {
    this._platform(actor);
    const challenge = this._challenge(args.challenge_id);
    if (challenge.phase === "completed" && challenge.environment.status === "closed" && !challenge.ready) {
      if (this._members(challenge.id).length === 0 && challenge.owner_id !== null) {
        challenge.owner_id = null;
        this._save("challenge", challenge);
      }
      return this._challengeReceipt(challenge);
    }
    this._clock(challenge, false);
    challenge.phase = "completed";
    challenge.ready = false;
    if (this._members(challenge.id).length === 0) challenge.owner_id = null;
    challenge.environment = { ...challenge.environment, status: "closed" };
    this._touch(challenge, "challenge.completed", ["lead"], {}, { claim: true });
    return this._challengeReceipt(challenge);
  }
  _assign(worker, challenge) {
    requireValue(worker.status === "idle" && !worker.assignment_id,
      "worker_not_idle", "Worker is not available for another assignment");
    requireValue(this._members(challenge.id).length < MAX_CHALLENGE_WORKERS, "team_full", "Challenge team is full");
    const role = challenge.owner_id ? "assistant" : "primary";
    let teamReady = false;
    worker.generation++;
    const assignment = { id: randomUUID(), worker_id: worker.id, challenge_id: challenge.id, role,
      generation: worker.generation, environment_generation: challenge.generation,
      created_at: this.clock(), released_at: null };
    worker.assignment_id = assignment.id;
    worker.status = "running";
    worker.has_worked = true;
    this._save("assignment", assignment);
    this._save("worker", worker);
    if (role === "primary") {
      challenge.owner_id = worker.id;
      if (minimumTeamSize(challenge) > 1) {
        challenge.phase = "assembling";
        this._clock(challenge, false);
      } else {
        challenge.phase = "solving";
        this._clock(challenge, true);
      }
    } else if (challenge.phase === "assembling"
      && this._members(challenge.id).length >= minimumTeamSize(challenge)) {
      challenge.phase = "solving";
      this._clock(challenge, true);
      teamReady = true;
    }
    this._touch(challenge, "worker.assigned", [worker.id], {
      assigned_worker_id: worker.id,
      assignment_id: assignment.id,
      team_ready: teamReady,
    }, { claim: true });
    return { worker_id: worker.id, context: this.context(worker.id),
      challenge: this._challengeReceipt(challenge) };
  }
  _claim(worker, challenge) {
    const choices = this.available();
    const fresh = choices.new_challenges.find((item) => item.id === challenge.id);
    const assistance = choices.assistance.find((item) => item.id === challenge.id);
    if (fresh) {
      return this._assign(worker, challenge);
    }
    requireValue(assistance, "work_changed", "Select currently available work", choices);
    requireValue(choices.new_challenges.length === 0, "work_changed",
      "Select a new challenge before general assistance", choices);
    return this._assign(worker, challenge);
  }
  _claimAction(actor, args, context) {
    requireValue(!["lead", "platform"].includes(actor), "forbidden", "Only Workers claim work");
    this._context(actor, context, false);
    const worker = this._worker(actor);
    requireValue(worker.has_worked, "first_assignment_required", "Coordinator assigns a Worker's first task");
    const challenge = this._challenge(args.challenge_id);
    this._claimRevision(challenge, args);
    return this._claim(worker, challenge);
  }
  _dispatch(actor) {
    this._platform(actor);
    const assignments = [];
    const idle = this.workers().filter((item) => item.status === "idle" && !item.has_worked && !item.active);
    while (idle.length) {
      const available = this.available();
      const work = available.new_challenges[0] ?? available.assistance[0];
      if (!work) break;
      assignments.push(this._assign(idle.shift(), this._challenge(work.id)));
    }
    const available = this.available();
    const notifications = available.new_challenges.length || available.assistance.length
      ? this.workers().filter((item) => item.status === "idle" && item.has_worked && !item.active)
        .map((item) => ({ worker_id: item.id, idle_generation: item.idle_generation, available, context: this.context(item.id) })) : [];
    return { assignments, notifications, available };
  }
  _activity(actor, args) {
    this._platform(actor);
    const worker = this._worker(args.worker_id);
    const captured = args.context ?? { worker_id: worker.id, assignment_id: args.assignment_id ?? null,
      challenge_id: args.assignment_id ? this._get("assignment", args.assignment_id)?.challenge_id : null,
      generation: args.generation, environment_generation: args.assignment_id ? this._get("assignment", args.assignment_id)?.environment_generation : null };
    if (args.running) {
      this._context(worker.id, captured, false);
      if (worker.active && digest(worker.execution_context) === digest(captured)) return worker;
      requireValue(!worker.active, "already_running", "Worker already has an active execution");
      worker.active = true;
      worker.execution_context = captured;
    } else {
      requireValue(!worker.active || digest(worker.execution_context) === digest(captured), "stale_execution", "Execution completion does not match the active run");
      worker.active = false;
      worker.execution_context = null;
    }
    this._save("worker", worker);
    this._event(args.running ? "worker.execution_started" : "worker.execution_ended", null, [worker.id], { context: captured });
    return worker;
  }
  _releaseFinished(actor, args) {
    this._platform(actor);
    const released = [];
    for (const worker of this.workers()) {
      if (args.worker_id && worker.id !== args.worker_id || !worker.assignment_id || worker.active) continue;
      if (args.assignment_id && args.assignment_id !== worker.assignment_id) continue;
      const assignment = this._get("assignment", worker.assignment_id);
      const challenge = this._challenge(assignment.challenge_id);
      if (!["completed", "deferred"].includes(challenge.phase)) continue;
      assignment.released_at = this.clock();
      this._save("assignment", assignment);
      for (const intent of this._all("intent", challenge.id)) {
        if (intent.status === "claimed" && intent.holder === worker.id) {
          intent.status = "open"; intent.holder = null; intent.claim_assignment_ref = null;
          intent.attempts++; intent.version++;
          intent.notes ??= [];
          intent.notes.push({ by: "platform", at: this.clock(), text: `Assignment released after ${challenge.phase}` });
          this._save("intent", intent);
        }
      }
      worker.assignment_id = null; worker.status = "idle"; worker.idle_generation++;
      this._save("worker", worker);
      if (challenge.owner_id === worker.id) challenge.owner_id = null;
      this._touch(challenge, "worker.released", [worker.id], {}, { claim: true });
      released.push(worker.id);
    }
    return { released };
  }
  _references(kind, ids, challengeId, name) {
    requireValue(Array.isArray(ids), "invalid_argument", `${name} must be an array`);
    for (const id of ids) requireValue(this._get(kind, id)?.challenge_id === challengeId,
      "invalid_reference", `${name} contains a reference outside this challenge`);
    return [...new Set(ids)];
  }
  _evidence(values, challenge, actor) {
    requireValue(Array.isArray(values) && values.length > 0, "evidence_required", "Fact needs evidence");
    return values.map((value) => {
      requireValue(value && typeof value === "object" && !Array.isArray(value), "invalid_evidence", "Evidence must be an object");
      const summary = text(value.summary, "evidence.summary");
      if (value.artifact_id) {
        const artifact = this._get("artifact", value.artifact_id);
        requireValue(artifact && artifact.challenge_id === challenge.id, "invalid_evidence", "Unknown artifact for this challenge");
        return { ...artifact, artifact_id: artifact.id, summary };
      }
      requireValue(["text", "http", "code_ref"].includes(value.type), "invalid_evidence", "File and command evidence must reference a registered artifact");
      requireValue(!value.uri && !value.sha256 && !value.call_id, "invalid_evidence", "Evidence identity comes from registered artifacts");
      return { type: value.type, summary, ...(value.path ? { path: text(value.path, "evidence.path") } : {}), author: actor };
    });
  }
  _fact(actor, challenge, args, context = null) {
    requireValue(["observation", "inference", "structure"].includes(args.kind ?? "observation"), "invalid_argument", "Invalid fact kind");
    const derived = this._references("fact", args.derived_from ?? [], challenge.id, "derived_from");
    const disputes = this._references("fact", args.disputes ?? [], challenge.id, "disputes");
    requireValue(args.kind !== "inference" || derived.length > 0, "invalid_fact", "Inference requires existing facts");
    requireValue(Boolean(args.resolves) === Boolean(args.result), "invalid_fact", "resolves and result must be supplied together");
    const evidence = this._evidence(args.evidence, challenge, actor);
    const fact = { id: randomUUID(), challenge_id: challenge.id, kind: args.kind ?? "observation",
      statement: text(args.statement, "statement"), evidence, derived_from: derived, disputes,
      resolves: args.resolves ?? null, result: args.result ?? null, author: actor,
      assignment_ref: context, environment_generation: challenge.generation, status: "proposed",
      provenance: evidence.some((item) => item.call_id) ? "tool_backed" : "self_reported", version: 1, created_at: this.clock() };
    if (args.resolves) {
      const intent = this._get("intent", args.resolves);
      requireValue(intent?.challenge_id === challenge.id && intent.status === "claimed" && intent.holder === actor,
        "intent_not_held", "Only its current holder can close an Intent");
      requireValue(["confirmed", "rejected", "inconclusive"].includes(args.result), "invalid_argument", "Invalid Intent result");
      intent.status = "closed"; intent.result = args.result; intent.closed_by = actor;
      intent.result_facts ??= [];
      intent.result_facts.push(fact.id); intent.version++;
      this._save("intent", intent);
    }
    this._save("fact", fact);
    for (const id of disputes) {
      const old = this._get("fact", id);
      old.version = (Number.isSafeInteger(old.version) ? old.version : 1) + 1;
      this._save("fact", old);
    }
    return fact;
  }
  _postFactAction(actor, args, context) {
    const challenge = this._authority(actor, args, context,
      { phases: actor === "lead" ? ["pending", "assembling", "solving", "reviewing", "deferred"]
        : ["assembling", "solving"], revision: false });
    const fact = this._fact(actor, challenge, args, context);
    const nextIntents = [];
    if (args.next_intents !== undefined) {
      requireValue(Array.isArray(args.next_intents) && args.next_intents.length <= MAX_WORKER_INTENTS,
        "invalid_argument", `next_intents must contain at most ${MAX_WORKER_INTENTS} directions`);
      for (const next of args.next_intents) {
        requireValue(next && typeof next === "object" && !Array.isArray(next),
          "invalid_argument", "next_intents entries must be objects");
        nextIntents.push(this._createIntent(actor, challenge, { ...next, based_on: [fact.id] }, context));
      }
    }
    const assistanceChanged = this._autoAssistance(challenge);
    this._touch(challenge, "fact.posted", [], { fact_id: fact.id }, { claim: assistanceChanged });
    for (const intent of nextIntents) {
      this._event("intent.posted", challenge, [], { intent_id: intent.id });
    }
    return { fact, intents: nextIntents, revision: challenge.revision,
      claim_revision: challenge.claim_revision };
  }
  _postIntent(actor, args, context) {
    const challenge = this._authority(actor, args, context,
      { phases: ["assembling", "solving"], revision: false });
    const intent = this._createIntent(actor, challenge, args, context);
    const assistanceChanged = this._autoAssistance(challenge);
    this._touch(challenge, "intent.posted", [], { intent_id: intent.id }, { claim: assistanceChanged });
    return { intent: this._get("intent", intent.id), revision: challenge.revision,
      claim_revision: challenge.claim_revision };
  }
  _createIntent(actor, challenge, args, context) {
    const basedOn = this._references("fact", args.based_on, challenge.id, "based_on");
    requireValue(basedOn.length > 0, "invalid_intent", "Intent requires an existing Fact");
    const disputes = this._references("intent", args.disputes ?? [], challenge.id, "disputes");
    const dependencies = this._references("intent", args.depends_on ?? [], challenge.id, "depends_on");
    if (args.retry_of) this._references("intent", [args.retry_of], challenge.id, "retry_of");
    const parallelKey = args.parallel ? text(args.parallel_key, "parallel_key") : null;
    if (parallelKey) requireValue(!this._all("intent", challenge.id).some((item) => item.environment_generation === challenge.generation && item.parallel_key === parallelKey && item.status !== "closed"),
      "duplicate_direction", "An open or held Intent already represents this parallel direction");
    const intent = { id: randomUUID(), challenge_id: challenge.id, statement: text(args.statement, "statement"),
      based_on: basedOn, expected: text(args.expected, "expected"), method: text(args.method, "method"),
      relates_to: args.relates_to ?? [], retry_of: args.retry_of ?? null, depends_on: dependencies,
      disputes,
      parallel: Boolean(args.parallel), parallel_key: parallelKey, status: "open", holder: null,
      claimed_at: null, claim_assignment_ref: null, result: null, closed_by: null, result_facts: [],
      notes: [], attempts: 0, author: actor, assignment_ref: context, environment_generation: challenge.generation,
      version: 1, created_at: this.clock() };
    this._save("intent", intent);
    for (const id of disputes) {
      const target = this._get("intent", id);
      target.version = (Number.isSafeInteger(target.version) ? target.version : 1) + 1;
      this._save("intent", target);
    }
    if (args.claim) this._claimIntent(actor, challenge, intent, context);
    return intent;
  }
  _readyIntent(intent, generation = intent.environment_generation) {
    return intent.environment_generation === generation && (intent.depends_on ?? []).every((id) => {
      const dependency = this._get("intent", id);
      return dependency?.environment_generation === generation && dependency.status === "closed" && dependency.result === "confirmed";
    });
  }
  _claimIntent(actor, challenge, intent, context) {
    requireValue(actor !== "lead" && actor !== "platform", "forbidden", "Workers hold Intent work");
    requireValue(intent.environment_generation === challenge.generation, "stale_intent", "Post a current-environment Intent with retry_of before resuming this direction");
    requireValue(intent.status === "open" && this._readyIntent(intent), "intent_unavailable", "Intent is held or dependencies are not confirmed");
    requireValue(this._all("intent", challenge.id).filter((item) => item.status === "claimed" && item.holder === actor).length < MAX_WORKER_INTENTS,
      "intent_limit", "Worker already holds three Intents");
    intent.status = "claimed"; intent.holder = actor; intent.claimed_at = this.clock();
    intent.claim_assignment_ref = context; intent.version++;
    this._save("intent", intent);
  }
  _claimIntentAction(actor, args, context) {
    const challenge = this._authority(actor, args, context,
      { phases: ["assembling", "solving"], revision: false });
    const intent = this._get("intent", args.intent_id);
    requireValue(intent?.challenge_id === challenge.id, "invalid_reference", "Intent belongs to another challenge");
    requireValue(intent.version === args.expected_version, "intent_version_conflict", "Intent version changed");
    this._claimIntent(actor, challenge, intent, context);
    const assistanceChanged = this._autoAssistance(challenge);
    this._touch(challenge, "intent.claimed", [], { intent_id: intent.id }, { claim: assistanceChanged });
    return { intent, revision: challenge.revision, claim_revision: challenge.claim_revision };
  }
  _releaseIntent(actor, args, context) {
    const challenge = this._authority(actor, args, context,
      { phases: ["assembling", "solving"], revision: false });
    const intent = this._get("intent", args.intent_id);
    requireValue(intent?.challenge_id === challenge.id && intent.status === "claimed" && intent.holder === actor,
      "intent_not_held", "Only its holder can release an Intent");
    intent.notes ??= [];
    intent.notes.push({ by: actor, at: this.clock(), text: text(args.note, "note") });
    intent.status = "open"; intent.holder = null; intent.claim_assignment_ref = null; intent.attempts++; intent.version++;
    this._save("intent", intent);
    const assistanceChanged = this._autoAssistance(challenge);
    this._touch(challenge, "intent.released", [], { intent_id: intent.id }, { claim: assistanceChanged });
    return { intent, revision: challenge.revision, claim_revision: challenge.claim_revision };
  }
  _assistanceEvidence(challenge, disputeIndex = this._disputeIndex(challenge.id)) {
    const directions = this._all("intent", challenge.id).filter((intent) =>
      intent.environment_generation === challenge.generation
      && intent.status === "open"
      && intent.parallel === true
      && intent.holder === null
      && this._readyIntent(intent, challenge.generation));
    const blockers = (challenge.assistance_blocker_facts ?? []).flatMap((item) => {
      if (item.generation !== challenge.generation) return [];
      const fact = this._withDisputeRelations(
        "fact", disputeIndex.entities.fact.get(item.fact_id), disputeIndex);
      return fact?.challenge_id === challenge.id
        && fact.environment_generation === challenge.generation
        && fact.status !== "disputed" ? [item] : [];
    });
    return { directions, blockers };
  }
  _assistanceCapacity(challenge) {
    const { directions, blockers } = this._assistanceEvidence(challenge);
    let base = hardAssistanceFloor(challenge);
    if (blockers.length) base += 1;
    if (!base && challenge.assistance_reminded) base = 1;
    return Math.min(MAX_CHALLENGE_WORKERS - 1, base + directions.length);
  }
  _autoAssistance(challenge) {
    const previous = challenge.assistance_target;
    if (!["assembling", "solving"].includes(challenge.phase)) {
      challenge.assistance_target = this._assistanceCapacity(challenge);
      challenge.assistance_requested = Math.max(0,
        challenge.assistance_target - hardAssistanceFloor(challenge));
      return challenge.assistance_target !== previous;
    }
    const { directions } = this._assistanceEvidence(challenge);
    const members = this._members(challenge.id);
    const claimed = new Set(this._all("intent", challenge.id)
      .filter((item) => item.status === "claimed" && item.holder)
      .map((item) => item.holder));
    const unoccupied = members.filter((member) => !member.active && !claimed.has(member.worker_id)).length;
    const capacity = this._assistanceCapacity(challenge);
    const automatic = Math.min(capacity,
      hardAssistanceFloor(challenge) + Math.max(0, directions.length - unoccupied));
    const retained = Math.min(capacity, boundedInteger(challenge.assistance_target));
    challenge.assistance_target = Math.min(capacity,
      Math.max(hardAssistanceFloor(challenge), automatic, retained));
    challenge.assistance_requested = Math.max(0,
      challenge.assistance_target - hardAssistanceFloor(challenge));
    return challenge.assistance_target !== previous;
  }
  _registerArtifact(actor, args) {
    this._platform(actor);
    const challenge = this._challenge(args.challenge_id);
    if (args.worker_id !== "lead") {
      const assignment = this._get("assignment", args.context?.assignment_id);
      requireValue(assignment && assignment.challenge_id === challenge.id && assignment.worker_id === args.worker_id
        && assignment.generation === args.context.generation
        && assignment.environment_generation === args.context.environment_generation, "stale_context", "Artifact has no valid execution origin");
    }
    requireValue(/^[0-9a-f]{64}$/.test(args.sha256), "invalid_artifact", "Artifact needs its content SHA-256");
    requireValue(!this._all("artifact").some((item) => item.uri === args.uri && item.sha256 !== args.sha256),
      "invalid_artifact", "An immutable evidence URI cannot change content");
    const artifact = { id: randomUUID(), challenge_id: challenge.id, worker_id: args.worker_id,
      assignment_ref: args.context ?? null, environment_generation: args.context?.environment_generation ?? challenge.generation,
      type: args.type ?? "file", path: text(args.path, "path"), uri: text(args.uri, "uri"),
      sha256: args.sha256, size: integer(args.size, 0, Number.MAX_SAFE_INTEGER, "size"),
      call_id: args.call_id ?? null, captured_at: this.clock(), capture: args.capture ?? "snapshot" };
    this._save("artifact", artifact);
    this._event("artifact.registered", challenge, [], { artifact_id: artifact.id });
    return artifact;
  }
  _requestAssistance(actor, args, context) {
    const challenge = this._authority(actor, args, context, { phases: ["assembling", "solving"] });
    const additional = integer(args.additional_workers ?? 1, 1, MAX_CHALLENGE_WORKERS - 1, "additional_workers");
    const reason = text(args.reason, "reason");
    let selectedDirections = args.intent_ids === undefined
      ? []
      : this._references("intent", args.intent_ids, challenge.id, "intent_ids");
    const disputeIndex = this._disputeIndex(challenge.id);
    const evidence = this._assistanceEvidence(challenge, disputeIndex);
    if (!selectedDirections.length && args.blocker_fact_id === undefined) {
      selectedDirections = evidence.directions.slice(0, additional).map((intent) => intent.id);
    }
    requireValue(selectedDirections.length <= additional, "invalid_argument",
      "intent_ids cannot exceed additional_workers");
    for (const id of selectedDirections) {
      requireValue(evidence.directions.some((intent) => intent.id === id),
        "direction_unavailable", "Assistance directions must be current, parallel, ready and unclaimed", {
          available_direction_ids: evidence.directions.map((intent) => intent.id),
        });
    }
    let blockerFact = null;
    if (args.blocker_fact_id !== undefined) {
      blockerFact = this._withDisputeRelations("fact",
        disputeIndex.entities.fact.get(text(args.blocker_fact_id, "blocker_fact_id")), disputeIndex);
      requireValue(blockerFact?.challenge_id === challenge.id
        && blockerFact.environment_generation === challenge.generation
        && blockerFact.status !== "disputed",
      "invalid_reference", "blocker_fact_id must be a current, usable Fact from this challenge");
      challenge.assistance_blocker_facts ??= [];
      if (!challenge.assistance_blocker_facts.some((item) =>
        item.fact_id === blockerFact.id && item.generation === challenge.generation)) {
        challenge.assistance_blocker_facts.push({
          fact_id: blockerFact.id,
          generation: challenge.generation,
          requested_by: actor,
          requested_at: this.clock(),
        });
      }
    }
    challenge.assistance_direction_intents ??= [];
    for (const intentId of selectedDirections) {
      if (!challenge.assistance_direction_intents.some((item) =>
        item.intent_id === intentId && item.generation === challenge.generation)) {
        challenge.assistance_direction_intents.push({
          intent_id: intentId,
          generation: challenge.generation,
          requested_by: actor,
          requested_at: this.clock(),
        });
      }
    }
    const currentTarget = boundedInteger(challenge.assistance_target);
    const capacity = this._assistanceCapacity(challenge);
    if (capacity <= currentTarget && selectedDirections.length) {
      return { ...this._challengeReceipt(challenge), assistance_already_open: true };
    }
    requireValue(capacity > currentTarget, "assistance_evidence_required",
      "Add a distinct ready parallel Intent or reference a concrete blocker Fact before requesting more Workers. "
        + "Use intent_ids, blocker_fact_id, or both.", {
        current_target: currentTarget,
        available_direction_ids: evidence.directions.map((intent) => intent.id),
        blocker_fact_id: blockerFact?.id ?? null,
      });
    challenge.assistance_target = Math.min(capacity, currentTarget + additional);
    challenge.assistance_requested = Math.max(0,
      challenge.assistance_target - hardAssistanceFloor(challenge));
    this._touch(challenge, "assistance.requested", [], {
      reason,
      direction_ids: selectedDirections,
      blocker_fact_id: blockerFact?.id ?? null,
    }, { claim: true });
    return this._challengeReceipt(challenge);
  }

  _requestDeferral(actor, args, context) {
    const challenge = this._authority(actor, args, context, { phases: ["assembling", "solving"] });
    const reason = text(args.reason, "reason");
    const fact = this._fact(actor, challenge, {
      kind: "observation",
      statement: `Deferral requested: ${reason}`,
      evidence: [{ type: "text", summary: "Worker reported a concrete blocker and requested Lead review" }],
    }, context);
    this._touch(challenge, "deferral.requested", ["lead"], { fact_id: fact.id, reason });
    return { fact, revision: challenge.revision };
  }
  _clock(challenge, running) {
    const now = this.clock();
    if (challenge.solve_started_at !== null) challenge.solve_elapsed_ms += Math.max(0, now - challenge.solve_started_at);
    challenge.solve_started_at = running ? now : null;
  }
  _submitReview(actor, args, context) {
    const challenge = this._authority(actor, args, context,
      { phases: ["assembling", "solving", "reviewing"], revision: false });
    this._revision(challenge, args, challenge.phase === "reviewing");
    const factRefs = this._references("fact", args.fact_refs ?? [], challenge.id, "fact_refs");
    const flag = text(args.flag, "flag");
    const summary = text(args.summary, "summary");
    if (challenge.phase === "reviewing") requireValue(args.expected_revision >= challenge.review_base_revision,
      "stale_review", "Candidate update belongs to an earlier review round");
    if (challenge.phase !== "reviewing") {
      challenge.review_base_revision = challenge.revision;
      this._clock(challenge, false); challenge.phase = "reviewing"; challenge.review_revision++;
    }
    let candidate = this._all("candidate", challenge.id).find((item) => item.flag === flag
      && item.environment_generation === challenge.generation && item.review_revision === challenge.review_revision);
    if (!candidate) {
      candidate = { id: randomUUID(), challenge_id: challenge.id, flag, summary, fact_refs: factRefs,
        author: actor, assignment_ref: context, environment_generation: challenge.generation,
        review_revision: challenge.review_revision, created_at: this.clock() };
      this._save("candidate", candidate);
    }
    challenge.review_summary = summary;
    this._touch(challenge, "review.requested", ["lead"], { candidate_id: candidate.id }, { claim: true });
    return { candidate, challenge: this._challengeReceipt(challenge) };
  }
  _beginSubmission(actor, args) {
    this._lead(actor);
    const challenge = this._authority(actor, args, null, { phases: ["reviewing"], revision: false });
    requireValue(args.review_revision === challenge.review_revision, "stale_review", "Review round changed");
    const candidate = this._get("candidate", args.candidate_id);
    requireValue(candidate?.challenge_id === challenge.id && candidate.environment_generation === challenge.generation
      && candidate.review_revision === challenge.review_revision, "stale_candidate", "Candidate belongs to older work");
    const unresolved = this._all("submission", challenge.id)
      .find((item) => ["pending", "unknown"].includes(item.status));
    if (unresolved) {
      requireValue(unresolved.status === "unknown" && unresolved.candidate_id === candidate.id
        && unresolved.environment_generation === challenge.generation
        && unresolved.review_revision === challenge.review_revision,
      "submission_unresolved",
      "An unknown submission can retry only the same candidate in the same review round");
      if (args.reconciled_unknown !== true) {
        return {
          submission: unresolved,
          should_submit: false,
          reconcile_required: true,
          reason: "Reconcile official progress before retrying the same unknown submission",
        };
      }
      unresolved.retry_history = [...(unresolved.retry_history ?? []), {
        previous_status: unresolved.status,
        at: this.clock(),
      }];
      unresolved.retry_count = (unresolved.retry_count ?? 0) + 1;
      unresolved.status = "pending";
      unresolved.attempts = (unresolved.attempts ?? 1) + 1;
      unresolved.sent_at = this.clock();
      unresolved.updated_at = this.clock();
      this._save("submission", unresolved);
      this._touch(challenge, "submission.retry_started", ["lead"], { submission_id: unresolved.id });
      return { submission: unresolved, should_submit: true, retry: true };
    }
    const submission = { id: randomUUID(), challenge_id: challenge.id, candidate_id: candidate.id,
      flag: candidate.flag, unique_code: challenge.unique_code, review_revision: challenge.review_revision,
      environment_generation: challenge.generation,
      baseline_correct_flag_count: challenge.correct_flag_count ?? null,
      status: "pending", receipt: null, attempts: 1, sent_at: this.clock(), created_at: this.clock() };
    this._save("submission", submission);
    this._touch(challenge, "submission.started", ["lead"], { submission_id: submission.id });
    return { submission, should_submit: true };
  }
  _submissionResult(actor, args) {
    this._platform(actor);
    const submission = this._get("submission", args.submission_id);
    requireValue(submission, "submission_not_found", "Unknown submission");
    requireValue(["accepted", "rejected", "unknown", "not_sent"].includes(args.status), "invalid_argument", "Invalid submission result");
    requireValue(args.challenge_completed === undefined || typeof args.challenge_completed === "boolean",
      "invalid_argument", "challenge_completed must be boolean");
    const completing = submission.status === "accepted" && args.challenge_completed === true
      && submission.challenge_completed !== true;
    if (["accepted", "rejected", "not_sent"].includes(submission.status)) {
      requireValue(submission.status === args.status, "receipt_conflict", "A terminal receipt cannot be overwritten");
      if (!completing) return { submission, challenge: this.challenge(submission.challenge_id) };
    }
    submission.status = args.status; submission.receipt = args.receipt ?? submission.receipt ?? {};
    if (args.status === "accepted") submission.challenge_completed = args.challenge_completed ?? true;
    submission.reason = args.reason ?? (args.status === "accepted" ? "Official flag accepted" : "Submission outcome remains unknown");
    submission.updated_at = this.clock();
    this._save("submission", submission);
    const challenge = this._challenge(submission.challenge_id);
    const previousPhase = challenge.phase;
    const sameEnvironment = submission.environment_generation === challenge.generation;
    const currentReview = sameEnvironment && submission.review_revision === challenge.review_revision && challenge.phase === "reviewing";
    if (args.status === "accepted" && (currentReview || completing && sameEnvironment)) {
      if (submission.challenge_completed) {
        this._clock(challenge, false);
        challenge.phase = "completed"; challenge.environment.status = "closed"; challenge.ready = false;
      } else {
        this._reviewFeedback(challenge, "Official flag accepted. The challenge has remaining flags; continue solving.", submission);
      }
    } else if (currentReview && args.status === "rejected") {
      this._reviewFeedback(challenge, text(args.reason, "reason"), submission);
    }
    this._touch(challenge, `submission.${args.status}`, ["lead"], {
      submission_id: submission.id,
    }, { claim: challenge.phase !== previousPhase });
    return { submission, challenge: this.challenge(challenge.id) };
  }
  _reviewFeedback(challenge, reason, submission = null) {
    const fact = this._fact("lead", challenge, { kind: "observation", statement: reason,
      evidence: [{ type: "text", summary: submission ? `Official submission ${submission.id}: ${reason}` : `Lead review: ${reason}` }] });
    challenge.feedback_fact_id = fact.id;
    challenge.phase = this._members(challenge.id).length >= minimumTeamSize(challenge)
      ? "solving" : "assembling";
    this._clock(challenge, challenge.phase === "solving");
  }
  _rejectReview(actor, args) {
    this._lead(actor);
    const challenge = this._authority(actor, args, null, { phases: ["reviewing"] });
    requireValue(args.review_revision === challenge.review_revision, "stale_review", "Review round changed");
    requireValue(!this._all("submission", challenge.id).some((item) => ["pending", "unknown"].includes(item.status)),
      "submission_unresolved", "Reconcile pending official submission first");
    this._reviewFeedback(challenge, text(args.reason, "reason"));
    this._touch(challenge, "review.rejected", ["lead"], {}, { claim: true });
    return this._challengeReceipt(challenge);
  }
  _defer(actor, args) {
    this._lead(actor);
    const challenge = this._authority(actor, args, null, { phases: ["pending", "assembling", "solving", "reviewing"] });
    requireValue(!this._all("submission", challenge.id).some((item) => ["pending", "unknown"].includes(item.status)),
      "submission_unresolved", "Reconcile pending official submission before deferral");
    const reason = text(args.reason, "reason");
    this._fact("lead", challenge, { statement: reason, evidence: [{ type: "text", summary: `Lead deferral: ${reason}` }] });
    this._clock(challenge, false); challenge.phase = "deferred"; challenge.defer_reason = reason;
    this._touch(challenge, "challenge.deferred", ["lead"], {}, { claim: true });
    return this._challengeReceipt(challenge);
  }
  _resume(actor, args) {
    this._lead(actor);
    const challenge = this._authority(actor, args, null, { phases: ["deferred"] });
    requireValue(this._members(challenge.id).length === 0, "team_not_released", "Finish previous execution before resuming");
    challenge.phase = "pending"; challenge.owner_id = null; challenge.ready = false;
    this._touch(challenge, "challenge.resumed", ["lead"], {}, { claim: true });
    return this._challengeReceipt(challenge);
  }
  nextReminderAt() {
    const deadlines = this._all("challenge").filter((item) => item.phase === "solving" && !item.assistance_reminded && item.solve_started_at !== null)
      .map((item) => item.solve_started_at + Math.max(0, ASSISTANCE_REMINDER_MS - item.solve_elapsed_ms));
    return deadlines.length ? Math.min(...deadlines) : null;
  }
  _tick(actor) {
    this._platform(actor);
    const reminded = [];
    for (const challenge of this._all("challenge")) {
      if (challenge.phase !== "solving" || challenge.assistance_reminded || challenge.solve_started_at === null) continue;
      if (challenge.solve_elapsed_ms + this.clock() - challenge.solve_started_at < ASSISTANCE_REMINDER_MS) continue;
      this._clock(challenge, true); challenge.assistance_reminded = true;
      const previousTarget = challenge.assistance_target;
      if (!this._members(challenge.id).some((item) => item.role === "assistant")) {
        challenge.assistance_target = Math.max(1, this._assistanceCapacity(challenge));
        challenge.assistance_requested = Math.max(0,
          challenge.assistance_target - hardAssistanceFloor(challenge));
      }
      this._touch(challenge, "assistance.reminder", [challenge.owner_id, "lead"], {},
        { claim: challenge.assistance_target !== previousTarget });
      reminded.push(challenge.id);
    }
    return { reminded };
  }
  _progressStalled(actor, args) {
    this._platform(actor);
    const challenge = this._challenge(args.challenge_id);
    const worker = this._worker(args.worker_id);
    const event = this._event("progress.stalled", challenge, [worker.id, "lead"], {
      worker_id: worker.id,
      reason: text(args.reason, "reason"),
      signature: args.signature ?? null,
      attempts: args.attempts ?? null,
    });
    return { event_id: event.id, challenge_id: challenge.id, worker_id: worker.id };
  }
}
