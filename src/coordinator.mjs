import { mkdir, readFile, rename, open, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, basename, isAbsolute, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Board, MAX_COMPACT_DISPUTE_REFS } from "./board.mjs";
import { ArenaClient, challengeCompleted } from "./arena.mjs";
import { SessionPool } from "./sessions.mjs";
import { Resources } from "./resources.mjs";
import { snapshotFile } from "./artifacts.mjs";

const text = Type.String({ minLength: 1 });
const challengeParameter = Type.Object({ challenge_id: text });
const LEAD_ACTIONS = ["create_challenge", "update_challenge", "post_fact", "request_assistance", "reject_review"];
const WORKER_ACTIONS = ["claim", "post_fact", "post_intent", "claim_intent", "release_intent",
  "request_assistance", "request_deferral", "submit_review"];
const BOARD_ACTION_ARGUMENTS = {
  create_challenge: "unique_code,title; optional description,difficulty(easy|medium|hard),multi_stage,priority",
  update_challenge: "challenge_id,expected_revision; optional title,description,difficulty,multi_stage,priority",
  claim: "challenge_id,expected_claim_revision",
  post_fact: "challenge_id,statement,evidence[{type:text,summary}|{artifact_id,summary}]; optional kind(observation|inference|structure),derived_from,disputes:[fact_id],resolves,result,next_intents. Inferences require derived_from. resolves:intent_id and result:confirmed|rejected|inconclusive must appear together; next_intents entries support optional disputes:[intent_id]",
  post_intent: "challenge_id,statement,based_on:[fact_id],expected,method; optional claim,parallel,parallel_key,depends_on,retry_of,relates_to,disputes:[intent_id]. parallel=true requires parallel_key",
  claim_intent: "challenge_id,intent_id,expected_version",
  release_intent: "challenge_id,intent_id,note",
  request_assistance: "challenge_id,expected_revision,reason; optional additional_workers,intent_ids,blocker_fact_id. Use intent_ids and/or blocker_fact_id. Ready parallel Intents already open capacity; requesting the same direction is an idempotent confirmation",
  request_deferral: "challenge_id,expected_revision,reason",
  submit_review: "challenge_id,expected_revision,flag,summary; optional fact_refs",
  reject_review: "challenge_id,expected_revision,review_revision,reason",
};
const MAX_SESSION_ERROR_RETRIES = 3;
const MAX_IDLE_AVAILABLE_NOTICES = 2;
const PREPARED_INPUT_VERSION = 1;
const CONNECTIVITY_PROBE_TIMEOUT_MS = 4 * 60 * 1000;
const CONNECTIVITY_PROBE_EXIT_MARGIN_MS = 5 * 1000;
const CONNECTIVITY_PROBE_ABORT_GRACE_MS = 5 * 1000;
const STOP_GRACE_MS = 10 * 1000;
const HARD_BOOTSTRAP_REMINDER_MS = 5 * 60 * 1000;
const LOCAL_WORKSPACE_TOOLS = new Set(["bash", "snapshot_file", "record_fact"]);
const RUNTIME_HEALTH_FILE = "runtime-health.json";
const PERSISTED_STATE_MARKERS = [
  "events.jsonl",
  "sessions",
  "shared",
  "work",
  RUNTIME_HEALTH_FILE,
  "blackboard.sqlite-wal",
  "blackboard.sqlite-shm",
];

function orphanedState(workDir, blackboardPath) {
  const markers = PERSISTED_STATE_MARKERS.filter((name) => {
    const path = join(workDir, name);
    if (!existsSync(path)) return false;
    const info = statSync(path);
    return !info.isDirectory() || readdirSync(path).length > 0;
  });
  if (!existsSync(blackboardPath)) return markers;
  try {
    const database = new DatabaseSync(blackboardPath, { readOnly: true });
    try {
      const row = database.prepare("SELECT value FROM meta WHERE key='initialized'").get();
      if (row && JSON.parse(row.value) === true) return [];
    } finally {
      database.close();
    }
  } catch {}
  return ["blackboard.sqlite (uninitialized or unreadable)", ...markers];
}

async function readRuntimeHealth(workDir) {
  try {
    return JSON.parse(await readFile(join(workDir, RUNTIME_HEALTH_FILE), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { status: "invalid", error: error.message };
  }
}

async function persistRuntimeHealth(workDir, value) {
  const destination = join(workDir, RUNTIME_HEALTH_FILE);
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function persistedRuntimeSnapshot(snapshot) {
  return {
    sampled_at: snapshot.sampled_at,
    memory: {
      limit_bytes: snapshot.memory.limit_bytes,
      current_bytes: snapshot.memory.current_bytes,
      peak_bytes: snapshot.memory.peak_bytes,
    },
  };
}

async function settlesWithin(promise, timeoutMs) {
  const controller = new AbortController();
  let settled = false;
  const tracked = Promise.resolve(promise).then(
    () => { settled = true; },
    () => { settled = true; },
  );
  try {
    await Promise.race([tracked, delay(timeoutMs, undefined, { signal: controller.signal })]);
    return settled;
  } finally {
    controller.abort();
  }
}

function failure(error) {
  return { error: error.code ?? "operation_failed", message: error.message, outcome_unknown: error.outcomeUnknown ?? false };
}

function connectivityProbeError(message) {
  return Object.assign(new Error(message), { code: "connectivity_probe_error" });
}

function connectivityProbe(catalog) {
  if (!Array.isArray(catalog) || catalog.length !== 1) {
    throw connectivityProbeError(`A connectivity probe must expose exactly one challenge, received ${catalog?.length ?? 0}`);
  }
  const challenge = catalog[0];
  if (!challenge || typeof challenge.unique_code !== "string" || !challenge.unique_code
    || typeof challenge.description !== "string" || !challenge.description.trim()) {
    throw connectivityProbeError("The connectivity probe is missing unique_code or description");
  }
  const flags = [...new Set([...challenge.description.matchAll(/flag\{[^}\r\n]{1,512}\}/gi)]
    .map(match => match[0]))];
  if (flags.length !== 1) {
    throw connectivityProbeError(`The connectivity probe description must contain exactly one flag, received ${flags.length}`);
  }
  return { challenge, flag: flags[0] };
}

function environmentState(receipt) {
  const state = receipt?.container_status ?? receipt?.container?.status;
  if (receipt?.closed === true || ["stopped", "closed"].includes(state)) return "closed";
  if (["running", "ready", "active", "available"].includes(state)) return "active";
  if (receipt?.data_plane === false || receipt?.container === false
    || receipt?.container === 0 || receipt?.container === "false") return "active";
  if (["pending", "starting"].includes(state)) return "pending";
  if (state === "none" && receipt?.data_plane !== true) return "active";
  return "unknown";
}

function assignmentContext(context) {
  if (!context) return null;
  return Object.fromEntries(["worker_id", "assignment_id", "challenge_id", "generation", "environment_generation"].map(key => [key, context[key]]));
}

function catalogRequiresEnvironment(item, fallback = true) {
  if (typeof item?.data_plane === "boolean") return item.data_plane;
  if ([0, "false"].includes(item?.data_plane)) return false;
  if ([1, "true"].includes(item?.data_plane)) return true;
  if (typeof item?.container === "boolean") return item.container;
  if ([0, "false"].includes(item?.container)) return false;
  if ([1, "true"].includes(item?.container)) return true;
  if (item?.container_status === "available") return true;
  if (item?.container_status === "none" || item?.container?.status === "none") return false;
  return fallback;
}

function catalogMaterials(item) {
  if (item?.materials && Array.isArray(item.materials.files)) return item.materials;
  const values = Array.isArray(item?.materials) ? item.materials
    : Array.isArray(item?.files) ? item.files
      : Array.isArray(item?.attachments) ? item.attachments
        : item?.handout ? [item.handout] : [];
  return {
    status: values.length ? "listed" : "none",
    listed: values.length,
    files: values.map((entry) => typeof entry === "string" ? { path: entry } : {
      path: entry?.path ?? null,
      size: Number.isSafeInteger(entry?.size) ? entry.size : null,
      sha256: typeof entry?.sha256 === "string" ? entry.sha256 : null,
    }),
    missing: [],
  };
}

function sessionErrorDisposition(message) {
  const value = String(message ?? "").toLowerCase();
  if (/worker context identity mismatch|tool call has no model request identity/.test(value)) {
    return "degraded";
  }
  if (/\b(400|401|403|404|409)\b|permission|quota|insufficient|balance|invalid[ _-]?(api[ _-]?key|request|model)/i.test(value)) {
    return "degraded";
  }
  return "retry";
}

function compactCatalogItem(item) {
  const materials = item?.materials && Array.isArray(item.materials.files)
    ? item.materials
    : catalogMaterials(item);
  return {
    unique_code: item.unique_code,
    name: item.name ?? item.title ?? item.unique_code,
    description: typeof item.description === "string"
      ? item.description.length > 2000 ? `${item.description.slice(0, 2000)}…` : item.description
      : "",
    difficulty: item.difficulty ?? null,
    points: item.points ?? item.total_score ?? null,
    flag_count: item.flag_count ?? null,
    correct_flag_count: item.correct_flag_count ?? null,
    is_completed: item.is_completed === true,
    data_plane: item.data_plane ?? null,
    container: item.container ?? null,
    container_status: item.container_status ?? item.container?.status ?? null,
    requires_online_environment: catalogRequiresEnvironment(item),
    materials,
  };
}

function compactSubmissionResult(result, submission) {
  return {
    submission_id: submission?.id ?? null,
    candidate_id: submission?.candidate_id ?? null,
    outcome: result?.outcome ?? "unknown",
    correct_flag_count: result?.receipt?.correct_flag_count
      ?? result?.challenge?.correct_flag_count ?? null,
    is_completed: result?.challenge?.is_completed ?? null,
    cumulative_score: result?.cumulativeScore ?? null,
    challenge_id: submission?.challenge_id ?? null,
    title: result?.challenge?.name ?? result?.challenge?.title ?? null,
    reason: result?.reason ?? result?.error?.message ?? null,
  };
}

function preparationMarkerKey(challenge) {
  return `offline_prepared:${challenge.id}:${challenge.generation}`;
}

function activationMarkerKey(challenge) {
  return `environment_activated:${challenge.id}:${challenge.generation}`;
}

function normalizedPreparedFiles(files) {
  if (!Array.isArray(files)) return null;
  const normalized = [];
  for (const file of files) {
    if (!file || typeof file !== "object"
      || typeof file.source_path !== "string" || !file.source_path
      || typeof file.path !== "string" || !file.path
      || !Number.isSafeInteger(file.size) || file.size < 0
      || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) return null;
    normalized.push({
      source_path: file.source_path,
      path: file.path,
      size: file.size,
      sha256: file.sha256,
    });
  }
  return normalized.sort((left, right) => left.source_path.localeCompare(right.source_path));
}

function samePreparedFiles(left, right) {
  const normalizedLeft = normalizedPreparedFiles(left);
  const normalizedRight = normalizedPreparedFiles(right);
  return normalizedLeft !== null && normalizedRight !== null
    && JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function pathInside(root, path) {
  const nested = relative(root, resolve(path));
  return nested !== "" && !nested.startsWith("..") && !isAbsolute(nested);
}

function challengeSummary(challenge) {
  const assistantCount = challenge.members.filter(member => member.role === "assistant").length;
  const openSlots = ["assembling", "solving"].includes(challenge.phase) && challenge.ready && challenge.owner_id
    ? Math.max(0, Math.min(9 - challenge.members.length,
      (challenge.assistance_target ?? 0) - assistantCount))
    : 0;
  return {
    id: challenge.id,
    unique_code: challenge.unique_code,
    title: challenge.title,
    description: challenge.description.length > 1200
      ? `${challenge.description.slice(0, 1200)}…`
      : challenge.description,
    difficulty: challenge.difficulty,
    priority: challenge.priority,
    phase: challenge.phase,
    defer_reason: challenge.defer_reason ?? null,
    revision: challenge.revision,
    claim_revision: challenge.claim_revision,
    generation: challenge.generation,
    ready: challenge.ready,
    offline: challenge.requires_online_environment === false,
    points: challenge.points ?? challenge.total_score ?? null,
    flag_count: challenge.flag_count ?? null,
    correct_flag_count: challenge.correct_flag_count ?? null,
    owner_id: challenge.owner_id,
    needs_assistance: challenge.needs_assistance,
    member_count: challenge.members.length,
    assistant_count: assistantCount,
    assistance_target: challenge.assistance_target ?? 0,
    open_assistance_slots: openSlots,
    fact_count: challenge.facts.length,
    intent_count: challenge.intents.length,
    candidate_count: challenge.candidates.length,
    submission_count: challenge.submissions.length,
    environment: {
      status: challenge.environment?.status ?? null,
      online: challenge.environment?.online === true,
      last_error: ["closed", "unknown"].includes(challenge.environment?.status)
        && challenge.environment?.connection?.code
        ? {
            code: challenge.environment.connection.code,
            message: challenge.environment.connection.message,
            status: challenge.environment.connection.status ?? null,
            detail: challenge.environment.connection.detail ?? null,
          }
        : null,
    },
  };
}

function compactResources(snapshot) {
  const workers = snapshot?.execution?.workers ?? [];
  const idleWorkers = workers.filter(worker => worker.status === "idle" && !worker.active && !worker.assignment_id);
  return {
    sampled_at: snapshot?.sampled_at ?? null,
    cpu: snapshot?.cpu ? {
      quota_cpus: snapshot.cpu.quota_cpus,
      used_cpus: snapshot.cpu.used_cpus,
      usage_interval_ms: snapshot.cpu.usage_interval_ms,
    } : null,
    memory: snapshot?.memory ? {
      limit_bytes: snapshot.memory.limit_bytes,
      current_bytes: snapshot.memory.current_bytes,
      peak_bytes: snapshot.memory.peak_bytes,
      anonymous_bytes: snapshot.memory.anonymous_bytes,
      file_cache_bytes: snapshot.memory.file_cache_bytes,
      oom_count: snapshot.memory.oom_count ?? null,
      oom_kill_count: snapshot.memory.oom_kill_count ?? null,
      node: snapshot.memory.node ? {
        rss: snapshot.memory.node.rss,
        heapUsed: snapshot.memory.node.heapUsed,
        heapTotal: snapshot.memory.node.heapTotal,
        external: snapshot.memory.node.external,
      } : null,
    } : null,
    disk: snapshot?.disk ? { available_bytes: snapshot.disk.available_bytes } : null,
    event_loop: snapshot?.event_loop ? { p99_ms: snapshot.event_loop.p99_ms } : null,
    runtime: snapshot?.runtime ?? null,
    execution: {
      model_inflight: (snapshot?.execution?.sessions ?? [])
        .reduce((total, session) => total + Number(session.model_inflight ?? 0), 0),
      tool_inflight: (snapshot?.execution?.sessions ?? [])
        .reduce((total, session) => total + Number(session.tool_inflight ?? 0), 0),
    },
    workers: {
      total: workers.length,
      idle: idleWorkers.length,
    },
  };
}

function assistanceNeedSummary(challenge) {
  const summary = challengeSummary(challenge);
  return {
    id: summary.id,
    unique_code: summary.unique_code,
    title: summary.title,
    difficulty: summary.difficulty,
    priority: summary.priority,
    phase: summary.phase,
    revision: summary.revision,
    claim_revision: summary.claim_revision,
    owner_id: summary.owner_id,
    member_count: summary.member_count,
    assistance_target: summary.assistance_target,
    open_assistance_slots: summary.open_assistance_slots,
    needs_assistance: summary.needs_assistance,
  };
}

function factSummary(fact) {
  const disputes = fact.disputes ?? [];
  const disputedBy = fact.disputed_by ?? [];
  return {
    id: fact.id,
    version: fact.version,
    statement: fact.statement,
    kind: fact.kind,
    provenance: fact.provenance,
    derived_from: fact.derived_from ?? [],
    status: fact.status,
    author: fact.author,
    environment_generation: fact.environment_generation,
    ...(fact.resolves ? { resolves: fact.resolves, result: fact.result } : {}),
    ...(disputes.length ? {
      disputes: disputes.slice(0, MAX_COMPACT_DISPUTE_REFS),
      disputes_count: disputes.length,
      disputes_truncated: disputes.length > MAX_COMPACT_DISPUTE_REFS,
    } : {}),
    ...(disputedBy.length ? {
      disputed_by: disputedBy.slice(-MAX_COMPACT_DISPUTE_REFS),
      disputed_by_count: disputedBy.length,
      disputed_by_truncated: disputedBy.length > MAX_COMPACT_DISPUTE_REFS,
    } : {}),
    artifact_refs: (fact.evidence ?? [])
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

function intentSummary(intent) {
  const disputes = intent.disputes ?? [];
  const disputedBy = intent.disputed_by ?? [];
  return {
    id: intent.id,
    version: intent.version,
    statement: intent.statement,
    status: intent.status,
    holder: intent.holder ?? null,
    environment_generation: intent.environment_generation,
    based_on: intent.based_on ?? [],
    depends_on: intent.depends_on ?? [],
    ...(intent.status === "closed" ? {
      result: intent.result ?? null,
      result_facts: intent.result_facts ?? [],
    } : {}),
    ...(disputes.length ? {
      disputes: disputes.slice(0, MAX_COMPACT_DISPUTE_REFS),
      disputes_count: disputes.length,
      disputes_truncated: disputes.length > MAX_COMPACT_DISPUTE_REFS,
    } : {}),
    ...(disputedBy.length ? {
      disputed_by: disputedBy.slice(-MAX_COMPACT_DISPUTE_REFS),
      disputed_by_count: disputedBy.length,
      disputed_by_truncated: disputedBy.length > MAX_COMPACT_DISPUTE_REFS,
    } : {}),
    ...(intent.disputed === true ? { disputed: true } : {}),
    parallel: intent.parallel === true,
    parallel_key: intent.parallel_key ?? null,
  };
}

function assignmentTaskState(challenge, event, role, eventCursor = event.id, { forceTaskRead = false } = {}) {
  const latestIntents = [...(challenge.intents ?? [])]
    .sort((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0))
    .slice(-3);
  const intentsById = new Map((challenge.intents ?? []).map(intent => [intent.id, intent]));
  const factsById = new Map((challenge.facts ?? []).map(fact => [fact.id, fact]));
  const unclaimedParallelIntents = [...(challenge.intents ?? [])]
    .filter((intent) => intent.environment_generation === challenge.generation
      && intent.parallel === true
      && intent.status === "open"
      && intent.holder === null
      && (intent.depends_on ?? []).every((id) => {
        const dependency = intentsById.get(id);
        return dependency?.environment_generation === challenge.generation
          && dependency.status === "closed"
          && dependency.result === "confirmed";
      }))
    .sort((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0))
    .slice(-3)
    .map(intentSummary);
  const assistanceBlockers = (challenge.assistance_blocker_facts ?? [])
    .filter(item => item.generation === challenge.generation)
    .map((item) => {
      const fact = factsById.get(item.fact_id);
      return fact ? factSummary(fact) : null;
    })
    .filter(Boolean)
    .slice(-3);
  const assistanceDirections = (challenge.assistance_direction_intents ?? [])
    .filter(item => item.generation === challenge.generation)
    .map((item) => {
      const intent = intentsById.get(item.intent_id);
      return intent ? intentSummary(intent) : { id: item.intent_id, status: "missing" };
    })
    .slice(-3);
  const needsTaskRead = forceTaskRead
    || (challenge.description ?? "").length > 1200
    || challenge.facts.length + challenge.intents.length + challenge.candidates.length > 0;
  return {
    challenge_id: challenge.id,
    revision: challenge.revision,
    claim_revision: challenge.claim_revision,
    phase: challenge.phase,
    fact_count: challenge.facts.length,
    intent_count: challenge.intents.length,
    candidate_count: challenge.candidates.length,
    latest_facts: (challenge.facts ?? []).slice(-3).map(factSummary),
    latest_intents: latestIntents.map(intentSummary),
    event_cursor: eventCursor,
    assignment_event_id: event.id,
    needs_task_read: needsTaskRead,
    assignment_role: role,
    assignment_reason: role === "assistant"
      ? "Assistance assignment; no direction is preassigned. Read task state. When investigating, reuse your "
        + "current held Intent, claim an open ready Intent, or after brief reconnaissance use post_intent "
        + "with claim:true for a distinct goal, method and expected result. Other workers' claimed Intents "
        + "are not assigned to you"
      : "Primary assignment; read task state before solving",
    assistance: {
      target: challenge.assistance_target ?? 0,
      blocker_facts: assistanceBlockers,
      requested_directions: assistanceDirections,
    },
    unclaimed_parallel_intents: unclaimedParallelIntents,
  };
}

function assistanceGapMarkerKey(challenge) {
  return `lead_assistance_gap:${challenge.id}:${challenge.generation}`;
}

function hardBootstrapToolMarkerKey(assignmentId) {
  return `hard_bootstrap_tool:${assignmentId}`;
}

function hardBootstrapReminderMarkerKey(assignmentId) {
  return `hard_bootstrap_reminder:${assignmentId}`;
}

function hardBootstrapReminderEventId(challenge, assignmentId) {
  return `hard-bootstrap-reminder:${challenge.id}:${challenge.generation}:${assignmentId}`;
}

function hardBootstrapReminderEventPrefix(challengeId) {
  return `hard-bootstrap-reminder:${challengeId}:`;
}

function hardBootstrapProgress(challenge, workerId, assignmentId, startedAt) {
  const ownFact = challenge.facts.some((fact) => fact.assignment_ref?.assignment_id === assignmentId);
  const ownIntent = challenge.intents.some((intent) => intent.assignment_ref?.assignment_id === assignmentId);
  const ownCandidate = challenge.candidates.some((candidate) =>
    candidate.assignment_ref?.assignment_id === assignmentId);
  if (ownFact || ownIntent || ownCandidate) return "assignment_progress";

  const teammates = new Set(challenge.members
    .map(member => member.worker_id)
    .filter(id => id !== workerId));
  const reusableFact = challenge.facts.some((fact) => fact.environment_generation === challenge.generation
    && fact.created_at >= startedAt && teammates.has(fact.author) && fact.status !== "disputed");
  const reusableIntent = challenge.intents.some((intent) => intent.environment_generation === challenge.generation
    && intent.created_at >= startedAt && teammates.has(intent.author)
    && !(intent.status === "closed" && intent.result === "rejected"));
  if (reusableFact || reusableIntent) return "team_progress";

  const candidateProgress = challenge.candidates.some((candidate) =>
    candidate.environment_generation === challenge.generation && candidate.created_at >= startedAt);
  return candidateProgress ? "candidate_progress" : null;
}

function assistanceGapState(challenge) {
  const summary = challengeSummary(challenge);
  return {
    generation: challenge.generation,
    assistance_target: summary.assistance_target,
    open_assistance_slots: summary.open_assistance_slots,
    member_count: summary.member_count,
  };
}

function candidateSummary(candidate) {
  return {
    id: candidate.id,
    author: candidate.author,
    summary: candidate.summary,
    review_revision: candidate.review_revision,
    environment_generation: candidate.environment_generation,
    flag: candidate.flag,
  };
}

async function fileMetadata(path) {
  const info = await stat(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, size: info.size, sha256: hash.digest("hex") };
}

export class ContestRun {
  static async create(config, { arena, board, poolFactory = options => SessionPool.create(options), streamFunction } = {}) {
    await mkdir(config.workDir, { recursive: true });
    const blackboardPath = join(config.workDir, "blackboard.sqlite");
    if (!board) {
      const existing = orphanedState(config.workDir, blackboardPath);
      if (existing.length) {
        throw Object.assign(new Error(
          `blackboard.sqlite is missing or invalid while persisted runtime state exists (${existing.join(", ")}); `
          + "restore the work-volume snapshot instead of starting with an empty board",
        ), { code: "state_store_missing" });
      }
    }
    const previousHealth = await readRuntimeHealth(config.workDir);
    const run = new ContestRun(config);
    run.board = board ?? new Board({ path: blackboardPath, initialWorkers: 20 });
    try {
      run.metricEventCursor = run.board.getMeta("coordinator_cursor", 0);
      const previousBoardLifecycle = run.board.getMeta("runtime_lifecycle");
      const priorIdentity = run.board.getMeta("attempt_identity");
      if (priorIdentity && priorIdentity !== config.arena.identity) {
        throw new Error("This work directory belongs to a different attempt; choose a fresh workDir");
      }
      run.board.setMeta("attempt_identity", config.arena.identity);
      run.board.setMeta("challenge_namespace", config.arena.identity);
      run.arena = arena ?? new ArenaClient(config.arena);
      run.arena.cumulativeScore = run.board.getMeta("cumulative_score");
      run.logFile = await open(join(config.workDir, "events.jsonl"), "a", 0o600);
      let toolSummary;
      try { toolSummary = await readFile("/opt/ctf-tools/worker-tools.md", "utf8"); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        toolSummary = "Development host. Discover only the tool required by the current task; the container manifest is absent.";
      }
      run.pool = await poolFactory({
        root: config.workDir,
        modelConfig: config.model,
        toolSecrets: [config.arena.token],
        getContext: id => run.context(id),
        toolsForRole: (role, id) => run.tools(role, id),
        onEvent: event => run.sessionEvent(event),
        toolSummary,
        streamFunction,
      });
      run.resources = new Resources({
        workDir: config.workDir,
        execution: () => ({ workers: run.board.workers(), sessions: run.pool.status() }),
      });
      let startupResources = null;
      let startupResourceError = null;
      try { startupResources = await run.resources.snapshot(); }
      catch (error) {
        startupResourceError = failure(error);
        run.log({ type: "runtime_health_unavailable", stage: "startup_resource_snapshot", ...startupResourceError });
      }
      const previousLifecycle = previousBoardLifecycle ?? previousHealth;
      const statusSourcesDisagree = previousBoardLifecycle?.status && previousHealth?.status
        && previousBoardLifecycle.status !== previousHealth.status;
      const previous = previousLifecycle ? {
        source: previousBoardLifecycle ? "blackboard" : "runtime-health.json",
        status: previousLifecycle.status ?? "unknown",
        instance_id: previousLifecycle.instance_id ?? null,
        pid: previousLifecycle.pid ?? null,
        started_at: previousLifecycle.started_at ?? null,
        stopped_at: previousLifecycle.stopped_at ?? null,
        stop_reason: previousLifecycle.stop_reason ?? null,
        resources: previousLifecycle.resources ?? null,
        termination: previousLifecycle.termination ?? {
          available: false,
          reason: "container lifecycle metadata is unavailable to the application",
        },
      } : null;
      const runtimeLifecycle = {
        status: "running",
        instance_id: randomUUID(),
        pid: process.pid,
        started_at: new Date().toISOString(),
        attempt_identity: config.arena.identity,
        previous,
        unexpected_previous_shutdown: previousLifecycle?.status === "running",
        status_sources_disagree: Boolean(statusSourcesDisagree),
        previous_status_sources: {
          blackboard: previousBoardLifecycle?.status ?? null,
          runtime_health_file: previousHealth?.status ?? null,
        },
        resources: startupResources ? persistedRuntimeSnapshot(startupResources)
          : { error: startupResourceError },
        termination: {
          available: false,
          reason: "container lifecycle metadata is unavailable to the application",
        },
      };
      run.board.setMeta("runtime_lifecycle", runtimeLifecycle);
      try {
        await persistRuntimeHealth(config.workDir, runtimeLifecycle);
      } catch (error) {
        runtimeLifecycle.health_error = failure(error);
        run.board.setMeta("runtime_lifecycle", runtimeLifecycle);
        run.log({ type: "runtime_health_unavailable", stage: "persist_runtime_health", ...failure(error) });
      }
      run.log({
        type: runtimeLifecycle.unexpected_previous_shutdown ? "runtime_unexpected_restart_detected" : "runtime_started",
        lifecycle: runtimeLifecycle,
      });
      run.board.on("change", () => run.schedule());
      return run;
    } catch (error) {
      try { run.pool?.forceClose?.(); }
      catch {}
      try { await settlesWithin(run.pool?.close?.(), 1000); }
      catch {}
      try { run.resources?.close(); }
      catch {}
      try { await settlesWithin(run.logWrites, 1000); }
      catch {}
      try { await settlesWithin(run.logFile?.close(), 1000); }
      catch {}
      try { run.board.close(); }
      catch {}
      throw error;
    }
  }

  constructor(config) {
    this.config = config;
    this.closed = false;
    this.started = false;
    this.pumping = false;
    this.scheduled = false;
    this.control = Promise.resolve();
    this.logWrites = Promise.resolve();
    this.preparing = new Map();
    this.notices = new Map();
    this.retries = new Map();
    this.continuations = new Map();
    this.stalledReports = new Map();
    this.retryExhausted = new Set();
    this.retryDelayBaseMs = 1000;
    this.retryTimers = new Map();
    this.hardBootstrapReminderTimers = new Map();
    this.settledAgents = new Set();
    this.connectivityProbeOutput = null;
    this.deliveries = new Map();
    this.modelStartedAt = new Map();
    this.toolSignatures = new Map();
    this.assignmentStartedAt = new Map();
    this.assignmentFirstTool = new Map();
    this.assignmentTaskRead = new Set();
    this.assignmentLocalToolSeen = new Set();
    this.hardBootstrapReminderDelayMs = HARD_BOOTSTRAP_REMINDER_MS;
    this.metricEventCursor = 0;
    this.metrics = {
      model_requests: 0,
      model_latency_ms: 0,
      tool_calls: 0,
      tool_failures: 0,
      assignment_first_tool: {},
      task_read_before_local_tool: 0,
      task_read_latency_ms: {},
      notification_payload_bytes: 0,
      fact_write_count: 0,
      intent_write_count: 0,
      claim_conflicts: 0,
      tool_errors: {},
      submission_conflicts: 0,
      notification_replays: 0,
      session_rebuilds: 0,
      unknown_tool_outcomes: 0,
    };
    this.stopController = new AbortController();
    this.connectivityProbeAbortGraceMs = CONNECTIVITY_PROBE_ABORT_GRACE_MS;
    this.stopGraceMs = STOP_GRACE_MS;
    this.finished = new Promise(resolve => { this.resolveFinished = resolve; });
  }

  context(id) {
    if (id === "probe") return { role: "probe" };
    if (id === "lead") return { role: "lead" };
    const context = this.board.context(id);
    const challenge = context?.challenge_id ? this.board.challenge(context.challenge_id) : null;
    return { ...context, phase: challenge?.phase ?? null };
  }

  beginAssignmentMetrics(workerId) {
    this.cancelHardBootstrapRemindersForWorker(workerId);
    this.assignmentStartedAt.set(workerId, Date.now());
    this.assignmentFirstTool.delete(workerId);
    this.assignmentTaskRead.delete(workerId);
    this.assignmentLocalToolSeen.delete(workerId);
    this.metrics.assignment_first_tool[workerId] = null;
    this.metrics.task_read_latency_ms[workerId] = null;
  }

  clearAssignmentMetrics(workerId) {
    this.cancelHardBootstrapRemindersForWorker(workerId);
    this.assignmentStartedAt.delete(workerId);
    this.assignmentFirstTool.delete(workerId);
    this.assignmentTaskRead.delete(workerId);
    this.assignmentLocalToolSeen.delete(workerId);
    this.continuations.delete(workerId);
    this.stalledReports.delete(workerId);
    delete this.metrics.assignment_first_tool[workerId];
    delete this.metrics.task_read_latency_ms[workerId];
  }

  cancelHardBootstrapReminder(assignmentId) {
    const reminder = this.hardBootstrapReminderTimers.get(assignmentId);
    if (reminder) clearTimeout(reminder.timer);
    this.hardBootstrapReminderTimers.delete(assignmentId);
  }

  cancelHardBootstrapRemindersForWorker(workerId) {
    for (const [assignmentId, reminder] of this.hardBootstrapReminderTimers) {
      if (reminder.workerId === workerId) this.cancelHardBootstrapReminder(assignmentId);
    }
  }

  clearHardBootstrapReminders() {
    for (const assignmentId of this.hardBootstrapReminderTimers.keys()) {
      this.cancelHardBootstrapReminder(assignmentId);
    }
  }

  suppressHardBootstrapReminder(challenge, assignmentId, reason, eventId = null) {
    this.cancelHardBootstrapReminder(assignmentId);
    const reminderEventId = eventId ?? hardBootstrapReminderEventId(challenge, assignmentId);
    this.removePendingNotification(reminderEventId);
    this.board.setMeta(hardBootstrapReminderMarkerKey(assignmentId), {
      event_id: reminderEventId,
      status: "suppressed",
      reason,
      challenge_id: challenge.id,
      assignment_id: assignmentId,
      suppressed_at: Date.now(),
    });
  }

  armHardBootstrapReminder(workerId, context, challenge, startedAt) {
    if (this.closed || this.ending || !context?.assignment_id) return;
    if (challenge.difficulty !== "hard" || !["assembling", "solving"].includes(challenge.phase)) return;
    if (this.board.getMeta(hardBootstrapReminderMarkerKey(context.assignment_id))) return;
    if (!this.board.getMeta(hardBootstrapToolMarkerKey(context.assignment_id))) return;
    const current = assignmentContext(this.board.context(workerId));
    if (JSON.stringify(current) !== JSON.stringify(assignmentContext(context))) return;
    const member = challenge.members.find(item => item.assignment_id === context.assignment_id);
    if (!member) return;
    const assignmentStartedAt = Number.isFinite(startedAt) ? startedAt : member.created_at;
    if (!Number.isFinite(assignmentStartedAt)) return;
    const progress = hardBootstrapProgress(challenge, workerId, context.assignment_id, assignmentStartedAt);
    if (progress) {
      this.suppressHardBootstrapReminder(challenge, context.assignment_id, progress);
      return;
    }
    const delayMs = Math.max(0, Number(this.hardBootstrapReminderDelayMs) || 0);
    const dueAt = assignmentStartedAt + delayMs;
    this.cancelHardBootstrapReminder(context.assignment_id);
    const timer = setTimeout(() => {
      this.hardBootstrapReminderTimers.delete(context.assignment_id);
      void this.deliverHardBootstrapReminder(workerId, context, challenge.id, assignmentStartedAt)
        .catch((error) => {
          this.log({
            type: "hard_bootstrap_reminder_failed",
            worker_id: workerId,
            challenge_id: challenge.id,
            assignment_id: context.assignment_id,
            ...failure(error),
          });
          this.scheduleRetry();
        });
    }, Math.max(0, dueAt - Date.now()));
    timer.unref?.();
    this.hardBootstrapReminderTimers.set(context.assignment_id, {
      timer,
      workerId,
      challengeId: challenge.id,
      generation: challenge.generation,
      dueAt,
    });
  }

  rememberHardBootstrapTool(workerId, event) {
    if (!LOCAL_WORKSPACE_TOOLS.has(event.tool) || !event.context?.assignment_id) return;
    try {
      const current = assignmentContext(this.board.context(workerId));
      if (JSON.stringify(current) !== JSON.stringify(assignmentContext(event.context))) return;
      const assignmentId = event.context.assignment_id;
      const challenge = this.board.challenge(event.context.challenge_id);
      const member = challenge.members.find(item => item.assignment_id === assignmentId);
      if (!member) return;
      this.board.setMeta(hardBootstrapToolMarkerKey(assignmentId), {
        tool: event.tool,
        at: Date.now(),
        challenge_id: challenge.id,
        worker_id: workerId,
        assignment_id: assignmentId,
      });
      this.armHardBootstrapReminder(workerId, event.context, challenge, member.created_at);
    } catch (error) {
      this.log({ type: "hard_bootstrap_tool_marker_failed", worker_id: workerId, ...failure(error) });
    }
  }

  reconcileHardBootstrapReminders(challenge) {
    const activeAssignments = new Set(challenge.members.map(member => member.assignment_id));
    for (const [assignmentId, reminder] of this.hardBootstrapReminderTimers) {
      if (reminder.challengeId !== challenge.id) continue;
      if (!activeAssignments.has(assignmentId)
        || challenge.difficulty !== "hard"
        || !["assembling", "solving"].includes(challenge.phase)) {
        this.suppressHardBootstrapReminder(challenge, assignmentId,
          !activeAssignments.has(assignmentId) ? "assignment_released" : "phase_or_difficulty_changed");
      }
    }
    const pending = this.board.getMeta("pending_notifications", {});
    const prefix = hardBootstrapReminderEventPrefix(challenge.id);
    for (const envelope of Object.values(pending)) {
      if (!envelope.eventId?.startsWith(prefix)) continue;
      const separator = envelope.eventId.lastIndexOf(":");
      const assignmentId = separator >= 0 ? envelope.eventId.slice(separator + 1) : null;
      if (!assignmentId) continue;
      const member = challenge.members.find(item => item.assignment_id === assignmentId);
      const progress = member
        ? hardBootstrapProgress(challenge, member.worker_id, assignmentId, member.created_at)
        : null;
      if (!member || challenge.difficulty !== "hard"
        || !["assembling", "solving"].includes(challenge.phase) || progress) {
        this.suppressHardBootstrapReminder(challenge, assignmentId,
          !member ? "assignment_released"
            : challenge.difficulty !== "hard" || !["assembling", "solving"].includes(challenge.phase)
              ? "phase_or_difficulty_changed"
              : progress,
          envelope.eventId);
      }
    }
    if (challenge.difficulty !== "hard" || !["assembling", "solving"].includes(challenge.phase)) return;
    for (const member of challenge.members) {
      const context = this.board.context(member.worker_id);
      if (context.assignment_id === member.assignment_id) {
        this.armHardBootstrapReminder(member.worker_id, context, challenge, member.created_at);
      }
    }
  }

  restoreHardBootstrapReminders() {
    for (const challenge of this.challenges()) this.reconcileHardBootstrapReminders(challenge);
  }

  async deliverHardBootstrapReminder(workerId, context, challengeId, startedAt) {
    if (this.closed || this.ending) return;
    const assignmentId = context.assignment_id;
    if (!assignmentId || this.board.getMeta(hardBootstrapReminderMarkerKey(assignmentId))) return;
    const current = assignmentContext(this.board.context(workerId));
    if (JSON.stringify(current) !== JSON.stringify(assignmentContext(context))) return;
    const challenge = this.board.challenge(challengeId);
    if (challenge.difficulty !== "hard" || !["assembling", "solving"].includes(challenge.phase)) return;
    if (!challenge.members.some(member => member.assignment_id === assignmentId
      && member.worker_id === workerId)) return;
    if (Date.now() < startedAt + Math.max(0, Number(this.hardBootstrapReminderDelayMs) || 0)) {
      this.armHardBootstrapReminder(workerId, context, challenge, startedAt);
      return;
    }
    if (!this.board.getMeta(hardBootstrapToolMarkerKey(assignmentId))) return;
    const progress = hardBootstrapProgress(challenge, workerId, assignmentId, startedAt);
    if (progress) {
      this.suppressHardBootstrapReminder(challenge, assignmentId, progress);
      return;
    }
    const eventId = hardBootstrapReminderEventId(challenge, assignmentId);
    const envelope = this.queueNotification(workerId,
      "困难题已持续解题约 5 分钟，黑板尚无可复用的 Fact、Intent 或候选。"
        + "不要重复整题读取或机械重试。若已有真实观察，优先用 record_fact 记录文件路径、入口、"
        + "服务响应、常量、明确失败结论或最小 blocker；有证据时用 next_intents 发布 1–3 个方向。"
        + JSON.stringify({
          challenge_id: challenge.id,
          assignment_id: assignmentId,
          revision: challenge.revision,
          fact_count: challenge.facts.length,
          intent_count: challenge.intents.length,
          candidate_count: challenge.candidates.length,
          event_cursor: this.board.getMeta("event_cursor", 0),
        }),
      {
        eventId,
        assignmentId,
        challengeId: challenge.id,
        scope: `hard-bootstrap:${assignmentId}`,
        version: challenge.revision,
        triggerTurn: true,
        deliverAs: "nextTurn",
      });
    if (!envelope) return;
    this.board.setMeta(hardBootstrapReminderMarkerKey(assignmentId), {
      event_id: eventId,
      status: "queued",
      challenge_id: challenge.id,
      worker_id: workerId,
      assignment_id: assignmentId,
      queued_at: Date.now(),
    });
    this.log({
      type: "hard_bootstrap_reminder_queued",
      worker_id: workerId,
      challenge_id: challenge.id,
      assignment_id: assignmentId,
      event_id: eventId,
    });
    await this.flushNotifications();
  }

  log(event) {
    if (event.type === "model_delta") return;
    const clean = JSON.stringify({ time: new Date().toISOString(), ...event })
      .split(this.config.arena.token).join("[redacted]")
      .split(this.config.model.apiKey).join("[redacted]");
    this.logWrites = this.logWrites.catch(() => {})
      .then(() => this.logFile.appendFile(clean + "\n"))
      .catch(error => { this.logError = error; });
  }

  start() {
    this.starting ??= this.initialize();
    return this.starting;
  }

  async initialize() {
    const finishAttempt = this.board.getMeta("finish_attempt");
    if (["pending", "unknown"].includes(finishAttempt?.status)) {
      await this.reconcileFinish(finishAttempt);
      return this;
    }
    const finished = this.board.getMeta("finished");
    if (finished) { this.resolveFinished(finished); return this; }
    if (this.config.arena.expiresAt && this.config.arena.expiresAt <= Date.now()) {
      this.resolveFinished({ reason: "attempt_deadline" });
      return this;
    }
    if (this.config.arena.mode === "connectivity_test") return this.initializeConnectivityProbe();
    await this.pool.ensure("lead", "lead");
    await this.prepareWorkers();
    await this.retryRead(() => this.refreshCatalog());
    const recovery = await this.recoverCatalogWork();
    await this.retryRead(() => this.reconcileEnvironments());
    await this.retryRead(() => this.reconcilePendingSubmissions());
    this.restoreHardBootstrapReminders();
    if (this.ending) return this;
    try { await this.flushNotifications(); }
    catch (error) { this.log({ type: "notification_recovery_deferred", ...failure(error) }); }
    this.started = true;
    const lifecycle = this.board.getMeta("runtime_lifecycle", {});
    const runtimeRecovery = lifecycle?.unexpected_previous_shutdown ? {
      unexpected_previous_shutdown: true,
      status_sources_disagree: lifecycle.status_sources_disagree === true,
      previous: {
        status: lifecycle.previous?.status ?? null,
        started_at: lifecycle.previous?.started_at ?? null,
        stopped_at: lifecycle.previous?.stopped_at ?? null,
        stop_reason: lifecycle.previous?.stop_reason ?? null,
      },
      resources: lifecycle.resources ?? null,
    } : null;
    this.queueNotification("lead", "比赛开始或进程恢复。先读取当前题目目录及本地黑板。"
      + "离线题优先是 Lead 的策略：根据 container=false、priority、附件准备收益和当前资源自行决定是否调用 arena_prepare_offline。"
      + "在线实例的实际配额由赛事 API 判定；平台不本地预判 3 个上限，收到 environment_limit 或 quota 错误时原样展示给你调整。"
      + "困难题先只分配一个主 Worker 并进入 assembling；收到平台的需要援助通知后，查看资源再 grow_workers。"
      + "新未领取题始终优先，只有没有新题时才把空闲 Worker 加入援助。"
      + "初始 20 个 Worker，按实际资源决定后续增员。优先提高得分和有效解题吞吐。"
      + (runtimeRecovery
        ? "检测到上次运行异常结束。旧工具结果可能为 unknown，先依据 recovery.sessions 核实，再决定重跑或增援。"
        : "")
      + JSON.stringify({ mode: this.config.arena.mode, rules: this.config.arena.helpMarkdown,
        catalog: this.catalog.map(compactCatalogItem), recovery,
        runtime_recovery: runtimeRecovery,
        board: this.leadDashboard(), ...this.competitionClock() }),
    { eventId: `startup:${randomUUID()}` });
    for (const worker of this.board.workers()) {
      if (!worker.assignment_id) continue;
      const context = this.board.context(worker.id);
      const challenge = this.board.challenge(context.challenge_id);
      const member = challenge.members.find(item => item.worker_id === worker.id);
      const status = this.pool.status().find(item => item.id === worker.id);
      if (worker.active && status?.idle) {
        this.board.execute("platform", "activity", { worker_id: worker.id, context: worker.execution_context, running: false });
      }
      if (["assembling", "solving"].includes(challenge.phase)) {
        const eventCursor = this.board.getMeta("event_cursor", 0);
        const taskState = assignmentTaskState(challenge, { id: null }, member?.role ?? "worker", eventCursor, {
          forceTaskRead: (status?.unresolved?.length ?? 0) > 0
            || (status?.recovered_processes?.length ?? 0) > 0,
        });
        const directory = await this.challengeDirectory(challenge.id);
        this.queueNotification(worker.id,
          "进程恢复。保留原题和会话，先核实未决命令，再按 task_state 决定是否读取完整题。"
          + JSON.stringify({
            context,
            challenge: challengeSummary(challenge),
            task_state: taskState,
            session: {
              unresolved: status?.unresolved ?? [],
              recovered_processes: status?.recovered_processes ?? [],
              error: status?.error ?? null,
            },
            paths: {
              worker_cwd: join(this.config.workDir, "work", worker.id),
              challenge_root: directory,
              inputs: join(directory, "inputs"),
            },
            event_cursor: eventCursor,
          }),
          { eventId: `resume:${randomUUID()}`, scope: challenge.id, version: challenge.revision });
      }
    }
    try { await this.flushNotifications(); }
    catch (error) { this.log({ type: "startup_notification_deferred", ...failure(error) }); }
    if (this.config.arena.expiresAt) {
      const remaining = this.config.arena.expiresAt - Date.now();
      this.deadlineTimer = setTimeout(() => { void this.stop("attempt_deadline"); }, Math.max(0, remaining));
    }
    this.board.setMeta("recovery_armed", true);
    this.restoreHardBootstrapReminders();
    this.schedule();
    return this;
  }

  async initializeConnectivityProbe() {
    const startedAt = Date.now();
    const externalDeadline = Number.isFinite(this.config.arena.expiresAt)
      ? this.config.arena.expiresAt - CONNECTIVITY_PROBE_EXIT_MARGIN_MS
      : Number.POSITIVE_INFINITY;
    const deadline = Math.min(
      startedAt + CONNECTIVITY_PROBE_TIMEOUT_MS,
      externalDeadline,
    );
    const probeController = new AbortController();
    let timer;
    let timedOut = false;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(connectivityProbeError(
          `Connectivity probe timed out after ${Math.max(0, deadline - startedAt)}ms`,
        ));
      }, Math.max(0, deadline - startedAt));
    });
    const operation = this.runConnectivityProbe(deadline, probeController.signal);
    try {
      await Promise.race([operation, timeout]);
    } catch (error) {
      if (timedOut) {
        probeController.abort();
        this.log({
          type: "connectivity_probe_timed_out",
          deadline,
          elapsed_ms: Date.now() - startedAt,
        });
        try {
          await this.pool.abort("probe");
        } catch (abortError) {
          this.log({ type: "connectivity_probe_abort_failed", ...failure(abortError) });
        }
        throw error;
      }
      if (error.code === "connectivity_probe_error") throw error;
      this.log({ type: "connectivity_probe_failed", ...failure(error) });
      throw connectivityProbeError(`Connectivity probe failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async runConnectivityProbe(deadline, probeSignal) {
    await this.pool.ensure("probe", "probe");
    if (probeSignal.aborted) throw connectivityProbeError("Connectivity probe was cancelled before catalog read");
    const catalog = await this.retryRead(() => this.refreshCatalog());
    if (probeSignal.aborted) throw connectivityProbeError("Connectivity probe was cancelled before model execution");
    const { challenge, flag } = connectivityProbe(catalog);
    this.log({
      type: "connectivity_probe_started",
      unique_code: challenge.unique_code,
      description_chars: challenge.description.length,
    });
    let outputObserved = false;
    const firstOutput = new Promise(resolve => {
      this.connectivityProbeOutput = () => {
        outputObserved = true;
        this.log({ type: "connectivity_probe_output_observed", unique_code: challenge.unique_code });
        resolve();
      };
    });
    try {
      if (probeSignal.aborted) throw connectivityProbeError("Connectivity probe was cancelled before model execution");
      const modelTurn = this.pool.prompt(
        "probe",
        "赛事连通性自检。题面如下。请只在一个简短回合中回复其中明确给出的 flag。\n\n"
          + challenge.description,
      );
      await Promise.race([modelTurn, firstOutput]);
      this.connectivityProbeOutput = null;
      const aborted = await settlesWithin(this.pool.abort("probe"), this.connectivityProbeAbortGraceMs);
      if (!aborted) {
        this.log({ type: "connectivity_probe_abort_timed_out",
          grace_ms: this.connectivityProbeAbortGraceMs });
        this.pool.forceClose?.();
      }
    } catch (error) {
      this.connectivityProbeOutput = null;
      this.log({ type: "connectivity_probe_model_failed", ...failure(error) });
      throw connectivityProbeError(`Connectivity probe model request failed: ${error.message}`);
    }
    const status = this.pool.status().find(item => item.id === "probe");
    if (!outputObserved && status?.error) {
      this.log({ type: "connectivity_probe_model_failed", message: status.error });
      throw connectivityProbeError(`Connectivity probe model request failed: ${status.error}`);
    }
    if (!outputObserved) throw connectivityProbeError("Connectivity probe model returned no observable output");
    if (this.ending) return this;
    if (Date.now() >= deadline) {
      throw connectivityProbeError("Connectivity probe reached its deadline before submission");
    }
    if (probeSignal.aborted) throw connectivityProbeError("Connectivity probe was cancelled before submission");
    this.log({ type: "connectivity_probe_model_completed", unique_code: challenge.unique_code });
    const result = await this.arena.submit(challenge.unique_code, flag, {
      signal: AbortSignal.any([this.stopController.signal, probeSignal]),
    });
    this.log({
      type: "connectivity_probe_submitted",
      unique_code: challenge.unique_code,
      outcome: result.outcome,
      error: result.error ?? null,
    });
    if (!["accepted", "rejected"].includes(result.outcome)) {
      throw connectivityProbeError(`Connectivity probe submission returned ${result.outcome}`);
    }
    this.endLocal("connectivity_verdict", result, result.outcome === "accepted");
    return this;
  }

  async prepareWorkers() {
    const workers = this.board.workers().filter(worker => worker.status !== "failed");
    const failures = [];
    const results = await Promise.allSettled(workers.map(worker => {
      if (this.preparing.has(worker.id)) return this.preparing.get(worker.id);
      const preparation = this.pool.ensure(worker.id, "worker").then(() => {
        if (worker.status === "starting") this.board.execute("platform", "worker_ready", { worker_id: worker.id });
      }).catch(error => {
        const current = this.board.workers().find(item => item.id === worker.id) ?? worker;
        if (current.status !== "failed") {
          this.board.execute("platform", "worker_failed", { worker_id: worker.id, error: error.message });
        }
        this.log({ type: "worker_preparation_failed", worker_id: worker.id, ...failure(error) });
        failures.push({ worker_id: worker.id, error: error.message });
      }).finally(() => this.preparing.delete(worker.id));
      this.preparing.set(worker.id, preparation);
      return preparation;
    }));
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push({ worker_id: "unknown", error: result.reason?.message ?? String(result.reason) });
      }
    }
    if (failures.length) {
      this.queueNotification("lead", "部分 Worker 会话准备失败，平台已隔离故障 Worker。健康 Worker 继续运行。"
        + JSON.stringify({ failures }), { eventId: `worker-preparation-failed:${randomUUID()}` });
      try { await this.flushNotifications(); }
      catch (error) { this.log({ type: "worker_failure_notice_deferred", ...failure(error) }); }
    }
    return failures;
  }

  async retryRead(operation) {
    for (let attempt = 0; ; attempt++) {
      this.stopController.signal.throwIfAborted();
      try { return await operation(); }
      catch (error) {
        if (!error.transient || this.closed) throw error;
        if (this.config.arena.expiresAt && Date.now() >= this.config.arena.expiresAt) throw error;
        this.log({ type: "arena_read_retry", attempt: attempt + 1, ...failure(error) });
        await delay(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)), undefined, { signal: this.stopController.signal });
      }
    }
  }

  async refreshCatalog() {
    const raw = await this.arena.listChallenges({ signal: this.stopController.signal });
    this.catalog = raw.map((item) => ({
      ...item,
      requires_online_environment: catalogRequiresEnvironment(item),
      materials: catalogMaterials(item),
    }));
    this.board.setMeta("catalog", this.catalog);
    const byCode = new Map(this.catalog.map(item => [item.unique_code, item]));
    for (const challenge of this.challenges()) {
      const item = byCode.get(challenge.unique_code);
      if (!item) continue;
      this.board.execute("platform", "apply_catalog_metadata", {
        challenge_id: challenge.id,
        ...(typeof item.description === "string" && item.description.trim()
          && item.description !== challenge.description ? { description: item.description } : {}),
        requires_online_environment: catalogRequiresEnvironment(item),
        ...(Number.isFinite(item.points) ? { points: item.points } : {}),
        ...(Number.isFinite(item.total_score) ? { total_score: item.total_score } : {}),
        ...(Number.isSafeInteger(item.flag_count) ? { flag_count: item.flag_count } : {}),
        ...(Number.isSafeInteger(item.correct_flag_count) ? { correct_flag_count: item.correct_flag_count } : {}),
      });
    }
    return this.catalog;
  }

  leadDashboard() {
    const snapshot = this.board.snapshot("lead");
    return {
      ...this.competitionClock(),
      challenges: snapshot.challenges.map((challenge) => challengeSummary(challenge)),
      available: snapshot.available,
      workers: snapshot.workers.map((worker) => ({
        id: worker.id,
        status: worker.status,
        assignment_id: worker.assignment_id,
        active: worker.active,
        has_worked: worker.has_worked,
        error: worker.error,
      })),
      event_cursor: snapshot.event_cursor,
    };
  }

  competitionClock(now = Date.now()) {
    const expiresAt = this.config.arena.expiresAt;
    return {
      now: new Date(now).toISOString(),
      expires_at: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
      remaining_seconds: Number.isFinite(expiresAt)
        ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : null,
    };
  }

  async recoverCatalogWork() {
    const report = {
      recovered: [],
      completed: [],
      pending: [],
      environment_unknown: [],
      sessions: [],
    };
    if (this.board.getMeta("recovery_armed", false)) {
      for (const item of this.catalog) {
        let challenge = this.challenges().find(value => value.unique_code === item.unique_code);
        if (challengeCompleted(item)) {
          if (challenge && challenge.phase !== "completed") {
            this.board.execute("platform", "reconcile_completed", { challenge_id: challenge.id });
          }
          report.completed.push(item.unique_code);
          continue;
        }
        if (!challenge) {
          try {
            challenge = this.board.execute("lead", "create_challenge", {
              request_id: `catalog-recovery:${item.unique_code}`,
              unique_code: item.unique_code,
              title: item.name ?? item.title ?? item.unique_code,
              description: item.description ?? "",
              difficulty: this.catalogDifficulty(item),
              multi_stage: item.multi_stage === true,
              priority: 1,
              ready: false,
              requires_online_environment: catalogRequiresEnvironment(item),
            });
            this.board.setMeta(activationMarkerKey(challenge), false);
            report.recovered.push(item.unique_code);
          } catch (error) {
            report.pending.push({ unique_code: item.unique_code, error: failure(error) });
            continue;
          }
        } else if (!report.recovered.includes(item.unique_code)) {
          report.recovered.push(item.unique_code);
        }
        if (["pending", "assembling", "solving", "reviewing"].includes(challenge.phase)) {
          report.pending.push({ unique_code: item.unique_code, challenge_id: challenge.id,
            phase: challenge.phase, environment: challenge.environment.status });
        }
        if (challenge.environment.status === "unknown") {
          report.environment_unknown.push(item.unique_code);
        }
      }
      report.sessions = this.pool.status().map((session) => ({
        id: session.id,
        idle: session.idle,
        unresolved: session.unresolved,
        recovered_processes: session.recovered_processes,
      }));
      this.metrics.session_rebuilds += report.sessions.filter((session) =>
        (session.unresolved?.length ?? 0) > 0 || (session.recovered_processes?.length ?? 0) > 0).length;
      this.metrics.unknown_tool_outcomes += report.sessions
        .reduce((total, session) => total + (session.unresolved?.length ?? 0), 0);
    }
    this.board.setMeta("recovery_report", report);
    return report;
  }

  async reconcilePendingSubmissions() {
    const reconciled = [];
    for (const challenge of this.challenges()) {
      for (const submission of challenge.submissions ?? []) {
        if (!["pending", "unknown"].includes(submission.status)) continue;
        const legacyAcceptedFlags = new Set((challenge.submissions ?? [])
          .filter(item => item.status === "accepted").map(item => item.flag));
        const baselineCorrectFlagCount = Number.isSafeInteger(submission.baseline_correct_flag_count)
          ? submission.baseline_correct_flag_count
          : legacyAcceptedFlags.size;
        const result = await this.arena.reconcileSubmission(challenge.unique_code, {
          baselineCorrectFlagCount,
          signal: this.stopController.signal,
        });
        if (result.outcome === "accepted") {
          if (Number.isSafeInteger(result.challenge?.correct_flag_count)) {
            this.board.execute("platform", "apply_catalog_metadata", {
              challenge_id: challenge.id,
              correct_flag_count: result.challenge.correct_flag_count,
            });
          }
          this.applySubmission(submission.id, result);
          this.metrics.submission_conflicts += 1;
          if (this.config.arena.mode === "connectivity_test") this.endLocal("connectivity_verdict", result, true);
        }
        reconciled.push({ submission_id: submission.id, ...result });
      }
    }
    return reconciled;
  }

  challenges() { return this.board.snapshot("lead").challenges; }

  sessionEvent(event) {
    this.log(event);
    const id = event.agentId;
    if (event.type === "model_start") {
      this.metrics.model_requests += 1;
      this.modelStartedAt.set(id, Date.now());
    }
    if (event.type === "model_end") {
      const started = this.modelStartedAt.get(id);
      if (started) this.metrics.model_latency_ms += Math.max(0, Date.now() - started);
      this.modelStartedAt.delete(id);
    }
    if (event.type === "tool_start") {
      this.metrics.tool_calls += 1;
      if (event.context?.assignment_id) {
        if (!this.assignmentFirstTool.has(id)) {
          this.assignmentFirstTool.set(id, event.tool);
          this.metrics.assignment_first_tool[id] = event.tool;
        }
        if (event.tool === "board_read" && !this.assignmentTaskRead.has(id)) {
          this.assignmentTaskRead.add(id);
          const started = this.assignmentStartedAt.get(id);
          if (started) this.metrics.task_read_latency_ms[id] = Math.max(0, Date.now() - started);
          if (!this.assignmentLocalToolSeen.has(id)) this.metrics.task_read_before_local_tool += 1;
        }
        if (LOCAL_WORKSPACE_TOOLS.has(event.tool)) this.assignmentLocalToolSeen.add(id);
      }
    }
    if (event.type === "tool_end") {
      if (event.isError) this.metrics.tool_failures += 1;
      if (!event.isError && ["bash", "read", "write", "edit"].includes(event.tool)
        && event.context?.assignment_id
        && JSON.stringify(assignmentContext(event.context))
          === JSON.stringify(assignmentContext(this.board.context(id)))) {
        // A peer's Fact or an empty board_read is not a new local execution segment.
        this.continuations.delete(id);
        this.stalledReports.delete(id);
      }
      this.rememberHardBootstrapTool(id, event);
      const signature = typeof event.args_digest === "string"
        ? JSON.stringify([event.tool, event.context?.assignment_id ?? null,
          event.context?.environment_generation ?? null, event.args_digest]) : null;
      const previous = this.toolSignatures.get(id);
      const repeated = signature !== null && previous?.signature === signature;
      const count = repeated ? previous.count + 1 : 1;
      const allFailed = Boolean(event.isError) && (!repeated || previous.allFailed);
      this.toolSignatures.set(id, { signature, count, allFailed });
      if (count === 3 && event.context?.challenge_id) {
        try {
          this.board.execute("platform", "progress_stalled", {
            challenge_id: event.context.challenge_id,
            worker_id: id,
            reason: allFailed
              ? "The same tool invocation failed repeatedly"
              : "The same tool invocation repeated; inspect its results before deciding whether to continue",
            signature,
            attempts: count,
          });
        } catch (error) {
          this.log({ type: "progress_stalled_rejected", worker_id: id, ...failure(error) });
        }
      }
    }
    if (event.type === "notification_consumed") {
      this.removePendingNotification(event.eventId);
      this.schedule();
      return;
    }
    if (event.type === "notification_delivery_failed") {
      this.scheduleRetry();
    }
    const probeDeltaProduced = event.type === "model_delta"
      && typeof event.text === "string" && event.text.length > 0;
    if (id === "probe" && probeDeltaProduced) {
      const observed = this.connectivityProbeOutput;
      this.connectivityProbeOutput = null;
      observed?.();
    }
    if (event.type === "idle" && !event.aborted) {
      this.retries.delete(id);
      this.retryExhausted.delete(id);
    }
    if (!["lead", "probe"].includes(id) && (event.type === "model_start" || event.settled)) {
      try {
        const worker = this.board.workers().find(item => item.id === id);
        const context = assignmentContext(event.context ?? this.board.context(id));
        if (worker.active && (event.settled || JSON.stringify(worker.execution_context) !== JSON.stringify(context))) {
          this.board.execute("platform", "activity", { worker_id: id, context: worker.execution_context, running: false });
        }
        if (event.type === "model_start") this.board.execute("platform", "activity", { worker_id: id, context, running: true });
      } catch (error) { this.log({ type: "activity_rejected", worker_id: id, ...failure(error) }); }
    }
    if (event.type === "error" && id !== "probe") {
      this.retrySession(id, typeof event.error === "string" ? event.error : event.error?.message ?? event.message ?? "Session failed");
    }
    if (event.type === "idle" || event.settled) {
      if (!event.aborted && event.type === "idle" && id !== "probe") this.settledAgents.add(id);
      this.schedule();
    }
  }

  retrySession(id, message) {
    if (this.closed || this.ending || this.retryExhausted.has(id)) return;
    if (sessionErrorDisposition(message) === "degraded") {
      this.retryExhausted.add(id);
      clearTimeout(this.retryTimers.get(id));
      this.retryTimers.delete(id);
      this.log({ type: "session_error_nonretryable", agent_id: id, message });
      if (id !== "lead") {
        try {
          this.board.execute("platform", "worker_degraded", { worker_id: id, error: message });
          this.clearAssignmentMetrics(id);
        } catch (error) {
          this.log({ type: "provider_worker_release_failed", worker_id: id, ...failure(error) });
        }
        this.queueNotification("lead", "会话返回不可自愈错误。平台已隔离该 Worker 并释放其工作归属，"
          + "请根据真实错误决定增援、切题或结束。"
          + JSON.stringify({ worker_id: id, error: message }), {
          eventId: `provider-degraded:${id}:${randomUUID()}`,
          scope: "global",
          version: 0,
        });
      } else {
        this.board.setMeta("provider_degraded", { agent_id: id, error: message, at: Date.now() });
      }
      this.schedule();
      return;
    }
    if (this.retryTimers.has(id)) return;
    const attempt = (this.retries.get(id) ?? 0) + 1;
    this.retries.set(id, attempt);
    this.log({ type: "session_retry", agent_id: id, attempt, message });
    if (attempt > MAX_SESSION_ERROR_RETRIES) {
      if (!this.retryExhausted.has(id)) {
        this.retryExhausted.add(id);
        const context = id === "lead" ? null : this.board.context(id);
        if (id !== "lead" && context?.assignment_id) {
          const challenge = this.board.challenge(context.challenge_id);
          this.queueNotification("lead", "Worker 的模型请求在有限重试后仍持续失败。读取该题黑板决定增加援助、调整方向或暂缓。"
            + JSON.stringify({
              worker_id: id,
              error: message,
              attempts: attempt,
              challenge: challengeSummary(challenge),
            }), { eventId: `retry-exhausted:${id}:${challenge.id}:${challenge.revision}`,
            scope: challenge.id, version: challenge.revision });
        }
      }
      this.schedule();
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      if (this.closed || this.ending) return;
      if (id !== "lead") {
        const context = this.board.context(id);
        const challenge = context.assignment_id ? this.board.challenge(context.challenge_id) : null;
        if (!challenge || !["assembling", "solving"].includes(challenge.phase) || !challenge.ready) {
          this.schedule();
          return;
        }
      }
      void this.notify(id, "上次模型回合失败。读取当前状态，核实已有结果并继续。", { eventId: `retry:${id}:${randomUUID()}` }).catch(() => {});
    }, Math.min(30000, this.retryDelayBaseMs * 2 ** Math.min(attempt - 1, 5)));
    this.retryTimers.set(id, timer);
  }

  queueNotification(id, message, options = {}) {
    if (this.closed || this.ending) return;
    const context = id === "lead" ? null : this.board.context(id);
    const envelope = { id, text: message, eventId: randomUUID(), version: 0, scope: "global",
      ...(context ? { assignmentId: context.assignment_id, challengeId: context.challenge_id } : {}), ...options };
    const pending = this.board.getMeta("pending_notifications", {});
    if (!pending[envelope.eventId]) {
      pending[envelope.eventId] = envelope;
      this.board.setMeta("pending_notifications", pending);
      this.metrics.notification_payload_bytes += Buffer.byteLength(message, "utf8");
    }
    return pending[envelope.eventId];
  }

  removePendingNotification(eventId) {
    const pending = this.board.getMeta("pending_notifications", {});
    if (!Object.hasOwn(pending, eventId)) return;
    delete pending[eventId];
    this.board.setMeta("pending_notifications", pending);
  }

  async deliverNotification(envelope) {
    if (!envelope || this.closed || this.ending) return;
    if (this.deliveries.has(envelope.eventId)) return this.deliveries.get(envelope.eventId);
    const delivery = (async () => {
      const { id, text: message, pause = false, ...options } = envelope;
      const stale = id !== "lead" && options.assignmentId !== this.board.context(id)?.assignment_id;
      const result = stale ? { delivered: false, stale: true }
        : pause && this.pool.pause
          ? await this.pool.pause(id, message, options)
          : await this.pool.notify(id, message, options);
      if (result.duplicate) this.metrics.notification_replays += 1;
      if (result.stale || result.consumed) this.removePendingNotification(envelope.eventId);
      return result;
    })();
    this.deliveries.set(envelope.eventId, delivery);
    try { return await delivery; }
    catch (error) {
      this.log({ type: "notification_failed", agent_id: envelope.id, event_id: envelope.eventId, ...failure(error) });
      this.scheduleRetry();
      throw error;
    } finally { this.deliveries.delete(envelope.eventId); }
  }

  async notify(id, message, options = {}) {
    return this.deliverNotification(this.queueNotification(id, message, options));
  }

  async flushNotifications() {
    const envelopes = Object.values(this.board.getMeta("pending_notifications", {}));
    const results = await Promise.allSettled(envelopes.map(envelope => this.deliverNotification(envelope)));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  scheduleRetry() {
    if (this.closed || this.ending || this.pumpRetry) return;
    this.pumpRetry = setTimeout(() => {
      this.pumpRetry = null;
      this.schedule();
    }, 1000);
  }

  schedule() {
    if (!this.started || this.closed || this.ending || this.scheduled || this.pumpRetry) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.pump().catch(error => {
        this.log({ type: "coordinator_error", ...failure(error) });
        this.scheduleRetry();
      });
    });
  }

  async pump() {
    if (this.pumping) return this.pumpDone;
    if (this.closed || this.ending) return;
    this.pumping = true;
    let succeeded = false;
    this.pumpDone = new Promise(resolve => { this.resolvePump = resolve; });
    try {
      const events = this.board.events(this.board.getMeta("coordinator_cursor", 0));
      const changed = new Map();
      const hardBootstrapChallenges = new Set();
      const notifiedAssignments = new Set();
      const hardAssistanceNeeds = new Set();
      for (const event of events) {
        if (event.id > this.metricEventCursor) {
          if (event.type === "fact.posted") this.metrics.fact_write_count += 1;
          if (event.type === "intent.posted") this.metrics.intent_write_count += 1;
          this.metricEventCursor = event.id;
        }
        if (["fact.posted", "intent.posted", "intent.claimed", "intent.released"].includes(event.type)
          && event.actor_id) this.toolSignatures.delete(event.actor_id);
        if (!event.challenge_id) continue;
        if (["fact.posted", "intent.posted", "review.requested", "challenge.updated",
          "challenge.deferred", "challenge.completed", "worker.released", "worker.failed",
          "worker.degraded", "environment.updated"].includes(event.type)) {
          hardBootstrapChallenges.add(event.challenge_id);
        }
        if (event.type === "worker.assigned") {
          const directory = await this.challengeDirectory(event.challenge_id);
          const challenge = this.board.challenge(event.challenge_id);
          if (!["assembling", "solving"].includes(challenge.phase)) continue;
          if (challenge.difficulty === "hard"
            && event.assigned_worker_id === challenge.owner_id
            && event.team_ready === false) {
            hardAssistanceNeeds.add(challenge.id);
          }
          const markerKey = assistanceGapMarkerKey(challenge);
          const currentGap = assistanceGapState(challenge);
          const previousGap = this.board.getMeta(markerKey);
          if (previousGap && currentGap.open_assistance_slots < previousGap.open_assistance_slots) {
            this.board.setMeta(markerKey, currentGap);
          }
          const workerIds = event.team_ready ? challenge.members.map(member => member.worker_id)
            : [event.assigned_worker_id];
          const eventCursor = this.board.getMeta("event_cursor", event.id);
          for (const workerId of workerIds) {
            const context = this.board.context(workerId);
            if (!context?.assignment_id || context.challenge_id !== event.challenge_id) continue;
            if (notifiedAssignments.has(context.assignment_id)) continue;
            notifiedAssignments.add(context.assignment_id);
            const member = challenge.members.find((item) => item.worker_id === workerId);
            this.beginAssignmentMetrics(workerId);
            this.armHardBootstrapReminder(workerId, context, challenge, member?.created_at);
            const taskState = assignmentTaskState(challenge, event, member?.role ?? "worker",
              eventCursor);
            this.queueNotification(workerId, "工作归属已确定。先读取内嵌 task_state；needs_task_read=false 时直接看题面和 inputs，"
              + "仅在 needs_task_read=true、恢复或状态冲突时读取完整题。不要重复领取。"
              + JSON.stringify({
                context,
                challenge: challengeSummary(challenge),
                task_state: taskState,
                paths: {
                  worker_cwd: join(this.config.workDir, "work", workerId),
                  challenge_root: directory,
                  inputs: join(directory, "inputs"),
                },
              }),
            { eventId: `assignment:${context.assignment_id}`, scope: event.challenge_id,
              version: challenge.revision });
          }
          continue;
        }
        const group = changed.get(event.challenge_id) ?? [];
        group.push(event);
        changed.set(event.challenge_id, group);
      }
      for (const challengeId of hardBootstrapChallenges) {
        try { this.reconcileHardBootstrapReminders(this.board.challenge(challengeId)); }
        catch (error) { this.log({ type: "hard_bootstrap_reconcile_failed", challenge_id: challengeId, ...failure(error) }); }
      }
      const leadUpdates = [];
      const disputeIndexes = new Map();
      for (const [challengeId, changes] of changed) {
        const event = changes.at(-1);
        const challenge = this.board.challenge(challengeId);
        const reviewActors = new Set(changes
          .filter(item => item.type === "review.requested")
          .map(item => item.actor_id));
        const environmentReleased = challenge.environment.status === "closed"
          && (challenge.phase === "completed"
            || changes.some(item => item.type === "environment.updated"));
        const compactEvents = changes.map(item => ({
          type: item.type,
          event_id: item.id,
          revision: item.revision,
          claim_revision: item.claim_revision ?? null,
          at: item.at,
        }));
        const entityChanges = new Map();
        for (const item of changes) {
          const change = this.board._eventChange(item, { disputeIndexes });
          entityChanges.set(`${change.entity}:${change.id}`, change);
        }
        const leadUpdate = {
          challenge: challengeSummary(challenge),
          events: compactEvents,
          changes: [...entityChanges.values()],
          sections: [],
        };
        if (challenge.phase === "reviewing"
          && changes.some(item => ["review.requested", "submission.unknown"].includes(item.type))) {
          leadUpdate.sections.push({
            type: "review_required",
            candidates: challenge.candidates.map(candidateSummary),
            instruction: "核验候选并处理尚无确定结果的提交。",
          });
        }
        if (changes.some(item => item.type === "deferral.requested")) {
          leadUpdate.sections.push({
            type: "deferral_requested",
            instruction: "读取阻塞 Fact 后决定继续、增加援助或暂缓。",
          });
        }
        const releaseKey = `online_slot_release_notice:${challenge.id}:${challenge.generation}`;
        if (environmentReleased && challenge.environment.online === true
          && !this.board.getMeta(releaseKey)
          && !this.board.getMeta(`external_environment_closed:${challenge.id}:${challenge.generation}`)) {
          this.board.setMeta(releaseKey, event.id);
          leadUpdate.sections.push({
            type: "online_environment_released",
            instruction: "立即检查未启动的在线题，用空出的名额启动下一道。",
          });
        }
        if (changes.some(item => ["submission.accepted", "assistance.reminder"].includes(item.type))) {
          leadUpdate.sections.push({
            type: "progress",
            instruction: "根据最新提交回执或援助提醒继续调度。",
          });
        }
        if (leadUpdate.sections.length) leadUpdates.push(leadUpdate);
        const instruction = challenge.phase === "reviewing"
          ? "已有候选待核验，结束本轮并等待 Lead 反馈。"
          : challenge.phase === "completed"
            ? "本题已通过，请结束本轮，等待后续工作通知。"
            : "题目已更新，按需读取新增事实和意图。";
        const message = JSON.stringify({
          challenge: challengeSummary(challenge),
          events: compactEvents,
          changes: [...entityChanges.values()],
          instruction,
        });
        for (const member of challenge.members) {
          if (challenge.phase === "deferred" || challenge.phase === "completed" && !member.active) continue;
          if (["assembling", "solving"].includes(challenge.phase)
            && changes.every(item => item.actor_id === member.worker_id)) continue;
          const reviewing = challenge.phase === "reviewing";
          this.queueNotification(member.worker_id, message,
            { eventId: `board:${event.id}:${member.worker_id}`, version: challenge.revision, scope: challengeId,
              ...(challenge.phase === "completed" ? { pause: true } : reviewing
                ? reviewActors.has(member.worker_id) ? { triggerTurn: false } : { pause: true }
                : {}) });
        }
      }
      if (leadUpdates.length) {
        const event = events.at(-1);
        const releasedOnline = leadUpdates.some(update => update.sections
          .some(section => section.type === "online_environment_released"));
        this.queueNotification("lead", "黑板有新批次需要处理。只读取下面列出的题目和增量，不要重读无关环境。"
          + (releasedOnline ? "本批次包含在线环境名额已释放事件，立即补位或按策略调整。" : "")
          + JSON.stringify({ clock: this.competitionClock(), updates: leadUpdates }),
        { eventId: `lead-batch:${event.id}`, version: 0, scope: "global" });
      }
      if (events.length) this.board.setMeta("coordinator_cursor", events.at(-1).id);
      await this.flushNotifications();
      const released = this.board.execute("platform", "release_finished", {});
      for (const workerId of released.released) this.clearAssignmentMetrics(workerId);
      const dispatch = this.board.execute("platform", "dispatch", {});
      const idleWorkerCount = this.board.workers()
        .filter(worker => worker.status === "idle" && !worker.active && !worker.assignment_id).length;
      let pumpResources;
      const loadPumpResources = async () => {
        pumpResources ??= this.resources.snapshot()
          .then(compactResources)
          .catch(error => ({ error: failure(error) }));
        return pumpResources;
      };
      const assistanceGapEvents = new Set([
        "assistance.reminder",
        "assistance.requested",
        "challenge.updated",
        "challenge.resumed",
        "fact.posted",
        "intent.claimed",
        "intent.posted",
        "intent.released",
        "worker.released",
      ]);
      const gapCandidates = new Map();
      for (const item of dispatch.available.assistance) gapCandidates.set(item.id, this.board.challenge(item.id));
      for (const [challengeId, changes] of changed) {
        if (changes.some(change => assistanceGapEvents.has(change.type))) {
          gapCandidates.set(challengeId, this.board.challenge(challengeId));
        }
      }
      const assistanceByChallenge = new Map();
      const addAssistanceNeed = (challenge) => {
        const current = assistanceNeedSummary(challenge);
        assistanceByChallenge.set(current.id, current);
      };
      for (const challengeId of hardAssistanceNeeds) {
        const challenge = this.board.challenge(challengeId);
        const current = assistanceGapState(challenge);
        const previous = this.board.getMeta(assistanceGapMarkerKey(challenge));
        const increased = !previous || previous.generation !== current.generation
          || current.assistance_target > previous.assistance_target
          || current.open_assistance_slots > previous.open_assistance_slots;
        if (current.open_assistance_slots > 0 && increased) {
          addAssistanceNeed(challenge);
          this.board.setMeta(assistanceGapMarkerKey(challenge), current);
        }
      }
      for (const challenge of gapCandidates.values()) {
        const summary = challengeSummary(challenge);
        const markerKey = assistanceGapMarkerKey(challenge);
        const current = assistanceGapState(challenge);
        const previous = this.board.getMeta(markerKey);
        const increased = !previous || previous.generation !== current.generation
          || current.assistance_target > previous.assistance_target
          || current.open_assistance_slots > previous.open_assistance_slots;
        if (summary.open_assistance_slots > 0 && idleWorkerCount === 0 && increased) {
          addAssistanceNeed(challenge);
          this.board.setMeta(markerKey, current);
        } else if (previous && !increased) {
          this.board.setMeta(markerKey, current);
        }
      }
      if (assistanceByChallenge.size) {
        const resources = await loadPumpResources();
        const assistanceNeeds = [...assistanceByChallenge.values()];
        this.queueNotification("lead", "有题目进入需要援助状态。新题仍优先；只有没有新题时，空闲 Worker 才领取援助。"
          + "请结合未认领新题、实际空闲 Worker 和一次真实资源采样，决定是否调用 grow_workers。"
          + JSON.stringify({
            event: "challenges_need_assistance",
            clock: this.competitionClock(),
            challenge_count: assistanceNeeds.length,
            challenges: assistanceNeeds,
            unclaimed_new_challenges: dispatch.available.new_challenges.map(
              ({ description: _description, ...item }) => item),
            resources,
            idle_worker_count: idleWorkerCount,
            assistance_work_continues_broadcast: true,
          }), {
          eventId: `lead-needs-assistance:${randomUUID()}`,
          scope: "global",
          version: 0,
        });
      }
      const availableSummary = {
        new_challenges: dispatch.available.new_challenges.map(({ description: _description, ...item }) => item),
        assistance: dispatch.available.assistance.map(({ description: _description, ...item }) => item),
      };
      const deliveredAvailableNotices = new Set();
      for (const notice of dispatch.notifications) {
        const key = JSON.stringify({
          context: notice.context,
          idle_generation: notice.idle_generation,
          available: availableSummary,
        });
        const previous = this.notices.get(notice.worker_id);
        const count = previous?.key === key ? previous.count : 0;
        if (count >= MAX_IDLE_AVAILABLE_NOTICES || this.retryTimers.has(notice.worker_id)) continue;
        this.notices.set(notice.worker_id, { key, count: count + 1 });
        const result = await this.notify(notice.worker_id, "有可领取工作，请选择并认领。只要还有新题就先选新题；没有新题时再领取援助，竞争失败继续选择。"
          + JSON.stringify({
            available: availableSummary,
            priority_order: "new challenges before assistance; within new challenges follow Lead-defined priority 0 highest; "
              + "offline metadata is shown for Worker selection",
          }),
        { eventId: `available:${notice.worker_id}:${randomUUID()}` });
        if (result?.delivered === true) deliveredAvailableNotices.add(notice.worker_id);
      }
      let backlog = this.board.available().new_challenges;
      let backlogSignature = backlog.map(item => `${item.id}:${item.claim_revision}`).join("|");
      let previousBacklog = this.board.getMeta("lead_new_task_backlog");
      if (deliveredAvailableNotices.size && previousBacklog) {
        if (previousBacklog.event_id) this.removePendingNotification(previousBacklog.event_id);
        this.board.setMeta("lead_new_task_backlog", null);
        previousBacklog = null;
      }
      if (!backlog.length) {
        if (previousBacklog?.event_id) this.removePendingNotification(previousBacklog.event_id);
        if (previousBacklog) this.board.setMeta("lead_new_task_backlog", null);
      } else if (deliveredAvailableNotices.size === 0 && previousBacklog?.signature !== backlogSignature) {
        const resources = await loadPumpResources();
        backlog = this.board.available().new_challenges;
        backlogSignature = backlog.map(item => `${item.id}:${item.claim_revision}`).join("|");
        const backlogItems = backlog.map(({ description: _description, ...item }) => item);
        if (!backlog.length) {
          if (previousBacklog?.event_id) this.removePendingNotification(previousBacklog.event_id);
          if (previousBacklog) this.board.setMeta("lead_new_task_backlog", null);
        } else if (previousBacklog?.signature !== backlogSignature) {
          if (previousBacklog?.event_id) this.removePendingNotification(previousBacklog.event_id);
          const eventId = `lead-new-task-backlog:${createHash("sha256").update(backlogSignature).digest("hex")}`;
          const currentIdleWorkerCount = this.board.workers()
            .filter(worker => worker.status === "idle" && !worker.active && !worker.assignment_id).length;
          const envelope = this.queueNotification("lead", "有新任务积压且没有可分配 Worker。使用通知内附带的紧凑资源，"
            + "结合未认领任务和活跃执行决定等待、调整 priority 或调用 grow_workers。"
            + JSON.stringify({
              event: "new_task_backlog_without_assignable_worker",
              clock: this.competitionClock(),
              unclaimed_new_challenge_count: backlogItems.length,
              unclaimed_new_challenges: backlogItems,
              resources,
              idle_worker_count: currentIdleWorkerCount,
              active_available_notifications: deliveredAvailableNotices.size,
            }), { eventId, scope: "global", version: 0 });
          if (envelope) {
            this.board.setMeta("lead_new_task_backlog", {
              event_id: eventId,
              signature: backlogSignature,
              challenge_ids: backlog.map(item => item.id),
            });
          }
        }
      }
      for (const id of this.settledAgents) {
        this.settledAgents.delete(id);
        if (id === "lead" || this.retryTimers.has(id)) continue;
        const context = this.board.context(id);
        const status = this.pool.status().find(item => item.id === id);
        if (context.assignment_id && status?.idle
          && ["assembling", "solving"].includes(this.board.challenge(context.challenge_id).phase)) {
          const challenge = this.board.challenge(context.challenge_id);
          const previous = this.continuations.get(id);
          const continuations = previous?.assignment_id === context.assignment_id ? previous.count : 0;
          if (continuations >= 2) {
            if (this.stalledReports.get(id) !== context.assignment_id) {
              this.stalledReports.set(id, context.assignment_id);
              this.queueNotification("lead", "Worker 在本段两次自动续跑后仍未收到新的成功本地工具回执。依据该 Worker 已记录的结果和当前方向决定增加援助、调整方向或暂缓；平台继续投递真实新通知。"
                + JSON.stringify({ worker_id: id, challenge_id: challenge.id, revision: challenge.revision }),
              { eventId: `stalled:${id}:${context.assignment_id}:${randomUUID()}`, scope: challenge.id, version: challenge.revision });
            }
            continue;
          }
          this.continuations.set(id, { assignment_id: context.assignment_id, count: continuations + 1 });
          await this.notify(id, "本题仍在解题中。结合现有事实、在途结果和意图继续推进，需要时申请援助或向 Lead 提出暂缓建议。",
            { eventId: `continue:${id}:${context.assignment_id}:${randomUUID()}`, scope: context.challenge_id, version: challenge.revision });
        }
      }
      await this.flushNotifications();
      const unfinished = this.challenges().filter(challenge => challenge.phase !== "completed");
      if (unfinished.length && unfinished.every(challenge => challenge.phase === "deferred")
        && this.pool.status().find(item => item.id === "lead")?.idle) {
        const key = JSON.stringify(unfinished.map(challenge => [challenge.id, challenge.revision]));
        if (this.board.getMeta("deferred_notice") !== key) {
          this.queueNotification("lead", "当前未完成题目均已暂缓。结合资源和剩余时间恢复题目，或明确决定结束比赛。"
            + JSON.stringify({ clock: this.competitionClock(), challenges: unfinished.map(challengeSummary) }),
            { eventId: `deferred:${randomUUID()}` });
          this.board.setMeta("deferred_notice", key);
          await this.flushNotifications();
        }
      }
      clearTimeout(this.reminderTimer);
      const next = this.board.nextReminderAt();
      if (next !== null && next !== undefined) {
        this.reminderTimer = setTimeout(() => {
          this.board.execute("platform", "tick", {});
          this.schedule();
        }, Math.max(0, next - Date.now()));
      }
      succeeded = true;
    } finally {
      this.pumping = false;
      this.resolvePump();
      if (succeeded && !this.closed && !this.ending && this.board.events(this.board.getMeta("coordinator_cursor", 0)).length) this.schedule();
    }
  }

  async challengeDirectory(id) {
    const directory = join(this.config.workDir, "shared", "challenges", id);
    await mkdir(join(directory, "inputs"), { recursive: true });
    return directory;
  }

  async validatePreparedInputs(challenge) {
    const marker = this.board.getMeta(preparationMarkerKey(challenge));
    if (!marker) return { valid: false, reason: "missing_marker" };
    if (marker.version !== PREPARED_INPUT_VERSION
      || marker.challenge_id !== challenge.id
      || marker.unique_code !== challenge.unique_code
      || marker.generation !== challenge.generation
      || typeof marker.manifest_path !== "string"
      || !Number.isSafeInteger(marker.manifest_size)
      || typeof marker.manifest_sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(marker.manifest_sha256)
      || !normalizedPreparedFiles(marker.files)) {
      return { valid: false, reason: "invalid_marker" };
    }
    const directory = await this.challengeDirectory(challenge.id);
    const inputs = join(directory, "inputs");
    const expectedManifest = join(inputs, "manifest.json");
    if (resolve(marker.manifest_path) !== resolve(expectedManifest)) {
      return { valid: false, reason: "unexpected_manifest_path" };
    }
    try {
      const manifestInfo = await fileMetadata(expectedManifest);
      if (manifestInfo.size !== marker.manifest_size
        || manifestInfo.sha256 !== marker.manifest_sha256) {
        return { valid: false, reason: "manifest_changed" };
      }
      const manifest = JSON.parse((await readFile(expectedManifest)).toString("utf8"));
      if (manifest.version !== PREPARED_INPUT_VERSION
        || manifest.challenge_id !== challenge.id
        || manifest.unique_code !== challenge.unique_code
        || manifest.generation !== challenge.generation
        || !samePreparedFiles(marker.files, manifest.files)) {
        return { valid: false, reason: "manifest_mismatch" };
      }
      const files = normalizedPreparedFiles(marker.files);
      for (const file of files) {
        if (!pathInside(inputs, file.path)) {
          return { valid: false, reason: "file_outside_inputs", source_path: file.source_path };
        }
        const current = await fileMetadata(file.path);
        if (current.size !== file.size || current.sha256 !== file.sha256) {
          return { valid: false, reason: "file_changed", source_path: file.source_path };
        }
      }
      return { valid: true, marker, manifest, files };
    } catch (error) {
      return {
        valid: false,
        reason: error.code === "ENOENT" ? "missing_file" : "invalid_inputs",
        message: error.message,
      };
    }
  }

  async invalidatePreparedInputs(challenge, reason) {
    this.board.setMeta(preparationMarkerKey(challenge), {
      version: PREPARED_INPUT_VERSION,
      challenge_id: challenge.id,
      generation: challenge.generation,
      invalid_reason: reason,
      invalidated_at: Date.now(),
    });
    const current = this.board.challenge(challenge.id);
    if (current.ready && current.generation === challenge.generation) {
      this.board.execute("platform", "set_environment", {
        challenge_id: current.id, status: current.environment.status, ready: false,
      });
    }
  }

  async writePreparationManifest(challenge, files) {
    const directory = await this.challengeDirectory(challenge.id);
    const manifestPath = join(directory, "inputs", "manifest.json");
    const manifest = {
      version: PREPARED_INPUT_VERSION,
      challenge_id: challenge.id,
      unique_code: challenge.unique_code,
      generation: challenge.generation,
      files: normalizedPreparedFiles(files),
    };
    if (!manifest.files) throw new Error("Prepared input manifest is invalid");
    const content = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    const temporary = `${manifestPath}.${randomUUID()}.partial`;
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await rename(temporary, manifestPath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    const info = await fileMetadata(manifestPath);
    return { manifest, manifestPath, manifestSize: info.size, manifestSha256: info.sha256 };
  }

  async recordPreparationFact(challenge, manifestPath, manifestSha256, files) {
    const requestId = `prepare-inputs:${challenge.id}:${challenge.generation}:${manifestSha256}`;
    const intentKey = `preparation_fact_intent:${challenge.id}:${challenge.generation}:${manifestSha256}`;
    let intent = this.board.getMeta(intentKey);
    if (!intent || intent.manifest_sha256 !== manifestSha256) {
      intent = {
        request_id: requestId,
        expected_revision: challenge.revision,
        manifest_sha256: manifestSha256,
      };
      this.board.setMeta(intentKey, intent);
    }
    const args = expectedRevision => ({
      request_id: requestId,
      challenge_id: challenge.id,
      expected_revision: expectedRevision,
      statement: `Inputs prepared for environment generation ${challenge.generation}: ${files.length} file(s).`,
      kind: "observation",
      evidence: [{
        type: "text",
        summary: `Input manifest ${manifestPath}; sha256=${manifestSha256}; files=${files.length}`,
      }],
    });
    try {
      return this.board.execute("lead", "post_fact", args(intent.expected_revision));
    } catch (error) {
      if (error.code !== "revision_conflict") throw error;
      intent = { ...intent, expected_revision: this.board.challenge(challenge.id).revision };
      this.board.setMeta(intentKey, intent);
      return this.board.execute("lead", "post_fact", args(intent.expected_revision));
    }
  }

  environmentWasActive(challenge) {
    const key = activationMarkerKey(challenge);
    if (challenge.environment.status === "active") {
      this.board.setMeta(key, true);
      return true;
    }
    const saved = this.board.getMeta(key);
    if (typeof saved === "boolean") return saved;
    // Fresh tasks have no start attempt. For older persisted closed/unknown states,
    // preserve the conservative restart behavior instead of accepting old results.
    const active = challenge.environment.status !== "pending"
      || this.board.getMeta(`environment_start:${challenge.id}`) !== null;
    this.board.setMeta(key, active);
    return active;
  }

  assertPreparationContext(challenge) {
    const current = this.board.challenge(challenge.id);
    if (current.generation !== challenge.generation
      || !["pending", "assembling", "solving", "reviewing"].includes(current.phase)) {
      throw Object.assign(new Error("The task changed while preparing inputs"), { code: "stale_context" });
    }
    return current;
  }

  async localAnalysisReady(challenge) {
    const marker = this.board.getMeta(preparationMarkerKey(challenge));
    if (!marker?.local_analysis
      || !["pending", "assembling", "solving", "reviewing"].includes(challenge.phase)
      || this.board.getMeta(`environment_generation:${challenge.id}`, challenge.generation) > challenge.generation
      || challenge.environment.status === "closed" && this.environmentWasActive(challenge)) return false;
    const validation = await this.validatePreparedInputs(challenge);
    if (validation.valid) return true;
    await this.invalidatePreparedInputs(challenge, validation.reason);
    return false;
  }

  async prepareChallengeInputs(challenge, { markReady = true, refresh = false, paths } = {}) {
    let current = this.board.challenge(challenge.id);
    const origin = { id: current.id, generation: current.generation };
    const selected = paths !== undefined;
    if (selected && (!Array.isArray(paths) || paths.length === 0
      || paths.some(path => typeof path !== "string" || !path.trim())
      || new Set(paths).size !== paths.length)) {
      throw Object.assign(new Error("prepare_paths must contain distinct nonblank listed paths"), {
        code: "invalid_argument",
      });
    }
    this.assertPreparationContext(origin);
    if (!selected && current.environment.status !== "active") {
      throw Object.assign(new Error("Inputs can only be prepared in an active environment"), {
        code: "environment_not_active",
        details: { challenge_id: current.id, status: current.environment.status },
      });
    }
    if (selected && (current.environment.status === "closed" && this.environmentWasActive(current)
      || this.board.getMeta(`environment_generation:${current.id}`, current.generation) > current.generation)) {
      throw Object.assign(new Error("Reopen the previous environment before preparing its new generation"), {
        code: "environment_restart_required",
      });
    }
    this.environmentWasActive(current);
    const saved = this.board.getMeta(preparationMarkerKey(current));
    const sameSelection = !selected || Array.isArray(saved?.files)
      && saved.files.length === paths.length
      && paths.every(path => saved.files.some(file => file.source_path === path));
    const existing = refresh || !sameSelection ? { valid: false } : await this.validatePreparedInputs(current);
    const reusable = existing.valid && (selected
      ? paths.every(path => existing.files.some(file => file.source_path === path))
      : existing.marker.scope !== "selected");
    if (reusable) {
      current = this.assertPreparationContext(origin);
      if (selected && !existing.marker.local_analysis) {
        existing.marker = { ...existing.marker, local_analysis: true };
        this.board.setMeta(preparationMarkerKey(current), existing.marker);
      }
      if (markReady && !current.ready) {
        this.board.execute("platform", "set_environment", {
          challenge_id: current.id, status: current.environment.status, ready: true,
        });
        current = this.board.challenge(current.id);
      }
      return {
        challenge: current,
        marker: existing.marker,
        manifest_path: existing.marker.manifest_path,
        files: existing.files.map(file => ({ ...file, cached: true })),
        materials: {
          status: "ready",
          scope: existing.marker.scope ?? "listed",
          listed: existing.files.length,
          downloaded: existing.files.length,
          missing: [],
          files: existing.files.map(file => ({
            path: file.source_path,
            size: file.size,
            sha256: file.sha256,
          })),
        },
        cached: true,
      };
    }
    const listed = this.config.arena.mode === "connectivity_test"
      ? []
      : await this.arena.listFiles(current.unique_code, { signal: this.stopController.signal });
    current = this.assertPreparationContext(origin);
    const listedPaths = listed.map(entry => typeof entry === "string" ? entry : entry.path);
    if (selected && paths.some(path => !listedPaths.includes(path))) {
      throw Object.assign(new Error("Prepare only exact paths from the official file list"), {
        code: "material_not_listed", details: { missing: paths.filter(path => !listedPaths.includes(path)) },
      });
    }
    if (current.ready && (!selected || !existing.valid)) {
      this.board.execute("platform", "set_environment", {
        challenge_id: current.id, status: current.environment.status, ready: false,
      });
      current = this.board.challenge(current.id);
    }
    const files = [];
    for (const path of [...(selected ? paths : listedPaths)].sort()) {
      files.push(await this.saveListedFile(current, path));
    }
    current = this.assertPreparationContext(origin);
    const written = await this.writePreparationManifest(current, files);
    const marker = {
      version: PREPARED_INPUT_VERSION,
      challenge_id: current.id,
      unique_code: current.unique_code,
      generation: current.generation,
      scope: selected ? "selected" : "listed",
      local_analysis: selected,
      manifest_path: written.manifestPath,
      manifest_size: written.manifestSize,
      manifest_sha256: written.manifestSha256,
      files: normalizedPreparedFiles(files),
      prepared_at: Date.now(),
    };
    current = this.assertPreparationContext(origin);
    await this.recordPreparationFact(current, written.manifestPath, written.manifestSha256, marker.files);
    this.board.setMeta(preparationMarkerKey(current), marker);
    const validation = await this.validatePreparedInputs(current);
    if (!validation.valid) {
      await this.invalidatePreparedInputs(current, validation.reason);
      throw Object.assign(new Error("Prepared inputs failed validation"), {
        code: "invalid_prepared_inputs",
        details: validation,
      });
    }
    current = this.assertPreparationContext(origin);
    if (markReady) this.board.execute("platform", "set_environment", {
      challenge_id: current.id, status: current.environment.status, ready: true,
    });
    current = this.board.challenge(current.id);
    return {
      challenge: current,
      marker,
      manifest_path: marker.manifest_path,
      files,
      materials: {
        status: "ready",
        scope: marker.scope,
        listed: files.length,
        downloaded: files.length,
        missing: [],
        files: files.map(file => ({
          path: file.source_path,
          size: file.size,
          sha256: file.sha256,
        })),
      },
      cached: files.every(file => file.cached),
    };
  }

  controlOperation(operation) {
    const result = this.control.then(operation);
    this.control = result.catch(() => {});
    return result;
  }

  async abortChallengeMembers(challengeId) {
    const challenge = this.board.challenge(challengeId);
    for (const member of challenge.members) {
      try {
        await this.pool.abort(member.worker_id);
        await this.pool.waitIdle(member.worker_id);
        const worker = this.board.workers().find(item => item.id === member.worker_id);
        const context = worker?.execution_context ?? this.board.context(member.worker_id);
        this.board.execute("platform", "activity", {
          worker_id: member.worker_id,
          context,
          running: false,
        });
      } catch (error) {
        this.log({ type: "abandoned_environment_abort_failed", worker_id: member.worker_id, ...failure(error) });
      }
    }
  }

  async handleExternallyClosedEnvironment(challenge, connection, online) {
    const markerKey = `external_environment_closed:${challenge.id}:${challenge.generation}`;
    const previous = this.board.getMeta(markerKey);
    if (previous?.status === "handled") return previous;
    const detectedAt = previous?.detected_at ?? Date.now();
    if (!previous) {
      this.board.setMeta(markerKey, {
        status: "handling",
        online,
        detected_at: detectedAt,
      });
    }
    this.setEnvironment({
      challenge_id: challenge.id,
      status: "closed",
      ready: false,
      online,
      connection,
    });
    if (online) this.board.setMeta(`online_slot_release_notice:${challenge.id}:${challenge.generation}`, "external-close");
    await this.abortChallengeMembers(challenge.id);
    let deferred = false;
    let deferError = null;
    if (["pending", "assembling", "solving", "reviewing"].includes(challenge.phase)) {
      try {
        const current = this.board.challenge(challenge.id);
        await this.defer({
          challenge_id: challenge.id,
          expected_revision: current.revision,
          reason: "The competition environment was closed outside the coordinator. Preserve the work and return the task to Lead.",
          close_environment: false,
        }, `reconcile-closed-environment:${challenge.id}:${challenge.generation}`);
        deferred = true;
      } catch (error) {
        deferError = failure(error);
      }
    }
    const finalChallenge = this.board.challenge(challenge.id);
    const record = {
      status: "handled",
      online,
      deferred,
      released: finalChallenge.members.length === 0,
      ...(deferError ? { error: deferError } : {}),
      detected_at: detectedAt,
    };
    this.board.setMeta(markerKey, record);
    this.queueNotification("lead", "赛事环境已在平台外关闭。相关 Worker 已停止；平台已保存状态并尝试按受支持流程释放。"
      + JSON.stringify({
        challenge: challengeSummary(finalChallenge),
        released: record.released,
        deferred,
        needs_manual_recovery: !record.released,
        error: deferError,
      }), {
      eventId: `external-close:${challenge.id}:${challenge.generation}`,
      scope: challenge.id,
      version: finalChallenge.revision,
    });
    return record;
  }

  queueEnvironmentStartRejection(challenge, error, online) {
    const apiError = {
      code: error.code,
      message: error.message,
      status: error.status ?? null,
      detail: error.detail ?? null,
    };
    const isQuota = error.status === 409 || /limit|quota/i.test(`${error.code} ${error.message}`);
    if (!isQuota) return;
    const current = this.board.challenge(challenge.id);
    const activeOnline = this.challenges()
      .filter(item => item.environment.online === true
        && ["pending", "active", "unknown", "closing"].includes(item.environment.status))
      .map(challengeSummary);
    this.queueNotification("lead", "赛事 API 拒绝了环境启动。协调器保留了原始错误和当前状态，没有本地占用名额或改写配额。"
      + "请根据 active_online_environments 与 api_error 决定关闭、对账或选择其他题目。"
      + JSON.stringify({
        event: "environment_start_rejected",
        challenge: challengeSummary(current),
        online,
        api_error: apiError,
        active_online_environments: activeOnline,
      }), {
      eventId: `environment-start-rejected:${challenge.id}:${apiError.code}:${apiError.status}`,
      scope: challenge.id,
      version: current.revision,
    });
  }

  async startChallenge(id, { dispatchReady = true } = {}) {
    return this.controlOperation(async () => {
      let challenge = this.board.challenge(id);
      if (challenge.phase !== "pending" && !["assembling", "solving", "reviewing"].includes(challenge.phase)) {
        throw new Error("Start a pending or resumed challenge");
      }
      if (this.challenges().some(item => ["closing", "unknown"].includes(item.environment.status))) {
        await this.reconcileEnvironments();
        challenge = this.board.challenge(id);
      }
      const catalog = this.catalog.find(item => item.unique_code === challenge.unique_code);
      const online = catalogRequiresEnvironment(catalog, challenge.requires_online_environment !== false);
      if (challenge.environment.status === "active") {
        this.board.setMeta(activationMarkerKey(challenge), true);
        if (challenge.ready !== dispatchReady) {
          this.setEnvironment({ challenge_id: id, status: "active", ready: dispatchReady });
          challenge = this.board.challenge(id);
        }
        return { challenge, receipt: challenge.environment.connection };
      }
      const wasActive = this.environmentWasActive(challenge);
      if (challenge.environment.status === "closed" && wasActive) {
        this.board.setMeta(`environment_generation:${id}`, challenge.generation + 1);
      }
      const localReady = await this.localAnalysisReady(challenge);
      this.board.setMeta(`environment_start:${id}`, { time: Date.now() });
      this.board.execute("platform", "set_environment", { challenge_id: id, ready: localReady, status: "pending", online });
      let receipt;
      let state;
      try {
        if (this.config.arena.mode === "connectivity_test") {
          receipt = catalog;
          state = "active";
        } else {
          receipt = await this.arena.start(challenge.unique_code, { signal: this.stopController.signal });
          state = environmentState(receipt);
          if (["pending", "unknown"].includes(state)) {
            const reconciled = (await this.refreshCatalog())
              .find(item => item.unique_code === challenge.unique_code);
            state = environmentState(reconciled);
            if (["pending", "unknown"].includes(state)) {
              receipt = await this.arena.start(challenge.unique_code, { signal: this.stopController.signal });
              state = environmentState(receipt);
            } else {
              receipt = reconciled;
            }
          }
        }
      }
      catch (error) {
        if (error.outcomeUnknown) {
          try {
            receipt = await this.arena.start(challenge.unique_code, { signal: this.stopController.signal });
            state = environmentState(receipt);
            if (state === "unknown") {
              const current = (await this.refreshCatalog())
                .find(item => item.unique_code === challenge.unique_code);
              state = environmentState(current);
              if (state === "active") receipt = current;
            }
          } catch (retryError) {
            error = retryError;
          }
        }
        if (state === undefined || state === "unknown" && error.outcomeUnknown) {
          const connection = {
            code: error.code ?? "operation_failed",
            message: error.message,
            status: error.status ?? null,
            detail: error.detail ?? null,
            outcome_unknown: error.outcomeUnknown ?? false,
          };
          this.board.execute("platform", "set_environment", { challenge_id: id, ready: localReady,
            status: error.outcomeUnknown ? "unknown" : "closed", online, connection });
          this.queueEnvironmentStartRejection(challenge, error, online);
          throw error;
        }
      }
      if (state === "unknown") {
        const current = (await this.refreshCatalog()).find(item => item.unique_code === challenge.unique_code);
        state = environmentState(current);
        if (state === "active") receipt = current;
      }
      this.setEnvironment({
        challenge_id: id, ready: localReady || state === "active" && dispatchReady, status: state,
        online: catalogRequiresEnvironment(receipt, online), connection: receipt,
      });
      challenge = this.board.challenge(id);
      return { challenge, receipt };
    });
  }

  setEnvironment(args) {
    const challenge = this.board.challenge(args.challenge_id);
    const target = this.board.getMeta(`environment_generation:${challenge.id}`, challenge.generation);
    const updated = this.board.execute("platform", "set_environment", { ...args,
      new_generation: args.status === "active" && target > challenge.generation });
    if (args.status === "active") this.board.setMeta(activationMarkerKey(updated), true);
    return updated;
  }

  async reconcileEnvironments() {
    const catalog = await this.refreshCatalog();
    const results = [];
    for (const challenge of this.challenges()) {
      if (!["pending", "active", "unknown", "closing", "closed"].includes(challenge.environment.status)) continue;
      this.environmentWasActive(challenge);
      if (challenge.environment.status === "pending" && !this.board.getMeta(`environment_start:${challenge.id}`)
        && !this.board.getMeta(preparationMarkerKey(challenge))?.local_analysis) continue;
      const actual = catalog.find(item => item.unique_code === challenge.unique_code);
      const status = environmentState(actual);
      const online = catalogRequiresEnvironment(actual, challenge.requires_online_environment !== false);
      if (status === "unknown") {
        const localReady = await this.localAnalysisReady(challenge);
        if (challenge.ready !== localReady || challenge.environment.status !== "unknown") {
          this.setEnvironment({
            challenge_id: challenge.id,
            status: "unknown",
            ready: localReady,
            online,
            connection: actual,
          });
        }
        results.push({ challenge_id: challenge.id, status, ready: localReady });
        continue;
      }
      if (status === "closed" && !["completed", "deferred"].includes(challenge.phase)
        && this.environmentWasActive(challenge)) {
        const handled = await this.handleExternallyClosedEnvironment(challenge, actual, online);
        results.push({ challenge_id: challenge.id, status,
          deferred: this.board.challenge(challenge.id).phase === "deferred",
          released: handled?.released ?? this.board.challenge(challenge.id).members.length === 0 });
        continue;
      }
      const ready = !["completed", "deferred"].includes(challenge.phase)
        && (status === "active" || await this.localAnalysisReady(challenge));
      const changed = challenge.environment.status !== status
        || challenge.environment.online !== online
        || challenge.ready !== ready
        || JSON.stringify(challenge.environment.connection) !== JSON.stringify(actual);
      if (changed) {
        this.setEnvironment({ challenge_id: challenge.id, status, ready, online, connection: actual });
      }
      if (status === "active") this.board.setMeta(activationMarkerKey(this.board.challenge(challenge.id)), true);
      results.push({ challenge_id: challenge.id, status, ready });
    }
    return results;
  }

  async files(id, path, preparePaths) {
    const challenge = this.board.challenge(id);
    if (path !== undefined && preparePaths !== undefined) {
      throw Object.assign(new Error("Use path or prepare_paths, not both"), { code: "invalid_argument" });
    }
    if (preparePaths !== undefined) {
      return this.controlOperation(() => this.prepareChallengeInputs(challenge, { paths: preparePaths }));
    }
    if (this.config.arena.mode === "connectivity_test") {
      return { files: [], description: this.catalog.find(item => item.unique_code === challenge.unique_code)?.description ?? challenge.description };
    }
    const listed = await this.arena.listFiles(challenge.unique_code, { signal: this.stopController.signal });
    if (!path) return listed;
    return this.saveListedFile(challenge, path);
  }

  async saveListedFile(challenge, path) {
    const directory = join(await this.challengeDirectory(challenge.id), "inputs");
    const digest = createHash("sha256").update(path).digest("hex").slice(0, 16);
    const destination = join(directory, `g${challenge.generation}-${digest}-${basename(path)}`);
    let previous = null;
    try {
      previous = await fileMetadata(destination);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const response = await this.arena.readFile(challenge.unique_code, path, { signal: this.stopController.signal });
    if (!response.body) throw new Error("Handout response has no body");
    const temporary = `${destination}.${randomUUID()}.partial`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      const downloaded = await fileMetadata(temporary);
      if (previous?.size === downloaded.size && previous.sha256 === downloaded.sha256) {
        await unlink(temporary);
        return { path: destination, source_path: path, size: downloaded.size,
          sha256: downloaded.sha256, cached: true, changed: false };
      }
      await rename(temporary, destination);
      const prepared = this.board.getMeta(preparationMarkerKey(challenge));
      if (prepared && (prepared.scope !== "selected"
        || prepared.files?.some(file => file.source_path === path))) {
        await this.invalidatePreparedInputs(challenge, "attachment_content_changed");
      }
      return { path: destination, source_path: path, size: downloaded.size,
        sha256: downloaded.sha256, cached: false, changed: true };
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }

  catalogDifficulty(item) {
    if (["easy", "medium", "hard"].includes(item.difficulty)) return item.difficulty;
    if (item.multi_stage === true) return "hard";
    const numeric = Number(item.difficulty);
    if (Number.isFinite(numeric)) {
      if (numeric <= 1) return "easy";
      if (numeric <= 2) return "medium";
      return "hard";
    }
    return "medium";
  }

  prepareOffline() {
    this.offlinePreparation ??= this._prepareOffline()
      .finally(() => { this.offlinePreparation = null; });
    return this.offlinePreparation;
  }

  async _prepareOffline() {
    await this.refreshCatalog();
    const results = [];
    const offline = this.catalog.filter(item => catalogRequiresEnvironment(item) === false && !challengeCompleted(item));
    for (const item of offline) {
      try {
        let challenge = this.challenges().find(value => value.unique_code === item.unique_code);
        if (!challenge) {
          challenge = this.board.execute("lead", "create_challenge", {
            request_id: `prepare-offline:${item.unique_code}`,
            unique_code: item.unique_code,
            title: item.name ?? item.title ?? item.unique_code,
            description: item.description ?? "",
            difficulty: this.catalogDifficulty(item),
            multi_stage: item.multi_stage === true,
            priority: 0,
            ready: false,
            requires_online_environment: false,
          });
          this.board.setMeta(activationMarkerKey(challenge), false);
        }
        if (challenge.phase === "deferred" || challenge.phase === "completed") {
          const validation = await this.validatePreparedInputs(challenge);
          if (!validation.valid) throw Object.assign(new Error("Deferred offline inputs are not valid"), {
            code: "invalid_prepared_inputs",
            details: validation,
          });
          results.push({
            status: challenge.phase,
            challenge_id: challenge.id,
            unique_code: item.unique_code,
            files: validation.files ?? [],
            materials: {
              status: challenge.phase === "completed" ? "completed" : "deferred",
              listed: item.materials?.listed ?? null,
              downloaded: validation.files?.length ?? 0,
              missing: item.materials?.missing ?? [],
              files: (validation.files ?? []).map(file => ({
                path: file.source_path,
                size: file.size,
                sha256: file.sha256,
              })),
            },
          });
          continue;
        }
        await this.startChallenge(challenge.id, { dispatchReady: false });
        challenge = this.board.challenge(challenge.id);
        if (challenge.environment.status !== "active") {
          throw Object.assign(new Error("The offline environment is not ready yet"), {
            code: "offline_environment_pending",
            details: { challenge_id: challenge.id, status: challenge.environment.status },
          });
        }
        const prepared = await this.prepareChallengeInputs(challenge, { markReady: true });
        const files = prepared.files;
        const directory = await this.challengeDirectory(challenge.id);
        results.push({
          status: "ready",
          challenge_id: challenge.id,
          unique_code: item.unique_code,
          difficulty: this.board.challenge(challenge.id).difficulty,
          challenge_root: directory,
          inputs: join(directory, "inputs"),
          files,
          materials: prepared.materials,
        });
      } catch (error) {
        results.push({
          status: "error",
          unique_code: item.unique_code,
          materials: {
            status: "error",
            listed: item.materials?.listed ?? null,
            downloaded: 0,
            missing: item.materials?.missing ?? [],
            files: item.materials?.files ?? [],
          },
          error: failure(error),
        });
      }
    }
    return {
      offline_total: offline.length,
      prepared: results.filter(item => item.status === "ready").length,
      failed: results.filter(item => item.status === "error").length,
      tasks: results,
    };
  }

  applySubmission(id, result) {
    if (result.cumulativeScore !== null && result.cumulativeScore !== undefined) this.board.setMeta("cumulative_score", result.cumulativeScore);
    const receipt = result.receipt ?? result.challenge ?? {};
    const challengeCompletedByReceipt = challengeCompleted({ ...receipt, flag_count: receipt.total_flag_count ?? receipt.flag_count });
    const submission = this.challenges().flatMap(challenge => challenge.submissions ?? []).find(item => item.id === id);
    const catalog = this.catalog?.find(item => item.unique_code === submission?.unique_code);
    const completed = challengeCompletedByReceipt || challengeCompleted(result.challenge ?? {})
      || challengeCompleted(catalog ?? {}) || (result.outcome === "accepted" && catalog?.flag_count === 1);
    return this.board.execute("platform", "submission_result", {
      submission_id: id, status: result.outcome,
      challenge_completed: completed,
      reason: result.outcome === "rejected" ? result.receipt?.message ?? "赛事接口返回 correct=false。此候选未通过。" : result.reason,
      receipt: result.receipt ?? result.challenge ?? result.error ?? {},
    });
  }

  async submit(args, callId) {
    const challenge = this.board.challenge(args.challenge_id);
    let beginning = this.board.execute("lead", "begin_submission", { ...args, request_id: callId });
    if (beginning.reconcile_required) {
      this.metrics.submission_conflicts += 1;
      await this.reconcilePendingSubmissions();
      const current = this.board.challenge(args.challenge_id);
      if (current.phase !== "reviewing") {
        const submission = current.submissions.find(item => item.id === beginning.submission.id);
        return compactSubmissionResult({
          outcome: submission?.status === "accepted" ? "accepted"
            : submission?.status === "rejected" ? "rejected" : "unknown",
          receipt: submission?.receipt,
          challenge: this.catalog?.find(item => item.unique_code === current.unique_code),
          reason: submission?.reason,
        }, submission);
      }
      beginning = this.board.execute("lead", "begin_submission", {
        ...args,
        reconciled_unknown: true,
        request_id: `${callId}:reconciled`,
      });
    }
    if (!beginning.should_submit) {
      return compactSubmissionResult({
        outcome: beginning.submission?.status ?? "unknown",
        receipt: beginning.submission?.receipt,
        reason: beginning.reason ?? beginning.submission?.reason,
      }, beginning.submission);
    }
    const candidate = challenge.candidates.find(item => item.id === args.candidate_id);
    let result;
    try { result = await this.arena.submit(challenge.unique_code, candidate.flag, { signal: this.stopController.signal }); }
    catch (error) {
      this.applySubmission(beginning.submission.id, { outcome: error.outcomeUnknown ? "unknown" : "not_sent", error: failure(error), reason: error.message });
      throw error;
    }
    if (result.outcome === "accepted" && this.config.arena.mode !== "connectivity_test") {
      try {
        await this.refreshCatalog();
        result.challenge = this.catalog.find(item => item.unique_code === challenge.unique_code);
      } catch (error) { this.log({ type: "progress_refresh_failed", ...failure(error) }); }
    }
    this.applySubmission(beginning.submission.id, result);
    const submission = this.board.challenge(args.challenge_id).submissions
      .find(item => item.id === beginning.submission.id);
    const compact = compactSubmissionResult(result, submission);
    if (this.config.arena.mode === "connectivity_test" && ["accepted", "rejected"].includes(result.outcome)) {
      this.endLocal("connectivity_verdict", result, result.outcome === "accepted");
      return compact;
    }
    return compact;
  }

  async defer(args, callId) {
    const result = this.board.execute("lead", "defer", { ...args, request_id: callId });
    const challenge = this.board.challenge(args.challenge_id);
    await Promise.all(challenge.members.map(async member => {
      await this.pool.abort(member.worker_id);
      await this.pool.waitIdle(member.worker_id);
      const worker = this.board.workers().find(item => item.id === member.worker_id);
      this.board.execute("platform", "activity", { worker_id: member.worker_id, context: worker.execution_context ?? this.board.context(member.worker_id), running: false });
    }));
    this.board.execute("platform", "release_finished", {});
    if (args.close_environment !== false && this.config.arena.mode !== "connectivity_test") {
      await this.controlOperation(async () => {
        this.board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "closing", ready: false });
        let receipt;
        try { receipt = await this.arena.close(challenge.unique_code, { signal: this.stopController.signal }); }
        catch (error) {
          this.board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "unknown", ready: false, connection: failure(error) });
          throw error;
        }
        if (environmentState(receipt) !== "closed") {
          this.board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "unknown", ready: false, connection: receipt });
          await this.reconcileEnvironments();
          return;
        }
        this.board.execute("platform", "set_environment", { challenge_id: challenge.id, status: "closed", ready: false, connection: receipt });
      });
    }
    return result;
  }

  endLocal(reason, receipt, completed = this.catalog?.length > 0 && this.catalog.every(challengeCompleted)) {
    const result = { reason, receipt, time: Date.now(), completed };
    this.board.setMeta("finished", result);
    this.ending = true;
    this.started = false;
    clearTimeout(this.reminderTimer);
    clearTimeout(this.pumpRetry);
    this.clearHardBootstrapReminders();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.resolveFinished(result);
  }

  async reconcileFinish(previous) {
    const record = { ...previous, status: "unknown", reconciled_at: Date.now() };
    try { record.catalog = await this.arena.listChallenges({ signal: this.stopController.signal }); }
    catch (error) { record.reconciliation_error = failure(error); }
    this.board.setMeta("finish_attempt", record);
    this.endLocal(record.reason, record);
    return record;
  }

  async finish(reason) {
    return this.controlOperation(async () => {
      const attempt = this.board.getMeta("finish_attempt");
      if (["pending", "unknown"].includes(attempt?.status)) return this.reconcileFinish(attempt);
      const previous = this.board.getMeta("finished");
      if (previous) return previous.receipt;
      if (!reason?.trim()) throw new Error("An explicit finish reason is required");
      if (this.config.arena.mode === "connectivity_test") throw new Error("Connectivity checks end automatically on the submission verdict");
      const pending = this.challenges().flatMap(challenge => challenge.submissions ?? []).filter(item => ["unknown", "pending"].includes(item.status));
      if (pending.length) throw new Error("Reconcile pending flag submissions before finishing the attempt");
      await this.refreshCatalog();
      const intent = { reason, status: "pending", time: Date.now() };
      this.board.setMeta("finish_attempt", intent);
      let receipt;
      try { receipt = await this.arena.finish({ signal: this.stopController.signal }); }
      catch (error) {
        const record = { ...intent, status: error.outcomeUnknown ? "unknown" : "not_sent", error: failure(error) };
        this.board.setMeta("finish_attempt", record);
        if (error.outcomeUnknown) this.endLocal(reason, record);
        throw error;
      }
      this.board.setMeta("finish_attempt", { ...intent, status: "confirmed", receipt });
      this.endLocal(reason, receipt);
      return receipt;
    });
  }

  tools(role, id) {
    const actions = role === "lead" ? LEAD_ACTIONS : WORKER_ACTIONS;
    const tool = (name, description, parameters, execute) => ({ name, description, parameters,
      execute: async (args, execution) => {
        try { return await execute(args, execution); }
        catch (error) {
          const action = name === "board_act" ? `${name}.${args.action}` : name;
          const key = `${action}:${error.code ?? "operation_failed"}`;
          this.metrics.tool_errors[key] = (this.metrics.tool_errors[key] ?? 0) + 1;
          if (name === "board_act" && args.action === "claim" && error.code === "work_changed") {
            this.metrics.claim_conflicts += 1;
          }
          if (["stale_review", "stale_candidate", "submission_unresolved"].includes(error.code)) {
            this.metrics.submission_conflicts += 1;
          }
          if (error.code === "task_not_found") this.endLocal("invalid_attempt_token", failure(error));
          throw error;
        }
      } });
    const shared = [
      tool("board_read", "Read the blackboard through an explicit view. available lists claimable work; task is for complete history when needs_task_read=true, recovery, or a state conflict; updates returns entity bodies after a cursor; entity reads one Fact/Intent/Candidate/Artifact/Submission; omit view only for recovery or state conflict. Lead sees all tasks.",
        Type.Object({
          view: Type.Optional(Type.Union(["available", "task", "updates", "entity", "history"]
            .map(value => Type.Literal(value)))),
          challenge_id: Type.Optional(text),
          since_cursor: Type.Optional(Type.Integer({ minimum: 0 })),
          entity_kind: Type.Optional(Type.Union(["fact", "intent", "candidate", "artifact", "submission"]
            .map(value => Type.Literal(value)))),
          entity_id: Type.Optional(text),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        }),
        args => {
          const snapshot = this.board.snapshot(id, { challengeId: args.challenge_id, sinceRevision: args.since_cursor,
            view: args.view, entityKind: args.entity_kind, entityId: args.entity_id, limit: args.limit });
          return role === "lead" ? { ...snapshot, ...this.competitionClock() } : snapshot;
        }),
      tool("board_act", "Update the blackboard. request_id is automatic. Priority is 0 highest through 3 lowest. "
        + "Arguments below are required unless marked optional. "
        + actions.map(action => `${action}: ${BOARD_ACTION_ARGUMENTS[action]}.`).join(" ")
        + " Read the returned revision before another task write.",
        Type.Object({ action: Type.Union(actions.map(action => Type.Literal(action))), args: Type.Record(Type.String(), Type.Unknown()) }),
        (args, execution) => {
          if (args.action === "create_challenge" && !this.catalog?.some(item => item.unique_code === args.args.unique_code)) throw new Error("Create tasks using an actual code from arena_list");
          const input = { ...args.args, request_id: execution.callId };
          if (args.action === "create_challenge") {
            const catalog = this.catalog.find(item => item.unique_code === input.unique_code);
            input.ready = false;
            input.description ??= catalog.description;
            input.requires_online_environment = catalogRequiresEnvironment(catalog);
          }
          const result = this.board.execute(id, args.action, input, execution.context);
          if (args.action === "create_challenge" && this.board.getMeta(activationMarkerKey(result)) === null) {
            this.board.setMeta(activationMarkerKey(result), false);
          }
          return result;
        }),
      tool("snapshot_file", "Capture a file as immutable evidence, then reference its artifact_id in a Fact. This records an observed file snapshot.",
        Type.Object({ path: text, challenge_id: text }), async (args, execution) => {
          const assertOrigin = () => {
            this.board.snapshot(id, { challengeId: args.challenge_id });
            if (id !== "lead" && (execution.context?.challenge_id !== args.challenge_id
              || JSON.stringify(assignmentContext(execution.context)) !== JSON.stringify(this.board.context(id)))) {
              throw new Error("File evidence requires the current task assignment");
            }
          };
          assertOrigin();
          const artifact = await snapshotFile({ root: await this.challengeDirectory(args.challenge_id), path: args.path, signal: execution.signal });
          assertOrigin();
          return this.board.execute("platform", "register_artifact", { ...artifact, challenge_id: args.challenge_id, worker_id: id, context: execution.context });
        }),
      tool("record_fact", "Record a short Fact from the latest completed bash output. The platform registers an immutable Artifact first, then commits the Fact, disputes, resolves/result and optional next_intents in a separate Board transaction. Inferences require derived_from Fact ids. disputes contains Fact ids; paired resolves/result closes only your held Intent. Each next Intent may carry disputes:[intent_id].",
        Type.Object({
          challenge_id: text,
          statement: text,
          kind: Type.Optional(Type.Union(["observation", "inference", "structure"]
            .map(value => Type.Literal(value)))),
          summary: Type.Optional(text),
          derived_from: Type.Optional(Type.Array(text)),
          disputes: Type.Optional(Type.Array(text)),
          resolves: Type.Optional(text),
          result: Type.Optional(Type.Union(["confirmed", "rejected", "inconclusive"]
            .map(value => Type.Literal(value)))),
          next_intents: Type.Optional(Type.Array(Type.Object({
            statement: text,
            expected: text,
            method: text,
            claim: Type.Optional(Type.Boolean()),
            parallel: Type.Optional(Type.Boolean()),
            parallel_key: Type.Optional(text),
            depends_on: Type.Optional(Type.Array(text)),
            retry_of: Type.Optional(text),
            relates_to: Type.Optional(Type.Array(text)),
            disputes: Type.Optional(Type.Array(text)),
          }), { maxItems: 3 })),
        }), async (args, execution) => {
          const latest = this.pool.latestToolOutput(id);
          if (!latest?.details?.output_path) throw new Error("No completed bash output is available to record");
          const context = execution.context;
          if (id !== "lead" && (context?.challenge_id !== args.challenge_id
            || JSON.stringify(assignmentContext(context)) !== JSON.stringify(this.board.context(id))
            || JSON.stringify(assignmentContext(latest.context)) !== JSON.stringify(assignmentContext(context)))) {
            throw new Error("Fact evidence requires the current task assignment");
          }
          const artifact = await snapshotFile({
            root: await this.challengeDirectory(args.challenge_id),
            path: latest.details.output_path,
            signal: execution.signal,
          });
          const registered = this.board.execute("platform", "register_artifact", {
            ...artifact,
            challenge_id: args.challenge_id,
            worker_id: id,
            context,
            call_id: latest.call_id,
          });
          return this.board.execute(id, "post_fact", {
            request_id: execution.callId,
            challenge_id: args.challenge_id,
            statement: args.statement,
            kind: args.kind,
            derived_from: args.derived_from,
            disputes: args.disputes,
            resolves: args.resolves,
            result: args.result,
            evidence: [{ artifact_id: registered.id,
              summary: args.summary ?? `Captured output from ${latest.tool}` }],
            next_intents: args.next_intents,
          }, context);
        }),
    ];
    if (role !== "lead") return shared;
    return [...shared,
      tool("arena_list", "Fetch the compact official challenge catalog and material metadata. data_plane=false identifies offline challenges. Offline-first order is a Lead strategy; the coordinator does not enforce it as a local gate.",
        Type.Object({}), async () => (await this.refreshCatalog()).map(compactCatalogItem)),
      tool("arena_reconcile", "Read official progress to resolve pending environment outcomes and flag receipts.", Type.Object({}), async () => ({
        environments: await this.reconcileEnvironments(), submissions: await this.reconcilePendingSubmissions(),
      })),
      tool("arena_prepare_offline", "Explicitly prepare unfinished offline challenges in one call. It creates missing board tasks, starts them, downloads every listed attachment into the shared inputs directory, writes a generation-bound SHA-256 manifest, and marks tasks ready only after preparation. Idempotent; retry failed tasks.",
        Type.Object({}), () => this.prepareOffline()),
      tool("arena_start", "Start one created task through the official API. The coordinator does not enforce local offline prerequisites, online instance counts, or quota policy. API errors such as environment_limit or quota failures are preserved for Lead. Pending environments need a later retry.",
        challengeParameter, args => this.startChallenge(args.challenge_id)),
      tool("arena_files", "List official paths, download one exact path, or explicitly prepare_paths for a local analysis step before an online instance is available. path is download-only and cannot be combined with prepare_paths. Preparation validates only the selected files, records their generation-bound manifest, and makes local work claimable; it does not assert that all future materials or a remote service are ready.",
        Type.Object({ challenge_id: text, path: Type.Optional(text),
          prepare_paths: Type.Optional(Type.Array(text, { minItems: 1, uniqueItems: true })) }),
        args => this.files(args.challenge_id, args.path, args.prepare_paths)),
      tool("submit_flag", "Authorize a candidate and submit its flag. Accepted, rejected, and unknown results are persisted. Reconcile unknown outcomes first. If official progress remains unchanged, retrying the exact same candidate is safe and is rejected by the server as duplicate when the first request was accepted.",
        Type.Object({ challenge_id: text, candidate_id: text, review_revision: Type.Integer() }), (args, execution) => this.submit(args, execution.callId)),
      tool("reconcile_submissions", "Read official progress to reconcile unknown submissions without submitting again.", Type.Object({}), () => this.reconcilePendingSubmissions()),
      tool("defer_challenge", "Save a reason and defer a task. End its executions before releasing members, optionally close the environment.",
        Type.Object({ challenge_id: text, reason: text, expected_revision: Type.Integer(), close_environment: Type.Optional(Type.Boolean()) }), (args, execution) => this.defer(args, execution.callId)),
      tool("resume_challenge", "Restore a deferred task and start its environment using a new generation when needed.",
        Type.Object({ challenge_id: text, expected_revision: Type.Integer() }), async (args, execution) => {
          this.board.execute("lead", "resume", { ...args, request_id: execution.callId });
          return this.startChallenge(args.challenge_id);
        }),
      tool("resources", "Read compact container CPU, memory, disk, event loop, worker execution and coordinator metrics. Set details=true only when full cgroup counters are required.",
        Type.Object({ details: Type.Optional(Type.Boolean()) }), async (args) => {
          const snapshot = await this.resources.snapshot();
          return args.details ? { ...snapshot, metrics: this.metrics } : {
            ...compactResources(snapshot),
            metrics: this.metrics,
          };
        }),
      tool("grow_workers", "Increase the peer Worker team to target_total. Inspect resource usage and useful parallel work before choosing the target.",
        Type.Object({ target_total: Type.Integer({ minimum: 1 }), reason: text }), async (args, execution) => {
          this.board.execute("lead", "grow_workers", { ...args, request_id: execution.callId });
          await this.prepareWorkers();
          return this.board.execute("lead", "grow_workers", { ...args, request_id: execution.callId });
        }),
      tool("finish_attempt", "Explicitly finish the competition after confirmed completion or a deliberate decision to stop. This ends the attempt.",
        Type.Object({ reason: text }), args => this.finish(args.reason)),
    ];
  }

  stop(reason = "shutdown") {
    this.stopping ??= (async () => {
      this.closed = true;
      this.stopController.abort();
      clearTimeout(this.reminderTimer);
      clearTimeout(this.deadlineTimer);
      clearTimeout(this.pumpRetry);
      this.clearHardBootstrapReminders();
      for (const timer of this.retryTimers.values()) clearTimeout(timer);
      const graceful = await settlesWithin(Promise.allSettled([
        Promise.resolve().then(() => this.pool.close()),
        this.starting,
        this.control,
        this.pumpDone,
        ...this.deliveries.values(),
      ]), this.stopGraceMs);
      if (!graceful) {
        this.log({ type: "stop_grace_expired", reason, grace_ms: this.stopGraceMs });
        try { await this.pool.forceClose?.(); }
        catch (error) { this.log({ type: "stop_force_close_failed", ...failure(error) }); }
      }
      try { this.resources.close(); }
      catch (error) { this.log({ type: "resource_monitor_close_failed", ...failure(error) }); }
      const stoppedLifecycle = {
        ...this.board.getMeta("runtime_lifecycle", {}),
        status: "stopped",
        stopped_at: new Date().toISOString(),
        stop_reason: reason,
      };
      try { this.board.setMeta("runtime_lifecycle", stoppedLifecycle); }
      catch (error) { this.log({ type: "runtime_stop_meta_failed", ...failure(error) }); }
      try {
        await persistRuntimeHealth(this.config.workDir, stoppedLifecycle);
      } catch (error) {
        this.log({ type: "runtime_stop_marker_failed", ...failure(error) });
      }
      this.log({ type: "stopped", reason });
      await settlesWithin(this.logWrites, Math.min(this.stopGraceMs, 2000));
      await settlesWithin(Promise.resolve().then(() => this.logFile.close()), Math.min(this.stopGraceMs, 2000));
      try { this.board.close(); }
      catch (error) { /* Stop must preserve the primary shutdown result. */ }
      this.resolveFinished({ reason });
    })();
    return this.stopping;
  }
}
