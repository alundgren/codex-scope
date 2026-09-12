import type { DatabaseSync } from "node:sqlite";
import type { HistoryStatus, StoredEvent } from "./types.ts";
import type { AnalysisCall, AnalysisSnapshot } from "./analysis-types.ts";
import { ANALYSIS_LIMITS as limits } from "./analysis-types.ts";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function field(value: unknown): string | null {
  return typeof value === "string" && value.length <= limits.fieldChars ? value : null;
}
export function extractCall(event: StoredEvent): AnalysisCall | null {
  if (!["PreToolUse", "PostToolUse"].includes(event.hook)) return null;
  const input = object(JSON.parse(event.text));
  if (!input) return null;
  const args = object(input.tool_input);
  const command = args?.command ?? args?.cmd ?? input.tool_input;
  const original = typeof command === "string" ? command : JSON.stringify(command ?? {});
  const response = input.tool_response;
  // Only complete textual values have a defined text byte count. Structured results stay unknown.
  const text = typeof response === "string" ? response : null;
  return {
    order: event.id,
    receivedAt: event.receivedAt,
    tool: field(input.tool_name) ?? field(event.tool) ?? "Unknown tool",
    command: original.slice(0, limits.fieldChars),
    model: field(input.model),
    actor: field(input.agent_id),
    turn: field(input.turn_id),
    toolUseId: field(input.tool_use_id),
    responseBytes: text === null ? null : Buffer.byteLength(text),
    excerpt: text?.slice(0, limits.excerptChars) ?? "",
    excerptOmitted: text === null || text.length > limits.excerptChars,
    argumentsOmitted: original.length > limits.fieldChars,
  };
}
export function sessionEvidence(
  database: DatabaseSync,
  state: HistoryStatus,
  session: string,
): AnalysisSnapshot {
  const start = performance.now();
  const upper = state.last?.id ?? 0;
  const count = database
    .prepare(
      "SELECT count(*) AS count FROM events WHERE session=? AND id<=? AND hook IN ('PreToolUse','PostToolUse')",
    )
    .get(session, upper) as { count: number };
  const snapshot: AnalysisSnapshot = {
    generation: state.generation,
    session,
    createdAt: new Date().toISOString(),
    upper,
    calls: [],
    sampledEvents: 0,
    omittedEvents: 0,
    omittedCalls: 0,
    coverageUnknown: true,
    evictedBeforeSnapshot: state.evicted ?? 0,
    localDrops: Math.min(
      Number.MAX_SAFE_INTEGER,
      Object.values(state.drops).reduce((total, count) => total + count, 0),
    ),
    collectorDrops: state.transport?.collectorTotals ?? null,
  };
  const posts = new Set<string>();
  const rows = database.prepare(
    "SELECT * FROM events WHERE session=? AND id<=? AND hook IN ('PreToolUse','PostToolUse') ORDER BY id DESC LIMIT ?",
  );
  for (const row of rows.iterate(session, upper, limits.events)) {
    if (performance.now() - start > limits.queryMs)
      throw new Error("Session evidence timed out. Try again when capture is quieter.");
    snapshot.sampledEvents++;
    const event = row as unknown as StoredEvent;
    const call = extractCall(event);
    if (!call) continue;
    const input = object(JSON.parse(event.text));
    const oversizedIdentity = ["turn_id", "tool_use_id", "agent_id", "model", "tool_name"].some(
      (key) =>
        typeof input?.[key] === "string" && (input[key] as string).length > limits.fieldChars,
    );
    const identity =
      !oversizedIdentity && call.toolUseId && call.turn
        ? JSON.stringify([call.turn, call.toolUseId, call.actor, call.model, call.tool])
        : null;
    if (event.hook === "PreToolUse" && identity && posts.has(identity)) continue;
    if (event.hook === "PostToolUse" && identity) posts.add(identity);
    if (snapshot.calls.length >= limits.calls) {
      snapshot.omittedCalls++;
      continue;
    }
    snapshot.calls.push(call);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > limits.snapshotBytes) {
      snapshot.calls.pop();
      snapshot.omittedCalls++;
    }
  }
  snapshot.calls.reverse();
  snapshot.omittedEvents = Math.max(0, count.count - snapshot.sampledEvents);
  return snapshot;
}
