#!/usr/bin/env python3
"""Recompute observed R11/R12 usage and input-text exposure from raw NDJSON.

Usage: python scripts/recompute-token-cost.py --r11 R11.ndjson --r12 R12.ndjson --out results
No database, previous mapping, network, or tokenizer is required. Output contains
statistics and source identities, never prompt text, commands, or flags. Missing
usage remains unknown. Character exposure is not billed tokens or saved cost.
"""
import argparse
import base64
import collections
import hashlib
import json
from pathlib import Path
import re
import statistics
import zlib

try:
    from orjson import loads
except ImportError:
    loads = json.loads


def text(value):
    if isinstance(value, str):
        return value
    return "\n".join(v.get("text", "") for v in (value or []) if isinstance(v, dict)) if isinstance(value, list) else ""


def embedded(value):
    start = value.find("{")
    try:
        return json.JSONDecoder().raw_decode(value[start:])[0] if start >= 0 else None
    except (ValueError, TypeError):
        return None


def body(record):
    raw = base64.b64decode(record["body"]) if record.get("encoding") == "base64" else record["body"].encode()
    # Streaming gzip recovery also preserves complete frames in interrupted bodies.
    if raw.startswith(b"\x1f\x8b"):
        raw = zlib.decompressobj(31).decompress(raw)
    return raw.decode("utf-8", "replace")


def response(value):
    values = [s[5:].strip() for s in value.splitlines() if s.startswith("data:")] if value.lstrip().startswith(("data:", "event:")) or "\ndata:" in value else [value]
    usage, calls, errors = None, {}, 0
    for value in values:
        if not value or value == "[DONE]":
            continue
        try:
            frame = loads(value)
        except ValueError:
            errors += 1
            continue
        if not isinstance(frame, dict):
            continue
        if frame.get("usage"):
            usage = frame["usage"]
        for choice in frame.get("choices", []):
            delta = choice.get("delta", choice.get("message", {})) or {}
            for position, call in enumerate(delta.get("tool_calls") or []):
                key = (choice.get("index", 0), call.get("index", position))
                current = calls.setdefault(key, {"id": "", "name": "", "arguments": ""})
                current["id"] = call.get("id") or current["id"]
                function = call.get("function") or {}
                current["name"] += function.get("name") or ""
                current["arguments"] += function.get("arguments") or ""
    return usage, calls, errors


def identity(messages, worker, mapping):
    context, evidence = None, "absent"
    for message in messages:
        role = message.get("role")
        if role not in ("user", "tool"):
            continue
        value = embedded(text(message.get("content")))
        if not isinstance(value, dict):
            continue
        challenge, candidate = value.get("challenge"), value.get("context")
        if isinstance(challenge, dict) and challenge.get("id") and challenge.get("unique_code"):
            mapping[challenge["id"]] = (challenge["unique_code"], challenge.get("title"))
        if not isinstance(candidate, dict) and "worker_id" in value and "assignment_id" in value:
            candidate = value
        if isinstance(candidate, dict) and candidate.get("worker_id") == worker and "assignment_id" in candidate:
            context = candidate if candidate.get("assignment_id") else {}
            evidence = role + (":explicit_self_context" if context else ":explicit_idle_assignment_null")
        elif "context" in value and candidate is None and "available" in value:
            context, evidence = {}, role + ":explicit_idle"
        elif role == "user" and "available" in value and not isinstance(challenge, dict) and not isinstance(candidate, dict):
            context, evidence = {}, "user:available_without_assignment"
        elif role == "user" and isinstance(challenge, dict) and challenge.get("id"):
            members = [m for m in challenge.get("members", []) if m.get("worker_id") == worker and m.get("active")]
            if not members:
                for change in value.get("changes", []):
                    data = change.get("data") or {}
                    if isinstance(data, dict) and data.get("id") == challenge["id"]:
                        members += [m for m in data.get("members", []) if m.get("worker_id") == worker and m.get("active")]
            if challenge.get("phase") in ("completed", "deferred", "canceled"):
                context, evidence = {}, "user:inactive_challenge"
            elif members:
                context, evidence = dict(members[-1], challenge_id=challenge["id"]), "user:explicit_self_membership"
            else:
                context, evidence = {"worker_id": worker, "challenge_id": challenge["id"]}, "user:directed_challenge"
    return context, evidence


def atoms(messages, tools):
    result = []
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
    before = after = 0
    for index, message in enumerate(messages):
        role, content = message.get("role", "unknown"), text(message.get("content"))
        refs = [c.get("id") for c in (message.get("tool_calls") or [])] if role == "assistant" else []
        category = {"system": "static_instructions", "developer": "static_instructions", "assistant": "assistant_content"}.get(role, role)
        if role == "tool":
            refs = [message.get("tool_call_id")]
        elif role == "user":
            value = embedded(content)
            category = "user_notice" if isinstance(value, dict) and any(k in value for k in ("context", "challenge", "changes", "available", "worker_id")) else "user_other"
        if content:
            key = hashlib.sha256(content.encode()).hexdigest()
            result.append((category, len(content), (refs[0] or "unknown") + ":" + key if role == "tool" else key, refs))
        reasoning = message.get("reasoning_content")
        if reasoning:
            result.append(("assistant_reasoning", len(reasoning), hashlib.sha256(reasoning.encode()).hexdigest(), refs))
            if index < last_user:
                before += len(reasoning)
            else:
                after += len(reasoning)
        if message.get("tool_calls"):
            arguments = "".join((c.get("function", {}).get("name") or "") + (c.get("function", {}).get("arguments") or "") for c in message["tool_calls"])
            result.append(("assistant_tool_arguments", len(arguments), hashlib.sha256(arguments.encode()).hexdigest(), refs))
    schema = json.dumps(tools, ensure_ascii=False, separators=(",", ":"))
    result.append(("tool_schema", len(schema), hashlib.sha256(schema.encode()).hexdigest(), []))
    return result, before, after


def metrics(rows):
    known = [r["usage"] for r in rows if r["usage"] is not None]
    cached = [u for u in known if "cached_tokens" in u.get("prompt_tokens_details", {})]
    reasoning = [u for u in known if "reasoning_tokens" in u.get("completion_tokens_details", {})]
    result = {"requests": len(rows), "usage_requests": len(known), "missing_usage_requests": len(rows) - len(known)}
    result.update({k: sum(u.get(k, 0) for u in known) for k in ("prompt_tokens", "completion_tokens", "total_tokens")})
    result.update(cache_reported_requests=len(cached), cached_tokens_reported=sum(u["prompt_tokens_details"]["cached_tokens"] for u in cached),
                  uncached_prompt_when_cache_reported=sum(u.get("prompt_tokens", 0) - u["prompt_tokens_details"]["cached_tokens"] for u in cached),
                  prompt_with_unknown_cache_status=sum(u.get("prompt_tokens", 0) for u in known if "cached_tokens" not in u.get("prompt_tokens_details", {})),
                  reasoning_reported_requests=len(reasoning), reasoning_tokens_reported=sum(u["completion_tokens_details"]["reasoning_tokens"] for u in reasoning),
                  reasoning_exceeds_completion_requests=sum(u["completion_tokens_details"]["reasoning_tokens"] > u.get("completion_tokens", 0) for u in reasoning),
                  total_minus_prompt_minus_completion=result["total_tokens"] - result["prompt_tokens"] - result["completion_tokens"])
    for key in ("prompt", "total"):
        result["mean_" + key + "_per_usage_request"] = result[key + "_tokens"] / len(known) if known else None
    result["median_prompt_per_usage_request"] = statistics.median(u.get("prompt_tokens", 0) for u in known) if known else None
    return result


def analyze(path):
    requests, metadata, responses, calls, mapping, runs = {}, {}, {}, {}, {}, {}
    source_hash, source_bytes, non_model, parse_errors = hashlib.sha256(), 0, 0, 0
    with path.open("rb") as stream:
        for line, raw in enumerate(stream, 1):
            source_hash.update(raw); source_bytes += len(raw)
            record = loads(raw)
            kind = record.get("recordType", record.get("type"))
            if kind == "rawModelRequest":
                meta = record["rawModelRequest"]
                metadata[meta["id"]] = meta["receivedAt"]
            elif kind == "run":
                run = record["run"]
                runs[run["challengeId"]] = {"version": run["challengeVersionId"], "state": run["state"], "line": line}
            elif kind == "body":
                event = record["eventId"]
                value = body(record)
                if record["part"] == "request":
                    try:
                        query = loads(value)
                    except ValueError:
                        non_model += 1
                        continue
                    if not isinstance(query, dict) or not query.get("model") or not isinstance(query.get("messages"), list):
                        non_model += 1
                        continue
                    if event in requests:
                        raise ValueError("Duplicate request body identity: " + event)
                    messages = query["messages"]
                    developer = "\n".join(text(m.get("content")) for m in messages if m.get("role") in ("system", "developer"))
                    match = re.search(r"(?:你是 Lead\s+(lead)|你是同级 Worker\s+(worker-\d+))", developer)
                    worker = (match.group(1) or match.group(2)) if match else "unidentified_direct_api"
                    context, evidence = identity(messages, worker, mapping)
                    payload, before, after = atoms(messages, query.get("tools", []))
                    requests[event] = {"event": event, "line": line, "worker": worker, "role": "lead" if worker == "lead" else "worker" if worker.startswith("worker-") else "unidentified_direct_api", "candidate": context, "evidence": evidence, "atoms": payload, "before": before, "after": after}
                elif record["part"] == "response":
                    usage, issued, errors = response(value)
                    responses[event] = usage; parse_errors += errors
                    for (choice, index), call in issued.items():
                        key = call["id"] or f"{event}:{choice}:{index}"
                        if key in calls:
                            raise ValueError("Duplicate issued tool identity: " + key)
                        try:
                            args = loads(call["arguments"])
                        except ValueError:
                            args = {}
                        calls[key] = {"event": event, "name": call["name"], "view": args.get("view", "default") if isinstance(args, dict) else "invalid"}
    ordered = sorted(requests.values(), key=lambda r: (metadata[r["event"]], r["line"]))
    previous = {}
    for row in ordered:
        worker, context = row["worker"], row["candidate"]
        if row["role"] != "worker":
            context, row["evidence"] = {}, "not_worker"
        elif context is None:
            context, row["evidence"] = dict(previous.get(worker, {})), "propagated_previous_identity"
        elif context and not context.get("assignment_id") and previous.get(worker, {}).get("challenge_id") == context.get("challenge_id"):
            context = previous[worker] | context; row["evidence"] += ":assignment_propagated"
        previous[worker] = context or {}
        row["official"], title = mapping.get(context.get("challenge_id"), (None, None))
        row["topic"] = title or ("[Lead]" if row["role"] == "lead" else "[Worker idle/unresolved]" if row["role"] == "worker" else "[Direct API without role]")
        row["usage"] = responses.get(row["event"])
    category_chars, unique_chars, cross_chars, seen = collections.Counter(), collections.Counter(), collections.Counter(), set()
    by_topic_chars = collections.defaultdict(collections.Counter)
    cross_rows = []
    for row in ordered:
        old = 0
        for category, length, key, refs in row["atoms"]:
            output_category = category
            if category == "tool":
                call = calls.get(refs[0], {})
                output_category = "tool:" + call.get("name", "unmatched")
                if call.get("name") == "board_read":
                    output_category += ":" + call["view"]
            category_chars[output_category] += length; by_topic_chars[row["topic"]][output_category] += length
            unique_key = (row["worker"], category, key)
            if unique_key not in seen:
                unique_chars[output_category] += length; seen.add(unique_key)
            origins = [requests[calls[ref]["event"]] for ref in refs if ref in calls and calls[ref]["event"] in requests]
            origins = [src for src in origins if src["worker"] == row["worker"] and src["official"]]
            if row["official"] and origins and all(src["official"] != row["official"] for src in origins):
                cross_chars[output_category] += length; old += length
        if old:
            cross_rows.append(row)
    result = {"source": {"path": str(path), "bytes": source_bytes, "ndjson_sha256": source_hash.hexdigest()}, "runs": runs,
              "totals": metrics(ordered), "non_model_request_bodies": non_model, "response_parse_errors": parse_errors,
              "issued_logical_tools": len(calls), "identity_evidence_counts": dict(collections.Counter(r["evidence"] for r in ordered)),
              "input_chars_by_category": dict(category_chars), "first_seen_input_chars_by_category": dict(unique_chars),
              "strict_cross_challenge_chars_by_category": dict(cross_chars), "strict_cross_challenge_exposed_request_metrics": metrics(cross_rows),
              "reasoning_position": {"before_last_user_chars": sum(r["before"] for r in ordered), "after_last_user_chars": sum(r["after"] for r in ordered)}}
    for field in ("role", "worker", "topic"):
        groups = collections.defaultdict(list)
        for row in ordered:
            groups[row[field]].append(row)
        result["by_" + field] = {key: metrics(rows) for key, rows in sorted(groups.items())}
    result["topic_input_chars"] = {key: dict(value) for key, value in sorted(by_topic_chars.items())}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--r11", type=Path, required=True)
    parser.add_argument("--r12", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    results = {}
    for name, path in (("R11", args.r11), ("R12", args.r12)):
        result = analyze(path)
        results[name] = result
        (args.out / (name.lower() + ".json")).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(name, json.dumps(result["totals"], ensure_ascii=False), flush=True)
    a, b = results["R11"], results["R12"]
    paired = sorted(set(a["runs"]) & set(b["runs"]))
    shared = [key for key in paired if a["runs"][key]["state"] == b["runs"][key]["state"] == "succeeded"]
    decomposition = {}
    n1, n2 = a["totals"]["usage_requests"], b["totals"]["usage_requests"]
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        m1 = a["totals"][key] / n1 if n1 else 0
        m2 = b["totals"][key] / n2 if n2 else 0
        decomposition[key] = {"delta": b["totals"][key] - a["totals"][key], "count_effect_symmetric": (n2 - n1) * (m1 + m2) / 2, "per_request_effect_symmetric": (m2 - m1) * (n1 + n2) / 2}
    topics = [{"title": key, "R11": a["by_topic"].get(key), "R12": b["by_topic"].get(key), "delta_total_tokens": b["by_topic"].get(key, {}).get("total_tokens", 0) - a["by_topic"].get(key, {}).get("total_tokens", 0)} for key in sorted(set(a["by_topic"]) | set(b["by_topic"]))]
    topics.sort(key=lambda row: -row["delta_total_tokens"])
    comparison = {"paired_challenges": len(paired), "same_versions": sum(a["runs"][key]["version"] == b["runs"][key]["version"] for key in paired), "shared_success_count": len(shared), "symmetric_count_mean_decomposition": decomposition, "topic_deltas": topics,
                  "limits": ["Historical runtime code references are not established by this data.", "Missing usage is unknown, not free.", "Character counts describe input exposure, not billed tokens or causal savings.", "Historical reasoning is measured without recommending its removal; provider continuation contracts still apply.", "Topic allocation clears null assignments and available-work notices; idle/unresolved and direct API requests remain separate.", "Cross-topic history is a lower bound requiring observed issued-tool identities; ordinary prose without those identities is excluded."]}
    (args.out / "comparison.json").write_text(json.dumps(comparison, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
