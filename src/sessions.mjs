import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager,
  SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLocalTools } from "./local-tools.mjs";
import { rolePrompt } from "./prompts.mjs";

const clone = (value) => value == null ? null : structuredClone(value);
const identity = (value) => JSON.stringify([value?.worker_id, value?.assignment_id,
  value?.challenge_id, value?.generation, value?.environment_generation]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const COMPACTION_CONTEXT_TOKENS = 600_000;
const COMPACTION_KEEP_RECENT_TOKENS = 20_000;
const MAX_INLINE_TOOL_OUTPUT_CHARS = 256 * 1024;
const KEEP_RECENT_TOOL_OUTPUTS = 4;
const MIN_BOARD_ARCHIVE_CHARS = 4 * 1024;
const MAX_COMPLETED_CALLS = 200;
const MAX_CONSUMED_NOTIFICATIONS = 5000;

export function compactionSettings(contextWindow) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) {
    throw new TypeError("Model contextWindow must be a positive integer");
  }
  const threshold = Math.max(1, Math.min(
    COMPACTION_CONTEXT_TOKENS,
    Math.floor(contextWindow * 0.8),
  ));
  return {
    enabled: true,
    reserveTokens: contextWindow - threshold,
    keepRecentTokens: Math.min(COMPACTION_KEEP_RECENT_TOKENS, threshold),
  };
}

function textLength(message) {
  if (!Array.isArray(message?.content)) return 0;
  return message.content.reduce((total, item) =>
    total + (item?.type === "text" && typeof item.text === "string" ? item.text.length : 0), 0);
}

function historyOutputPath(message) {
  return message.toolName === "board_read"
    ? message.details?.history_output_path : message.details?.output_path;
}

export function compactToolHistory(messages) {
  const outputIndexes = [];
  let inlineChars = 0;
  for (const [index, message] of messages.entries()) {
    if (message?.role !== "toolResult" || message.isError
      || typeof historyOutputPath(message) !== "string") continue;
    if (Array.isArray(message.content) && message.content.some((item) => item?.type === "image")) continue;
    outputIndexes.push(index);
    inlineChars += textLength(message);
  }
  if (inlineChars <= MAX_INLINE_TOOL_OUTPUT_CHARS) return messages;
  const compactedIndexes = new Set(outputIndexes.slice(
    0, Math.max(0, outputIndexes.length - KEEP_RECENT_TOOL_OUTPUTS)));
  if (!compactedIndexes.size) return messages;
  return messages.map((message, index) => {
    if (!compactedIndexes.has(index)) return message;
    const path = historyOutputPath(message);
    const details = message.toolName === "board_read" ? {
      compacted_tool_output: true,
      history_output_path: path,
      history_output_bytes: message.details.history_output_bytes,
    } : {
      compacted_tool_output: true,
      output_path: message.details.output_path,
      exit_code: message.details.exit_code ?? null,
      bytes: message.details.bytes ?? null,
      truncated: message.details.truncated ?? false,
      timed_out: message.details.timed_out ?? false,
    };
    const text = `Old ${message.toolName} output compacted to keep the session focused. `
      + `Full output remains at ${path}. `
      + (message.toolName === "board_read" ? "Read only the saved snapshot lines you need.\n"
        : "Read it only when needed and record durable conclusions as Fact or Intent.\n")
      + JSON.stringify(details);
    if (text.length >= textLength(message)) return message;
    return {
      ...message,
      content: [{ type: "text", text }],
      details,
      nestedCalls: undefined,
    };
  });
}

async function archiveBoardRead(record, callId, result) {
  // Skip small receipts; the shared 256 Ki-character budget decides when to project snapshots out.
  if (result.isError || !result.content?.every(item => item?.type === "text" && typeof item.text === "string")
    || textLength(result) <= MIN_BOARD_ARCHIVE_CHARS) return result;
  let text = result.content.map(item => item.text).join("\n");
  // Board responses are JSON. Formatting preserves their values and permits bounded line reads.
  try { text = JSON.stringify(JSON.parse(text), null, 2) + "\n"; } catch {}
  try {
    const directory = join(record.directory, "history-output");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${digest(callId)}.txt`);
    await writeFile(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { ...result, details: { ...result.details,
      history_output_path: path, history_output_bytes: Buffer.byteLength(text) } };
  } catch {
    // Archiving is optional: preserve the full inline result if the snapshot could not be saved.
    return result;
  }
}

function readJournal(path) {
  if (!existsSync(path)) return [];
  const bytes = readFileSync(path);
  const end = bytes.lastIndexOf(10) + 1;
  // A process crash can leave only the final append incomplete.
  if (end !== bytes.length) truncateSync(path, end);
  return bytes.subarray(0, end).toString("utf8").split("\n").filter(Boolean).map(JSON.parse);
}

function resultMessage(value) {
  if (Array.isArray(value?.content)) return value;
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }], details: value ?? {} };
}

function resourceLoader(prompt) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function recoverToolResults(manager, calls) {
  const pending = new Map();
  for (const entry of manager.getBranch()) {
    const message = entry.message;
    if (message?.role === "assistant") {
      for (const call of message.content.filter((part) => part.type === "toolCall")) pending.set(call.id, call);
    }
    if (message?.role === "toolResult") pending.delete(message.toolCallId);
  }
  const unresolved = [];
  for (const call of pending.values()) {
    const known = calls.get(call.id);
    const result = known?.type === "tool_end" ? known.result : {
      isError: true,
      content: [{ type: "text", text: "Process restarted before a final tool result was recorded. "
        + "The outcome is unknown. Inspect the blackboard and saved output before retrying any side effect." }],
    };
    manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: result.content, ...(result.details !== undefined ? { details: result.details } : {}),
      isError: Boolean(result.isError), timestamp: Date.now() });
    if (known?.type !== "tool_end") unresolved.push({ call_id: call.id, tool: call.name, outcome: "unknown" });
  }
  return unresolved;
}

export class SessionPool {
  static async create(options) {
    const config = options.modelConfig;
    for (const key of ["provider", "id", "api", "baseUrl", "apiKey"]) {
      if (typeof config?.[key] !== "string" || !config[key]) throw new Error(`Missing model setting ${key}`);
    }
    for (const key of ["contextWindow", "maxTokens"]) {
      if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid model setting ${key}`);
    }
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
      modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider(config.provider, { api: config.api, baseUrl: config.baseUrl,
      apiKey: config.apiKey, models: [{ id: config.id, name: config.id,
        reasoning: Boolean(config.reasoning), input: config.input ?? ["text"],
        contextWindow: config.contextWindow, maxTokens: config.maxTokens,
        ...(config.thinkingLevelMap ? { thinkingLevelMap: config.thinkingLevelMap } : {}),
        cost: config.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    await runtime.refresh({ allowNetwork: false });
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    return new SessionPool(options, runtime);
  }

  constructor(options, runtime) {
    this.options = options;
    this.root = resolve(options.root);
    this.runtime = runtime;
    this.records = new Map();
    this.opening = new Map();
    this.closed = false;
  }

  redact(text) {
    let redacted = String(text);
    for (const secret of [this.options.modelConfig.apiKey, ...(this.options.toolSecrets ?? [])]) {
      if (typeof secret === "string" && secret) redacted = redacted.split(secret).join("[redacted]");
    }
    return redacted;
  }

  emit(record, event) {
    const payload = { agentId: record.id, role: record.role, timestamp: Date.now(), ...event };
    try {
      Promise.resolve(this.options.onEvent?.(payload)).catch((error) => {
        record.lastError = this.redact(error.message);
      });
    } catch (error) { record.lastError = this.redact(error.message); }
  }

  journal(record, event) {
    appendFileSync(record.journal, JSON.stringify({ timestamp: Date.now(), ...event }) + "\n", { mode: 0o600 });
  }

  prune(record) {
    while (record.completedCalls.length - record.completedStart > MAX_COMPLETED_CALLS) {
      const callId = record.completedCalls[record.completedStart];
      const completed = record.calls.get(callId);
      // latestOutput has its own reference; it must not pin the completed-call window.
      if (completed?.type === "tool_end") record.calls.delete(callId);
      record.completedStart += 1;
    }
    if (record.completedStart > MAX_COMPLETED_CALLS * 2) {
      record.completedCalls = record.completedCalls.slice(record.completedStart);
      record.completedStart = 0;
    }
    while (record.consumed.size > MAX_CONSUMED_NOTIFICATIONS) {
      record.consumed.delete(record.consumed.values().next().value);
    }
  }

  async ensure(id, role = "worker") {
    if (this.closed || this.closing) throw new Error("Session pool is closed");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !["lead", "worker", "probe"].includes(role)) {
      throw new Error("Invalid Agent identity");
    }
    if (this.records.has(id)) {
      if (this.records.get(id).role !== role) throw new Error("Agent role cannot change");
      return this.describe(this.records.get(id));
    }
    if (this.opening.has(id)) {
      const existing = await this.opening.get(id);
      if (existing.role !== role) throw new Error("Agent role cannot change");
      return existing;
    }
    const opening = this.open(id, role);
    this.opening.set(id, opening);
    try { return await opening; }
    finally { this.opening.delete(id); }
  }

  async open(id, role) {
    const directory = join(this.root, "sessions", id);
    const cwd = join(this.root, "work", id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const record = { id, role, directory, cwd, journal: join(directory, "events.jsonl"),
      calls: new Map(), pending: new Map(), queued: new Set(), consumed: new Set(), versions: new Map(),
      models: 0, tools: 0, jobs: new Set(), requests: 0, lastError: null, responseContexts: new Map() };
    record.completedCalls = [];
    record.completedStart = 0;
    record.latestOutput = null;
    for (const event of readJournal(record.journal)) {
      if (event.type === "identity" && event.role !== role) throw new Error("Persisted Agent role differs");
      if (event.type === "tool_start") record.calls.set(event.call_id, event);
      if (event.type === "tool_end") {
        record.calls.set(event.call_id, event);
        record.completedCalls.push(event.call_id);
        if (typeof event.result?.details?.output_path === "string") record.latestOutput = event;
      }
      if (event.type === "notification") {
        record.pending.set(event.eventId, event);
        record.versions.set(event.scope, Math.max(record.versions.get(event.scope) ?? -1, event.version));
      }
    }
    this.journal(record, { type: "identity", role });
    const manager = SessionManager.open(join(directory, "session.jsonl"), directory, cwd);
    record.unresolved = recoverToolResults(manager, record.calls);
    this.prune(record);
    for (const entry of manager.getEntries()) if (entry.type === "custom_message" && entry.customType === "ctf.notice") {
      record.consumed.add(entry.details?.eventId);
    }
    for (const id of record.consumed) record.pending.delete(id);
    for (const value of record.calls.values()) if (value.type === "tool_start"
      && !record.unresolved.some((item) => item.call_id === value.call_id)) {
      record.unresolved.push({ call_id: value.call_id, tool: value.tool, context: value.context, outcome: "unknown" });
    }
    record.local = createLocalTools({ cwd, outputDir: join(directory, "tool-output"), env: this.options.toolEnv,
      secrets: [this.options.modelConfig.apiKey, ...(this.options.toolSecrets ?? [])] });
    record.recoveredProcesses = await record.local.recover();
    const definitions = role === "probe"
      ? []
      : [...record.local.tools, ...(await this.options.toolsForRole?.(role, id) ?? [])];
    if (new Set(definitions.map((tool) => tool.name)).size !== definitions.length) throw new Error("Duplicate tool names");
    const customTools = definitions.map((tool) => ({
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
      execute: (callId, args, signal, onUpdate) => this.execute(record, tool, callId, args, signal, onUpdate),
    }));
    const settings = SettingsManager.inMemory({ cacheWarming: "off",
      compaction: compactionSettings(this.options.modelConfig.contextWindow),
      ...(this.options.retry ? { retry: this.options.retry } : {}) }, { projectTrusted: false });
    const { session } = await createAgentSession({ cwd, agentDir: join(directory, "agent"),
      modelRuntime: this.runtime, model: this.runtime.getModel(this.options.modelConfig.provider, this.options.modelConfig.id),
      thinkingLevel: this.options.modelConfig.thinkingLevel ?? "off", sessionManager: manager,
      settingsManager: settings, noTools: "builtin", tools: customTools.map((tool) => tool.name), customTools,
      resourceLoader: resourceLoader(rolePrompt({ role, agentId: id, cwd, toolSummary: this.options.toolSummary })),
    });
    record.session = session;
    session.agent.toolExecution = "sequential";
    const previousTransform = session.agent.transformContext;
    session.agent.transformContext = async (messages, signal) => {
      const current = await this.options.getContext?.(record.id);
      const fresh = messages.filter((message) => message.role !== "custom" || message.customType !== "ctf.notice"
        || (message.details.version >= (record.versions.get(message.details.scope) ?? -1)
          && (record.role === "lead" || !Object.hasOwn(message.details, "assignmentId")
            || message.details.assignmentId === (current?.assignment_id ?? null))));
      const compacted = compactToolHistory(fresh);
      return previousTransform ? previousTransform(compacted, signal) : compacted;
    };
    const originalStream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => this.stream(record, originalStream, model, context, options);
    session.subscribe((event) => {
      if (event.type === "message_update") {
        const delta = event.assistantMessageEvent;
        if (["text_delta", "thinking_delta", "toolcall_delta"].includes(delta.type)) {
          this.emit(record, { type: "model_delta", kind: delta.type, text: delta.delta,
            contentIndex: delta.contentIndex });
        }
      }
      if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "ctf.notice") {
        const eventId = event.message.details.eventId;
        record.consumed.add(eventId);
        record.pending.delete(eventId);
        record.queued.delete(eventId);
        this.emit(record, { type: "notification_consumed", eventId });
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message;
        this.emit(record, { type: "message", stopReason: message.stopReason, content: message.content,
          usage: message.usage, error: message.errorMessage ? this.redact(message.errorMessage) : undefined });
        if (message.stopReason === "length") {
          record.lastError = `Model output reached maxTokens (${this.options.modelConfig.maxTokens}) before a complete response`;
        } else if (message.stopReason === "error") {
          record.lastError = this.redact(message.errorMessage ?? "Model request failed");
        }
      }
      if (event.type === "agent_settled") {
        this.emit(record, { type: record.lastError ? "error" : "idle", error: record.lastError,
          aborted: event.aborted, settled: true, model_inflight: record.models, tool_inflight: record.tools,
          active_processes: record.local.activeProcesses(), context: clone(record.requestContext) });
      }
    });
    this.records.set(id, record);
    return this.describe(record);
  }

  stream(record, originalStream, model, context, options = {}) {
    const destination = createAssistantMessageEventStream();
    record.models += 1;
    record.requests += 1;
    void (async () => {
      let final;
      try {
        const captured = clone(await this.options.getContext?.(record.id));
        if (record.role === "worker" && captured?.worker_id
          && captured.worker_id !== record.id) {
          throw new Error(`Worker context identity mismatch for ${record.id}`);
        }
        record.requestContext = captured;
        record.responseContexts.clear();
        this.emit(record, { type: "model_start", context: captured });
        const source = await (this.options.streamFunction
          ? this.options.streamFunction(model, context, options, { agentId: record.id, role: record.role, context: captured })
          : originalStream(model, context, options));
        for await (const event of source) {
          const message = event.message ?? event.error;
          if (message?.role === "assistant") for (const part of message.content) {
            if (part.type === "toolCall") record.responseContexts.set(part.id, captured);
          }
          if (event.type === "done" || event.type === "error") final = message;
          destination.push(event);
        }
        final ??= await source.result();
        destination.end(final);
      } catch (error) {
        final = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: options.signal?.aborted ? "aborted" : "error",
          errorMessage: this.redact(error.message), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        destination.push({ type: "error", reason: final.stopReason, error: final });
        destination.end(final);
      } finally {
        record.models -= 1;
        this.emit(record, { type: "model_end", usage: final?.usage, stopReason: final?.stopReason });
      }
    })();
    return destination;
  }

  async execute(record, tool, callId, args, signal, onUpdate) {
    const context = record.responseContexts.get(callId);
    if (!record.responseContexts.has(callId)) throw new Error("Tool call has no model request identity");
    const previous = record.calls.get(callId)
      ?? (record.latestOutput?.call_id === callId ? record.latestOutput : undefined);
    if (previous) {
      if (previous.args_digest !== digest(args) || previous.tool !== tool.name
        || identity(previous.context) !== identity(context)) throw new Error("Tool call identity conflict");
      if (previous.type === "tool_end") return previous.result;
      throw new Error("This tool call has an unknown result after interruption. Reconcile saved evidence before retrying.");
    }
    signal?.throwIfAborted();
    if (tool.local && record.role === "worker") {
      const current = await this.options.getContext?.(record.id);
      if (!context?.assignment_id || identity(context) !== identity(current)) {
        throw new Error("This model response belongs to an earlier assignment. Read the latest task and use the next model turn.");
      }
    }
    const invocation = { call_id: callId, tool: tool.name, args_digest: digest(args), context };
    const started = { type: "tool_start", ...invocation };
    this.journal(record, started);
    record.calls.set(callId, started);
    record.tools += 1;
    this.emit(record, { type: "tool_start", callId, tool: tool.name, context });
    let result;
    try {
      result = resultMessage(await tool.execute(args, { agentId: record.id, role: record.role,
        context: clone(context), signal, callId, onUpdate: (update) => {
          onUpdate?.(update);
          this.emit(record, { type: "tool_progress", callId, tool: tool.name, update });
        } }));
      if (tool.name === "board_read") result = await archiveBoardRead(record, callId, result);
    } catch (error) {
      const details = {};
      for (const [key, value] of Object.entries(error?.details ?? {})) {
        if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
          details[key] = typeof value === "string" ? this.redact(value) : value;
        }
      }
      const failure = {
        code: this.redact(error?.code ?? "tool_error"),
        message: this.redact(error?.message ?? error),
        details,
        ...(typeof error?.outcomeUnknown === "boolean" ? { outcome_unknown: error.outcomeUnknown } : {}),
      };
      result = { ...resultMessage(failure), isError: true };
    } finally {
      record.tools -= 1;
    }
    const completed = { type: "tool_end", ...invocation, result };
    this.journal(record, completed);
    record.calls.set(callId, completed);
    record.completedCalls.push(callId);
    if (typeof result.details?.output_path === "string") record.latestOutput = completed;
    this.prune(record);
    this.emit(record, { type: "tool_end", callId, tool: tool.name, context,
      args_digest: invocation.args_digest, isError: Boolean(result.isError) });
    return result;
  }

  record(id) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown session ${id}`);
    if (this.closed) throw new Error("Session pool is closed");
    return record;
  }

  track(record, promise) {
    record.jobs.add(promise);
    void promise.then(() => record.jobs.delete(promise), (error) => {
      record.jobs.delete(promise);
      record.lastError = this.redact(error.message);
      this.emit(record, { type: "error", error: record.lastError, settled: record.session.isIdle,
        model_inflight: record.models, tool_inflight: record.tools, active_processes: record.local.activeProcesses() });
    });
    return promise;
  }

  prompt(id, text) {
    if (this.closing) throw new Error("Session pool is closing");
    const record = this.record(id);
    record.lastError = null;
    return this.track(record, record.session.prompt(text, { expandPromptTemplates: false, streamingBehavior: "steer" }));
  }

  async notify(id, text, options = {}) {
    if (this.closing) throw new Error("Session pool is closing");
    const {
      eventId = randomUUID(),
      version = 0,
      scope = "global",
      triggerTurn = true,
      deliverAs = "steer",
    } = options;
    const record = this.record(id);
    if (typeof eventId !== "string" || !eventId || !Number.isSafeInteger(version) || version < 0
      || typeof scope !== "string" || typeof text !== "string"
      || typeof triggerTurn !== "boolean" || !["steer", "followUp", "nextTurn"].includes(deliverAs)) {
      throw new Error("Invalid notification");
    }
    if (version < (record.versions.get(scope) ?? -1)) return { delivered: false, stale: true };
    if (record.consumed.has(eventId)) return { delivered: true, consumed: true, duplicate: true };
    if (record.queued.has(eventId)) return { delivered: true, consumed: false, duplicate: true };
    const assignment = Object.hasOwn(options, "assignmentId") ? { assignmentId: options.assignmentId } : {};
    const challenge = Object.hasOwn(options, "challengeId") ? { challengeId: options.challengeId } : {};
    if (Object.hasOwn(assignment, "assignmentId") && assignment.assignmentId !== null
      && typeof assignment.assignmentId !== "string") throw new Error("Invalid notification assignment");
    if (record.role === "worker" && Object.hasOwn(assignment, "assignmentId")
      && assignment.assignmentId !== ((await this.options.getContext?.(id))?.assignment_id ?? null)) {
      return { delivered: false, stale: true };
    }
    let event = record.pending.get(eventId);
    if (event && (event.text !== text || event.version !== version || event.scope !== scope
      || Object.hasOwn(event, "assignmentId") !== Object.hasOwn(assignment, "assignmentId")
      || event.assignmentId !== assignment.assignmentId || event.challengeId !== challenge.challengeId)) throw new Error("Notification identity conflict");
    if (!event) {
      event = { type: "notification", eventId, version, scope, text, ...assignment, ...challenge };
      this.journal(record, event);
      record.pending.set(eventId, event);
    }
    record.versions.set(scope, version);
    record.queued.add(eventId);
    record.lastError = null;
    const work = record.session.sendCustomMessage({ customType: "ctf.notice", content: text, display: true,
      details: { eventId, version, scope, ...assignment, ...challenge } }, { triggerTurn, deliverAs });
    this.track(record, work).catch(error => {
      record.queued.delete(eventId);
      this.emit(record, { type: "notification_delivery_failed", eventId, error: this.redact(error.message) });
    });
    return { delivered: true, consumed: false, eventId };
  }

  async pause(id, text, options = {}) {
    const record = this.record(id);
    const status = this.describe(record);
    if (!status.idle) await this.abort(id);
    return this.notify(id, text, { ...options, triggerTurn: false, deliverAs: "nextTurn" });
  }

  pendingNotifications(id) {
    return [...this.record(id).pending.values()].filter((event) => event.version >=
      (this.record(id).versions.get(event.scope) ?? -1)).map((event) => ({ ...event }));
  }

  latestToolOutput(id) {
    const record = this.record(id);
    const latest = record.latestOutput;
    return latest ? {
      call_id: latest.call_id,
      tool: latest.tool,
      context: clone(latest.context),
      details: clone(latest.result.details),
    } : null;
  }

  async waitIdle(id) {
    const record = this.record(id);
    while (record.jobs.size) await Promise.allSettled([...record.jobs]);
    return this.describe(record);
  }

  async abort(id) {
    const record = this.record(id);
    record.local.abort();
    record.session.clearQueue();
    await record.session.abort();
    await this.waitIdle(id);
    record.queued.clear();
    return this.describe(record);
  }

  describe(record) {
    return { id: record.id, role: record.role, sessionId: record.session?.sessionId,
      cwd: record.cwd, sessionFile: record.session?.sessionManager.getSessionFile(),
      idle: Boolean(record.session?.isIdle) && record.models === 0 && record.tools === 0,
      model_inflight: record.models, tool_inflight: record.tools,
      active_processes: record.local.activeProcesses(), model_requests: record.requests,
      recovered_processes: clone(record.recoveredProcesses),
      error: record.lastError, unresolved: clone(record.unresolved) };
  }

  status() { return [...this.records.values()].map((record) => this.describe(record)); }

  close() {
    this.closing ??= (async () => {
      await Promise.allSettled([...this.opening.values()]);
      await Promise.allSettled([...this.records.keys()].map((id) => this.abort(id)));
      for (const record of this.records.values()) record.session.dispose();
      this.closed = true;
    })();
    return this.closing;
  }

  forceClose() {
    this.closed = true;
    for (const record of this.records.values()) {
      try { record.local.abort(); } catch {}
      try { record.session.clearQueue(); } catch {}
      try { record.session.dispose(); } catch {}
    }
  }
}
