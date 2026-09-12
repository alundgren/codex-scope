import type { EventValue, TransportStatus } from "../src/types.ts";
import type { AddressInfo } from "node:net";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { StreamParser } from "../src/stream.ts";
import { Transport, TRANSPORT_LIMITS } from "../src/transport.ts";
import { origin, loadConnection } from "../src/connection.ts";
import {
  fakeCollector,
  fixtureHello,
  fixtureEvent,
  fixtureHealth,
  wait,
  until,
} from "./fake-collector.ts";
const wire = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const parse = (messages: unknown[]) => {
  const parser = new StreamParser();
  return [...parser.push(Buffer.concat(messages.map(wire)))];
};
function transport(
  server: { endpoint: string },
  extra: Partial<ConstructorParameters<typeof Transport>[0]> = {},
) {
  const events: EventValue[] = [],
    states: TransportStatus[] = [];
  const client = new Transport({
    config: { endpoint: server.endpoint, token: "synthetic-test-token" },
    current: () => true,
    onEvent: async (event) => {
      events.push(event);
    },
    onStatus: (value) => {
      states.push(value);
      if (states.length > 100) states.shift();
    },
    ...extra,
  });
  client.start();
  return { client, events, states };
}
function event(message: ReturnType<typeof parse>[number]) {
  assert(message.type === "event");
  return message.event;
}
test("every byte split, bytewise UTF-8, combined frames, exact original bytes and unknown fields/types", () => {
  const payload =
    ' {"hook_event_name":"PreToolUse","session_id":"synthetic-session-a","tool_name":"Bash","future":{"text":"🌿 é 日本語"}} \r\n';
  const frameEvent = { ...fixtureEvent, payload, payload_bytes: Buffer.byteLength(payload) };
  const bytes = Buffer.concat(
    [fixtureHello, frameEvent, { type: "future", data: { nested: true } }, fixtureHealth].map(wire),
  );
  for (let split = 0; split <= bytes.length; split++) {
    const parser = new StreamParser();
    const result = [
      ...parser.push(bytes.subarray(0, split)),
      ...parser.push(bytes.subarray(split)),
    ];
    parser.end();
    assert.deepEqual(Buffer.from(event(result[1]).text), Buffer.from(payload));
    assert.equal(result.length, 4);
  }
  const parser = new StreamParser();
  const result = [];
  for (const byte of bytes) result.push(...parser.push(Buffer.from([byte])));
  parser.end();
  assert.equal(event(result[1]).bytes, Buffer.byteLength(payload));
  assert.equal(
    event(parse([fixtureHello, fixtureEvent, { ...fixtureEvent, sequence: 8 }])[2]).sequence,
    8,
  );
});
test("strict hello, IDs, sequence, metadata, payload byte boundaries and malformed frames", () => {
  for (const change of [
    { type: "event" },
    { protocol_version: 2 },
    { connection_id: "not-a-uuid" },
    { heartbeat_interval_ms: 1999 },
    { heartbeat_expiry_ms: 5000 },
    { max_payload_bytes: 61441 },
    { max_frame_bytes: 393215 },
    { loss_before_connection: "none" },
  ])
    assert.throws(() => parse([{ ...fixtureHello, ...change }]));
  for (const change of [
    { connection_id: "other" },
    { sequence: 0 },
    { sequence: -1 },
    { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { payload_bytes: fixtureEvent.payload_bytes - 1 },
    { payload_bytes: "162" },
    { hook_type: null },
    { session_id: undefined },
    { tool_name: undefined },
    { received_at: "2026-02-31T12:00:00Z" },
    { received_at: "2026-01-01" },
    { payload: "\ud800" },
  ])
    assert.throws(() => parse([fixtureHello, { ...fixtureEvent, ...change }]));
  assert.throws(() => parse([fixtureHello, fixtureEvent, fixtureEvent]));
  assert.throws(() => parse([fixtureHello, fixtureHello]));
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null])
    assert.throws(() =>
      parse([
        fixtureHello,
        { ...fixtureHealth, known_drops: { ...fixtureHealth.known_drops, queue: value } },
      ]),
    );
  const prefix = '{"hook_event_name":"PreToolUse","message":"',
    suffix = '"}';
  const payload = prefix + "x".repeat(61440 - prefix.length - suffix.length) + suffix;
  const frameEvent = {
    ...fixtureEvent,
    session_id: null,
    tool_name: null,
    payload,
    payload_bytes: 61440,
  };
  assert.equal(event(parse([fixtureHello, frameEvent])[1]).bytes, 61440);
  assert.throws(() =>
    parse([fixtureHello, { ...frameEvent, payload: payload + " ", payload_bytes: 61441 }]),
  );
  const exact = Buffer.from(JSON.stringify({ type: "future", padding: "" }));
  const frame = Buffer.from(
    JSON.stringify({ type: "future", padding: "x".repeat(393215 - exact.length) }),
  );
  const parser = new StreamParser();
  void [...parser.push(wire(fixtureHello))];
  void [...parser.push(frame)];
  assert.equal(parser.length, 393215);
  void [...parser.push(Buffer.from("\n"))];
  assert.throws(() => [...parser.push(Buffer.alloc(393217, 32))]);
  assert.throws(() => [...new StreamParser().push(Buffer.from([0xff, 10]))]);
  const incomplete = new StreamParser();
  void [...incomplete.push(Buffer.from("{"))];
  assert.throws(() => incomplete.end());
});
test("settings accept only secure origins or literal loopback HTTP, private bounded config/token", async () => {
  for (const value of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://host/path",
    "https://host/..",
    "https://host/%2e",
    "https://host?",
    "https://host#",
    "https://host\\",
    " http://127.0.0.1",
    "http://localhost",
    "file:///tmp/config",
  ])
    assert.throws(() => origin(value));
  assert.equal(origin("https://example.com/"), "https://example.com");
  assert.equal(origin("http://[::1]:2345"), "http://[::1]:2345");
  const root = await mkdtemp("/tmp/scope-config-test-");
  const file = root + "/connection.json",
    token = root + "/token";
  await writeFile(token, "synthetic-test-token\n", { mode: 0o600 });
  await writeFile(file, JSON.stringify({ endpoint: "http://127.0.0.1:1234", tokenFile: token }), {
    mode: 0o600,
  });
  assert.equal((await loadConnection(file))!.token, "synthetic-test-token");
  await chmod(token, 0o644);
  await assert.rejects(loadConnection(file));
  await chmod(token, 0o600);
  await writeFile(token, "x".repeat(258));
  await assert.rejects(loadConnection(file));
});
test("separate heartbeats, reconnect, counter reset and no replay", async () => {
  const server = await fakeCollector(),
    { client, events } = transport(server);
  try {
    await until(() => client.state.state === "connected");
    server.event();
    await until(() => events.length === 1 && server.state.heartbeats >= 1);
    const first = client.state.connectionId;
    server.state.knownDrops.queue = 9;
    await until(() => client.state.collectorTotals?.queue === 9);
    server.disconnect();
    await until(() => client.state.state === "connected" && client.state.connectionId !== first);
    server.state.knownDrops.queue = 0;
    await until(() => client.state.collectorTotals?.queue === 0);
    server.event();
    await until(() => events.length === 2);
    assert.notEqual(events[0].connectionId, events[1].connectionId);
    assert.equal(events[1].sequence, 1);
    assert(
      server.state.requests.every(
        (request) =>
          request.authorization && ["/v1/stream", "/v1/heartbeat"].includes(request.path ?? ""),
      ),
    );
    const streamPort = server.state.requests.find((request) => request.path === "/v1/stream")!.port;
    assert(
      server.state.requests
        .filter((request) => request.path === "/v1/heartbeat")
        .every((request) => request.port !== streamPort),
    );
    assert(server.state.peakSockets <= 2);
    assert.equal(client.state.coverageUnknown, true);
  } finally {
    client.stop();
    await server.close();
  }
});
test("status failures, bad content type/version, connection deadlines, bounded backoff and terminal failures", async () => {
  for (const [options, reason, retry] of [
    [{ status: 401 }, "auth", false],
    [{ status: 409 }, "conflict", true],
    [{ status: 503 }, "busy", true],
    [{ status: 302 }, "endpoint", false],
    [
      { rawHello: JSON.stringify({ ...fixtureHello, protocol_version: 2 }) + "\n" },
      "version",
      false,
    ],
    [{ contentType: "text/html" }, "protocol", true],
    [{ status: 0 }, "disconnected", true],
  ] as const) {
    const server = await fakeCollector(options),
      { client } = transport(server);
    try {
      await until(() => client.state.reason === reason);
      if (retry) await until(() => server.state.streamCount > 1);
      else {
        await wait(800);
        assert.equal(server.state.streamCount, 1);
      }
      assert(client.metrics.attempts < 5);
    } finally {
      client.stop();
      await server.close();
    }
  }
});
test("stalled processing stops renewal and owns one outstanding event until it finishes", async () => {
  const server = await fakeCollector();
  let release!: () => void,
    entered = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { client } = transport(server, {
    onEvent: async () => {
      entered = true;
      await blocked;
    },
  });
  try {
    await until(() => client.state.state === "connected");
    server.event();
    await until(() => entered);
    await until(() => client.state.reason === "stalled", 7000);
    const attempts = client.metrics.attempts,
      heartbeats = server.state.heartbeats;
    await wait(2300);
    assert.equal(server.state.heartbeats, heartbeats);
    assert.equal(client.metrics.attempts, attempts);
    assert(client.metrics.peakProcessing <= 1);
    release();
    await until(() => client.metrics.attempts > attempts);
    assert(client.snapshot().requests <= 2);
  } finally {
    release();
    client.stop();
    await server.close();
  }
});
test("silent streams, stale heartbeats and heartbeat request deadlines terminate intake", async () => {
  for (const options of [{ health: false }, { heartbeatStatus: 409 }, { heartbeatStatus: 0 }]) {
    const server = await fakeCollector(options),
      { client } = transport(server);
    try {
      await until(
        () =>
          client.state.reason ===
          (options.heartbeatStatus === 409
            ? "conflict"
            : options.health === false
              ? "stalled"
              : "disconnected"),
        7000,
      );
      assert(client.metrics.heartbeatRequests <= 2);
    } finally {
      client.stop();
      await server.close();
    }
  }
  assert.equal(TRANSPORT_LIMITS.heartbeatMs, 2000);
  assert(TRANSPORT_LIMITS.maxRetryMs < 10000);
});

test("invalid TLS is rejected without retry or credential delivery", async () => {
  const root = await mkdtemp("/tmp/scope-tls-test-");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      root + "/key",
      "-out",
      root + "/certificate",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  let requests = 0;
  const server = https.createServer(
    { key: await readFile(root + "/key"), cert: await readFile(root + "/certificate") },
    (_request, response) => {
      requests++;
      response.end();
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { client } = transport({
    endpoint: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  try {
    await until(() => client.state.reason === "tls");
    await wait(700);
    assert.equal(client.metrics.attempts, 1);
    assert.equal(requests, 0);
  } finally {
    client.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("fake socket emits each event split and bytewise multibyte text without framing assumptions", async () => {
  const server = await fakeCollector({ health: false }),
    { client, events } = transport(server);
  try {
    await until(() => client.state.state === "connected");
    const payload = ' {"hook_event_name":"PreToolUse","message":"🌿 日本語"} \n';
    const event = {
      ...fixtureEvent,
      session_id: null,
      tool_name: null,
      payload,
      payload_bytes: Buffer.byteLength(payload),
    };
    const representative = wire({
      ...event,
      sequence: 1,
      connection_id: server.state.connectionId,
    });
    for (let split = 0; split <= representative.length; split++) {
      const bytes = wire({
        ...event,
        sequence: split + 1,
        connection_id: server.state.connectionId,
      });
      server.raw(bytes.subarray(0, split));
      await wait(2);
      server.raw(bytes.subarray(split));
    }
    const bytes = wire({
      ...event,
      sequence: representative.length + 2,
      connection_id: server.state.connectionId,
    });
    for (const byte of bytes) {
      server.raw(Buffer.from([byte]));
      await wait(1);
    }
    await until(() => events.length === representative.length + 2);
    assert(events.every((value) => value.text === payload));
    assert(client.metrics.peakFrameBytes <= 393216);
  } finally {
    client.stop();
    await server.close();
  }
});
