import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import * as recording from "../src/recording.ts";

const fixtures = await readFile(new URL("../fixtures/journal.jsonl", import.meta.url));
const [hello, ...events] = fixtures
  .toString()
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const parse = (messages: unknown[]) =>
  recording.parseRecording(
    Buffer.from(messages.map((message) => JSON.stringify(message)).join("\n")),
  );
const withRaw = (raw: string, sequence = 1) => ({
  ...events[0],
  sequence,
  payload: raw,
  payload_bytes: Buffer.byteLength(raw),
});

test("fixed fixtures retain original text, unknown fields, Unicode, maximum bytes and deep JSON", () => {
  const data = recording.parseRecording(fixtures);
  assert.equal(data.events.length, 5);
  assert.deepEqual(data.drops, { invalid: 0, oversized: 0, capacity: 0 });
  for (let index = 0; index < events.length; index++) {
    assert.equal(data.events[index].text, events[index].payload);
    assert.equal(data.events[index].bytes, Buffer.byteLength(events[index].payload));
  }
  assert.equal(data.events[3].bytes, recording.MAX_PAYLOAD_BYTES);
  assert.ok(data.events[1].text.includes("\r\n\t"));
  assert.ok(data.events[1].text.includes("future_field"));
  assert.ok(data.events[4].text.includes("[".repeat(4000)));
});

test("the independent adapter accepts the shared protocol fixture", async () => {
  const data = recording.parseRecording(
    await readFile(new URL("../../protocol/fixtures/stream.jsonl", import.meta.url)),
  );
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].context, "synthetic-repo · session-labels");
  assert.match(data.events[0].text, /future_field/);
});

test("oversized, byte-mismatched and invalid payloads are dropped whole before retention", () => {
  const tooBig = {
    ...events[3],
    sequence: 1,
    payload: events[3].payload + " ",
    payload_bytes: 61441,
  };
  const badBytes = { ...events[1], sequence: 2, payload_bytes: 1 };
  const malformed = withRaw('{"hook_event_name":', 3);
  const infinity = withRaw(
    '{"hook_event_name":"SessionStart","session_id":"demo-a7","value":1e999}',
    4,
  );
  const mismatch = { ...events[0], sequence: 5, session_id: "wrong" };
  const brokenUnicode = withRaw(
    '{"hook_event_name":"SessionStart","session_id":"demo-a7","value":"\ud800"}',
    6,
  );
  const valid = { ...events[0], sequence: 7 };
  const data = parse([
    hello,
    tooBig,
    badBytes,
    malformed,
    infinity,
    mismatch,
    brokenUnicode,
    valid,
  ]);
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].text, valid.payload);
  assert.deepEqual(data.drops, { invalid: 5, oversized: 1, capacity: 0 });
});

test("source, frame, event count and total payload bytes have independent limits", () => {
  assert.throws(
    () => recording.parseRecording(Buffer.alloc(recording.MAX_SOURCE_BYTES + 1)),
    /too large/,
  );
  const source = Buffer.from(
    JSON.stringify(hello) +
      "\n" +
      "x".repeat(recording.MAX_FRAME_BYTES + 1) +
      "\n" +
      JSON.stringify(events[0]),
  );
  assert.equal(recording.parseRecording(source).drops.oversized, 1);
  const count = parse([
    hello,
    ...Array.from({ length: 20 }, (_, index) => ({ ...events[0], sequence: index + 1 })),
  ]);
  assert.equal(count.events.length, recording.MAX_EVENTS);
  assert.equal(count.drops.capacity, 4);
  const bytes = parse([
    hello,
    ...Array.from({ length: 6 }, (_, index) => ({ ...events[3], sequence: index + 1 })),
  ]);
  assert.equal(bytes.events.length, 4);
  assert.ok(bytes.payloadBytes <= recording.MAX_RECORDING_BYTES);
  assert.equal(bytes.drops.capacity, 2);
});

test("invalid headers, frame UTF-8 and request parameters cannot select payloads", () => {
  assert.throws(() => parse([{ ...hello, protocol_version: 2 }, events[0]]), /Unsupported/);
  assert.throws(() => parse([events[0]]), /Missing/);
  assert.throws(() => recording.parseRecording(Buffer.from([0xff])), /encoded data/);
  const data = recording.parseRecording(fixtures);
  for (const [id, rows] of [
    [0, 5],
    [1, 6],
    [1, 0],
    ["1", 5],
    [{}, 5],
    [1, NaN],
  ]) {
    assert.throws(() => Reflect.apply(recording.inspect, null, [data, id, rows]));
  }
});

test("inspection returns a bounded neighborhood and exactly one original payload", () => {
  const data = recording.parseRecording(fixtures);
  for (const event of data.events) {
    const result = recording.inspect(data, event.id, 3);
    assert.equal(result.selected!.text, event.text);
    assert.equal(result.rows.length, 3);
    assert.ok(result.rows.some((row) => row.id === event.id));
    assert.ok(result.rows.every((row) => !Object.hasOwn(row, "text")));
  }
  assert.equal(recording.inspect(data, null, 5).selected!.id, 3);
  assert.equal(recording.inspect(parse([hello]), null, 3).selected, null);
});

test("long protocol metadata does not discard an otherwise accepted payload", () => {
  const session = "session-".repeat(1000);
  const raw = JSON.stringify({ hook_event_name: "SessionStart", session_id: session });
  const data = parse([hello, { ...withRaw(raw), session_id: session }]);
  assert.equal(data.events.length, 1);
  const result = recording.inspect(data, 1, 3);
  assert.equal(result.selected!.text, raw);
  assert.equal(result.selected!.session, session);
  assert.equal(result.rows[0].session!.length, 160);
  assert.ok(result.rows[0].session!.endsWith("…"));
});

test("compressed synthetic fixtures retain bytes and reject excessive decompression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scope-compressed-fixture-"));
  const file = path.join(root, "journal.jsonl.gz");
  try {
    await writeFile(file, gzipSync(fixtures));
    assert.deepEqual(await recording.loadRecording(file), recording.parseRecording(fixtures));
    await writeFile(file, gzipSync(Buffer.alloc(2 * 1024 * 1024, 32)));
    await assert.rejects(recording.loadRecording(file));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
