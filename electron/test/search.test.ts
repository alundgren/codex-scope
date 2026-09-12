import type { Filter, NavigationTarget, Reply, Navigation } from "../src/types.ts";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Search, matches, validNavigation } from "../src/search.ts";

const filter = (text = "", session: string | null = null, hooks: string[] = []) => ({
  text,
  session,
  hooks,
});
function succeeded(result: Reply<Navigation>): Navigation {
  assert("rows" in result);
  return result;
}
function setup() {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY, receivedAt TEXT, localReceivedAt TEXT, connectionId TEXT,
    sequence INTEGER, hook TEXT, session TEXT, tool TEXT, bytes INTEGER, preview TEXT, text TEXT, context TEXT)`);
  const insert = database.prepare(
    "INSERT INTO events(id,receivedAt,localReceivedAt,connectionId,sequence,hook,session,tool,bytes,preview,text) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  const events = [
    {
      id: 1,
      hook: "PreToolUse",
      session: "same-prefix-a",
      tool: "test_tool",
      text: `${"x".repeat(300)} CAFÉ [a.*]%_`,
    },
    {
      id: 2,
      hook: "PostToolUse",
      session: "same-prefix-b",
      tool: "test_tool",
      text: "second match",
    },
    { id: 3, hook: "Stop", session: "same-prefix-a", tool: null, text: "third match" },
    { id: 4, hook: "PreToolUse", session: "same-prefix-a", tool: null, text: "last match" },
  ].map((event) => ({
    ...event,
    receivedAt: "2026-09-11T14:00:00.000Z",
    localReceivedAt: "2026-09-11T15:00:00.000Z",
    connectionId: "connection-fixture",
    sequence: event.id,
    bytes: Buffer.byteLength(event.text),
    preview: event.text.slice(0, 180),
  }));
  for (const event of events)
    insert.run(
      event.id,
      event.receivedAt,
      event.localReceivedAt,
      event.connectionId,
      event.sequence,
      event.hook,
      event.session,
      event.tool,
      event.bytes,
      event.preview,
      event.text,
    );
  const shared = new Int32Array(new SharedArrayBuffer(8));
  shared[0] = 1;
  const search = new Search(database, shared);
  const state = {
    generation: 1,
    accepted: 4,
    total: 4,
    drops: {},
    first: { id: 1, receivedAt: events[0].receivedAt },
    last: { id: 4, receivedAt: events[3].receivedAt },
  };
  let targetId = 0;
  const query = (
    filter: Filter,
    target: NavigationTarget = { kind: "live" },
    queryId = ++targetId,
    timeout?: number,
  ) => {
    shared[1] = ++targetId;
    return search.navigate(state, { queryId, targetId, filter, target, rows: 3 }, timeout);
  };
  return { database, shared, search, state, events, query };
}

test("literal full text and all searchable metadata use identical retained and arrival matching", () => {
  const x = setup();
  try {
    for (const text of [
      "café [a.*]%_",
      "test_tool",
      "same-prefix-a",
      "2026-09-11t15",
      "connection-fixture",
    ]) {
      const result = succeeded(x.query(filter(text)));
      const expected = x.events.filter((event) => matches(event, filter(text)));
      assert.equal(result.view.count, expected.length, text);
      const before = x.search.status().arrivals;
      for (const event of x.events) x.search.accepted(event);
      assert.equal(x.search.status().arrivals - before, expected.length, text);
    }
    assert.equal(succeeded(x.query(filter("^.*$"))).view.count, 0);
    assert.equal(
      succeeded(x.query(filter("", "same-prefix-a", ["PreToolUse", "Stop"]))).view.count,
      3,
    );
    assert.equal(
      succeeded(x.query(filter("", "same-prefix-b", ["PreToolUse", "Stop"]))).view.count,
      0,
    );
  } finally {
    x.database.close();
  }
});

test("selection uses nearest matching recording ID and frozen ranks reject eviction", () => {
  const x = setup();
  try {
    const selected = succeeded(
      x.query(filter("", null, ["PreToolUse"]), { kind: "select", id: 3 }, 1),
    );
    assert.equal(selected.selected!.id, 4);
    assert.equal(selected.position, 1);
    const first = succeeded(
      x.query(filter(), { kind: "rank", rank: 0, snapshot: selected.snapshot }, 1),
    );
    assert.equal(first.selected!.id, 1);
    x.search.removedEvents(1);
    assert.equal(
      x.query(filter(), { kind: "rank", rank: 0, snapshot: selected.snapshot }, 1).snapshotLost,
      true,
    );
  } finally {
    x.database.close();
  }
});

test("deadlines and canceled targets stop scans and a fresh query recovers", () => {
  const x = setup();
  try {
    assert.equal(x.query(filter("missing"), { kind: "live" }, 1, 0).timedOut, true);
    assert.equal(succeeded(x.query(filter("match"))).view.count, 3);
    const stopped = x.search.navigate(x.state, {
      queryId: 10,
      targetId: 1,
      filter: filter(),
      target: { kind: "live" },
      rows: 3,
    });
    assert.equal(stopped.stale, true);
    assert.equal(succeeded(x.query(filter())).view.count, 4);
    assert.equal(
      validNavigation(
        {
          queryId: 1,
          targetId: 1,
          filter: filter("a".repeat(513)),
          target: { kind: "live" },
          rows: 3,
        },
        5,
      ),
      false,
    );
  } finally {
    x.database.close();
  }
});

test("cancellation interrupts a running SQLite scan without retaining its results", async () => {
  const { Worker } = await import("node:worker_threads");
  const x = setup();
  const control = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `const {workerData,parentPort}=require('node:worker_threads');
    const query=new Int32Array(workerData.query), control=new Int32Array(workerData.control);
    parentPort.postMessage('ready');
    Atomics.wait(control,0,0);
    setTimeout(()=>{Atomics.store(query,1,2000);parentPort.postMessage('canceled');},5);`,
    { eval: true, workerData: { query: x.shared.buffer, control: control.buffer } },
  );
  try {
    await new Promise((resolve) => worker.once("message", resolve));
    const insert = x.database.prepare(
      "INSERT INTO events SELECT ?,receivedAt,localReceivedAt,connectionId,sequence,hook,session,tool,bytes,preview,?,context FROM events WHERE id=1",
    );
    for (let id = 5; id <= 10000; id++) insert.run(id, "x".repeat(500));
    x.state.last.id = 10000;
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    const result = x.query(filter("missing"), { kind: "live" }, 50);
    assert.equal(result.stale, true);
    assert.equal("rows" in result ? result.rows : undefined, undefined);
    assert.equal(x.search.status().canceled, 1);
  } finally {
    await worker.terminate();
    x.database.close();
  }
});

test("session labels follow latest retained context while identity and paging stay stable", () => {
  const x = setup();
  try {
    x.database.prepare("UPDATE events SET context = ? WHERE id = ?").run("repo · temporary", 1);
    let page = x.search.choices("session", null, "next");
    assert.deepEqual(page.values, ["same-prefix-a", "same-prefix-b"]);
    assert.equal(page.labels?.[0], "repo · temporary · …prefix-a");
    x.database.prepare("UPDATE events SET context = ? WHERE id = ?").run("repo · renamed", 3);
    page = x.search.choices("session", null, "next");
    assert.equal(page.labels?.[0], "repo · renamed · …prefix-a");
    assert.equal(succeeded(x.query(filter("", "same-prefix-a"))).view.count, 3);
    const previous = x.search.choices("session", "same-prefix-b", "previous");
    assert.deepEqual(previous.labels, ["repo · renamed · …prefix-a"]);
    x.database.exec("DELETE FROM events WHERE id IN (1,3)");
    assert.equal(x.search.choices("session", null, "next").labels?.[0], null);
  } finally {
    x.database.close();
  }
});

test("colliding short labels display full IDs and stay inside the choice byte limit", () => {
  const x = setup();
  try {
    x.database.exec(
      "UPDATE events SET session = 'first-12345678', context = 'repo · branch' WHERE session = 'same-prefix-a'; UPDATE events SET session = 'second-12345678', context = 'repo · branch' WHERE session = 'same-prefix-b'",
    );
    const page = x.search.choices("session", null, "next");
    assert.deepEqual(page.labels, [null, null]);
    assert(Buffer.byteLength([...page.values, ...(page.labels ?? [])].join("")) <= 128 * 1024);
  } finally {
    x.database.close();
  }
});
