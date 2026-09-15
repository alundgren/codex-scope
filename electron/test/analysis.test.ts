import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { extractCall, sessionEvidence } from "../src/analysis-evidence.ts";
import { SessionAnalysis, parseFindings, exportRecommendations } from "../src/analysis.ts";
import { parseHandoff } from "../src/analysis-cli.ts";
import { ANALYSIS_LIMITS } from "../src/analysis-types.ts";
import type { AnalysisSnapshot } from "../src/analysis-types.ts";
import type { StoredEvent, HistoryStatus } from "../src/types.ts";
const state: HistoryStatus = {
  generation: 1,
  total: 6,
  accepted: 6,
  drops: {},
  first: { id: 1, receivedAt: "now" },
  last: { id: 6, receivedAt: "now" },
};
const event = (
  id: number,
  hook: string,
  input: Record<string, unknown>,
  session = "session-a",
): StoredEvent => ({
  id,
  hook,
  session,
  receivedAt: "2026-09-12T12:00:00Z",
  sequence: id,
  tool: "Bash",
  text: JSON.stringify(input),
  preview: "",
  bytes: 100,
});
const response = (id: number) =>
  event(id, "PostToolUse", {
    model: "model-a",
    turn_id: "turn-a",
    tool_use_id: `call-${id}`,
    tool_name: "Bash",
    tool_input: { command: 'rg -n "timeout" .' },
    tool_response: "café\n",
  });
const snapshot = (): AnalysisSnapshot => ({
  generation: 1,
  session: "session-a",
  createdAt: "now",
  upper: 2,
  calls: [extractCall(response(2))!],
  sampledEvents: 1,
  omittedEvents: 0,
  omittedCalls: 0,
  coverageUnknown: true,
  evictedBeforeSnapshot: 0,
  localDrops: 0,
  collectorDrops: null,
});
const finding = {
  id: "narrow",
  title: "Review current-directory search",
  detail: "The command searches dot; its repository scope is unknown.",
  suggestion: "Try a task directory first.",
  callOrders: [2],
};
const result = () => ({ text: JSON.stringify({ findings: [finding] }), usage: null });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("analysis evidence pairs explicit IDs, isolates full sessions and preserves observed UTF-8 bytes", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE events(id INTEGER PRIMARY KEY, hook TEXT, session TEXT, receivedAt TEXT, tool TEXT, text TEXT)",
  );
  const insert = db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)");
  const post = response(2);
  const before = event(1, "PreToolUse", {
    model: "model-a",
    turn_id: "turn-a",
    tool_use_id: "call-2",
    tool_name: "Bash",
    tool_input: { command: 'rg -n "timeout" .' },
  });
  for (const e of [
    before,
    post,
    event(3, "PostToolUse", { tool_response: "other" }, "session-ab"),
    event(4, "PreToolUse", { tool_input: { command: "missing return" } }),
    event(5, "Stop", { last_assistant_message: "not tool evidence" }),
    event(6, "PostToolUse", { tool_input: {}, tool_response: { content: "unsupported" } }),
  ])
    insert.run(e.id, e.hook, e.session, e.receivedAt, e.tool, e.text);
  const evidence = sessionEvidence(
    db,
    { ...state, drops: { storage: 2, invalid: 1, oversized: 3 } },
    "session-a",
  );
  assert.equal(evidence.localDrops, 6);
  assert.deepEqual(
    evidence.calls.map((c) => c.order),
    [2, 4, 6],
  );
  assert.equal(evidence.calls[0].responseBytes, Buffer.byteLength("café\n"));
  assert.equal(evidence.calls[1].responseBytes, null);
  assert.equal(evidence.calls[2].responseBytes, null);
  assert.equal(evidence.calls[0].actor, null);
  assert.equal(
    (db.prepare("SELECT text FROM events WHERE id=2").get() as { text: string }).text,
    post.text,
  );
  db.close();
});

test("oversized call identities cannot merge distinct pre and post records", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE events(id INTEGER PRIMARY KEY, hook TEXT, session TEXT, receivedAt TEXT, tool TEXT, text TEXT)",
  );
  const insert = db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)");
  for (const [id, hook, suffix] of [
    [1, "PreToolUse", "a"],
    [2, "PostToolUse", "b"],
  ] as const) {
    const e = event(id, hook, {
      turn_id: "same-turn",
      tool_use_id: "x".repeat(1024) + suffix,
      model: "model-" + "x".repeat(1024),
      tool_response: "evidence",
    });
    insert.run(e.id, e.hook, e.session, e.receivedAt, e.tool, e.text);
  }
  const evidence = sessionEvidence(
    db,
    { ...state, last: { id: 2, receivedAt: "now" } },
    "session-a",
  );
  assert.deepEqual(
    evidence.calls.map((call) => call.order),
    [1, 2],
  );
  assert(evidence.calls.every((call) => call.toolUseId === null && call.model === null));
  db.close();
});

test("snapshot limits do not grow with session history and excerpts expose omissions", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE events(id INTEGER PRIMARY KEY, hook TEXT, session TEXT, receivedAt TEXT, tool TEXT, text TEXT); CREATE INDEX sessions ON events(session)",
  );
  const insert = db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)");
  for (let id = 1; id <= 200; id++) {
    const e = event(id, "PostToolUse", {
      tool_input: { command: "x".repeat(2500) },
      tool_response: "é".repeat(2000),
      transcript_path: "/not/read",
    });
    insert.run(e.id, e.hook, e.session, e.receivedAt, e.tool, e.text);
  }
  const evidence = sessionEvidence(
    db,
    { ...state, last: { id: 200, receivedAt: "now" } },
    "session-a",
  );
  assert.equal(evidence.sampledEvents, ANALYSIS_LIMITS.events);
  assert.equal(evidence.omittedEvents, 72);
  assert(evidence.calls.length <= ANALYSIS_LIMITS.calls);
  assert(evidence.omittedCalls > 0);
  assert(Buffer.byteLength(JSON.stringify(evidence)) <= ANALYSIS_LIMITS.snapshotBytes);
  assert(
    evidence.calls.every((c) => c.argumentsOmitted && c.excerptOmitted && c.responseBytes === 4000),
  );
  db.close();
});

test("findings reject invented call references, duplicate IDs, missing evidence and oversized fields", () => {
  assert.equal(parseFindings(result().text, snapshot()).length, 1);
  assert.throws(
    () =>
      parseFindings(JSON.stringify({ findings: [{ ...finding, callOrders: [100] }] }), snapshot()),
    /Finding 1 cites captured call ID 100, which is not in this snapshot/,
  );
  assert.throws(
    () => parseFindings(JSON.stringify({ findings: [finding, finding] }), snapshot()),
    /Finding 2 repeats an earlier finding ID/,
  );
  assert.throws(
    () => parseFindings(JSON.stringify({ findings: [{ ...finding, callOrders: [] }] }), snapshot()),
    /Finding 1 cites no captured calls/,
  );
  assert.throws(
    () =>
      parseFindings(
        JSON.stringify({ findings: [{ ...finding, detail: "x".repeat(2001) }] }),
        snapshot(),
      ),
    /Finding 1's detail exceeds 2000 characters/,
  );
  assert.throws(
    () =>
      parseFindings(
        JSON.stringify({ findings: [{ ...finding, id: "__proto__", callOrders: [999] }] }),
        snapshot(),
      ),
    /Finding 1 has an invalid ID/,
  );
});

test("model runs reuse evidence without rerunning on reads, with separate decisions and bounded retention", async () => {
  let captures = 0,
    executions = 0;
  const analysis = new SessionAnalysis(
    1,
    async () => {
      captures++;
      return snapshot();
    },
    async () => {
      executions++;
      return result();
    },
  );
  const first = (await analysis.start("session-a", "model-a", "low", null)).runs[0].id;
  await tick();
  analysis.decide(first, "narrow", "kept");
  assert.match(exportRecommendations(analysis.get(first)!), /Captured call IDs: 2/);
  const second = (await analysis.start("session-a", "model-b", "low", first)).runs[1].id;
  await tick();
  assert.equal(captures, 1);
  assert.equal(analysis.get(second)!.snapshot, analysis.get(first)!.snapshot);
  assert.deepEqual(analysis.get(second)!.decisions, {});
  analysis.list();
  analysis.get(first);
  analysis.get(second);
  assert.equal(executions, 2);
  await assert.rejects(analysis.start("session-b", "model-b", "low", first));
  for (let n = 0; n < 4; n++) {
    await analysis.start("session-a", "model-a", "low", null);
    await tick();
  }
  assert.equal(analysis.list().runs.length, 4);
  assert.equal(analysis.get(first), null);
  await analysis.close();
});

test("cancellation and clear reject stale completion and prevent overlapping executions", async () => {
  let finish: ((value: ReturnType<typeof result>) => void) | undefined;
  const analysis = new SessionAnalysis(
    1,
    async () => snapshot(),
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await analysis.start("session-a", "model-a", "low", null);
  await assert.rejects(analysis.start("session-a", "model-a", "low", null), /already running/);
  analysis.reset(2);
  assert.equal(analysis.list().runs.length, 0);
  await assert.rejects(analysis.start("session-a", "model-a", "low", null), /already running/);
  finish!(result());
  await tick();
  assert.equal(analysis.list().runs.length, 0);
  assert.equal(analysis.list().activeRunId, null);
  await analysis.close();
});

test("handoff uses the run model and kept findings without recapture, and rejects stale completion", async () => {
  let captures = 0;
  let finish: ((value: ReturnType<typeof result>) => void) | undefined;
  const analysis = new SessionAnalysis(
    1,
    async () => {
      captures++;
      return snapshot();
    },
    async (options) => {
      if (!options.purpose) return result();
      assert.equal(options.model, "original-model");
      assert.match(options.prompt, /Review current-directory search/);
      assert.match(options.prompt, /Captured call IDs: 2/);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  const id = (await analysis.start("session-a", "original-model", "low", null)).runs[0].id;
  await tick();
  await assert.rejects(analysis.handoff(id), /Keep a recommendation/);
  analysis.decide(id, "narrow", "kept");
  const handoff = analysis.handoff(id);
  assert.equal(analysis.list().handoffRunId, id);
  await assert.rejects(analysis.handoff(id), /already running/);
  await assert.rejects(analysis.start("session-a", "other-model", "low", null), /already running/);
  finish!({ text: JSON.stringify({ handoff: "Try a task directory first." }), usage: null });
  assert.match(await handoff, /Session analysis handoff for session-a/);
  assert.equal(captures, 1);
  assert.equal(analysis.get(id)!.state, "completed");
  const stale = analysis.handoff(id);
  analysis.reset(2);
  finish!({ text: JSON.stringify({ handoff: "stale" }), usage: null });
  await assert.rejects(stale, /cancelled/);
  assert.equal(analysis.list().handoffRunId, null);
  await analysis.close();
});

test("handoff output rejects empty, oversized and unexpected fields", () => {
  assert.equal(parseHandoff('{"handoff":"Check the current task."}'), "Check the current task.");
  for (const value of [
    { handoff: "" },
    { handoff: " " },
    { handoff: "x".repeat(12001) },
    { handoff: "valid", extra: true },
    { handoff: 42 },
  ])
    assert.throws(() => parseHandoff(JSON.stringify(value)));
});
