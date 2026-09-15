import { callMetadata } from "./call-metadata.ts";
import { emptySelection } from "./model-types.ts";
import { sessionEvidence } from "./analysis-evidence.ts";
import { prepare, type Statement } from "./database.ts";
import type {
  EventValue,
  StoredEvent,
  EventRow,
  EventPosition,
  HistoryStatus,
  HistoryOptions,
  Faults,
  ConnectionConfig,
  TransportReason,
  WorkerRequest,
  HistoryOperations,
  Reply,
  Inspection,
} from "./types.ts";
import type { LIMITS } from "./history.ts";
import { parentPort, workerData as untypedWorkerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parseRecording, loadRecording, MAX_PAYLOAD_BYTES, MAX_FRAME_BYTES } from "./recording.ts";

import { loadPreferences, savePreferences, validateSettings } from "./preferences.ts";
import { loadConnection } from "./connection.ts";
import { Transport } from "./transport.ts";

import { Search } from "./search.ts";

const workerData = untypedWorkerData as HistoryOptions & {
  limits: typeof LIMITS;
  shared: SharedArrayBuffer;
};
if (!parentPort) throw new Error("History worker requires a parent port.");
const port = parentPort;
const limits = workerData.limits;
const shared = new Int32Array(workerData.shared);
const root = workerData.directory;
const marker = "codex-scope-temporary-recording-v1";
const allowed = new Set([
  "owner.json",
  "history.sqlite",
  "history.sqlite-journal",
  "history.sqlite-wal",
  "history.sqlite-shm",
]);
let transport: Transport | null = null,
  connectionConfig: ConnectionConfig | null = null,
  terminalReason: TransportReason | null = null,
  configError = false;
interface Statements {
  insert: Statement<never>;
  remove: Statement<never>;
  selected: Statement<StoredEvent>;
  newest: Statement<StoredEvent>;
  before: Statement<EventRow>;
  after: Statement<EventRow>;
  oldest: Statement<StoredEvent & { cost: number }>;
  first: Statement<EventPosition>;
  last: Statement<EventPosition>;
}
let database: DatabaseSync | null = null,
  directory: string | null = null;
let statements: Statements | null = null,
  search: Search | null = null;
let timer: NodeJS.Timeout | undefined,
  templates: EventValue[] = [],
  sequence = 0;
let state: HistoryStatus & { retainedBytes: number; evicted: number } = {
  generation: 1,
  total: 0,
  accepted: 0,
  retainedBytes: 0,
  first: null,
  last: null,
  drops: {},
  evicted: 0,
};
let activation = 0;
let diagnosis = emptySelection();
let settingsError: string | undefined;
let settingsSave: HistoryStatus["settingsSave"];
let commandLineOverride = !workerData.optionalConnection;
function settings() {
  return {
    endpoint: connectionConfig?.endpoint ?? "",
    hasToken: !!connectionConfig?.token,
    diagnosis,
    commandLineOverride,
    error: settingsError,
  };
}
function stopInput() {
  activation++;
  state.capturing = false;
  transport?.stop();
  transport = null;
  clearInterval(timer);
  state.transport = {
    state: "disconnected",
    reason: "stopped",
    coverageUnknown: true,
    requests: 0,
    processing: 0,
    retryPending: false,
  };
}
let faults: Faults = {};
let maximumTransactionMs = 0;
let maximumDiskBytes = 0;
let notificationPending = false,
  notificationDirty = false;
const current = (generation: number) =>
  generation === state.generation && generation === Atomics.load(shared, 0);
const increment = (object: Record<string, number>, key: string, amount = 1) => {
  object[key] = Math.min(Number.MAX_SAFE_INTEGER, (object[key] ?? 0) + amount);
};
function notify() {
  if (notificationPending) {
    notificationDirty = true;
    return;
  }
  notificationPending = true;
  notificationDirty = false;
  port.postMessage({ notification: true, status: snapshot() });
}

function snapshot() {
  return { ...state, settingsSave, view: search?.status(), maximumTransactionMs, maximumDiskBytes };
}

function entriesIn(location: string, maximum: number) {
  const handle = fs.opendirSync(location);
  const entries = [];
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (entries.length >= maximum) throw new Error("Cleanup capacity exceeded.");
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  return entries;
}
function removeOwned(location: string, deadline: number) {
  if (faults.cleanup || performance.now() > deadline) throw new Error("Cleanup failed.");
  const info = fs.lstatSync(location);
  if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(location) !== root)
    throw new Error("Unsafe recording directory.");
  const entries = entriesIn(location, allowed.size);
  if (
    entries.some((entry) => !allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())
  )
    throw new Error("Unrecognized recording files.");
  const markerPath = path.join(location, "owner.json");
  if (fs.statSync(markerPath).size > 128 || fs.readFileSync(markerPath, "utf8") !== marker)
    throw new Error("Unrecognized recording owner.");
  for (const entry of entries.filter((entry) => entry.name !== "owner.json")) {
    if (performance.now() > deadline) throw new Error("Cleanup timed out.");
    fs.unlinkSync(path.join(location, entry.name));
  }
  fs.unlinkSync(markerPath);
  fs.rmdirSync(location);
}
function prepareDirectory() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Unsafe recording owner.");
  fs.chmodSync(root, 0o700);
  const deadline = performance.now() + limits.cleanupMs;
  for (const entry of entriesIn(root, 32)) {
    if (
      !/^recording-[0-9a-f-]{36}$/.test(entry.name) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    )
      continue;
    removeOwned(path.join(root, entry.name), deadline);
  }
}
function openDatabase() {
  directory = path.join(root, `recording-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "owner.json"), marker, { mode: 0o600, flag: "wx" });
  const file = path.join(directory, "history.sqlite");
  fs.closeSync(fs.openSync(file, "wx", 0o600));
  database = new DatabaseSync(file, { timeout: 0, allowExtension: false, defensive: true });
  database.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=${limits.databaseBytes / 4096};
    PRAGMA journal_mode=TRUNCATE; PRAGMA journal_size_limit=0; PRAGMA synchronous=OFF;
    PRAGMA cache_size=-${limits.cacheKiB}; PRAGMA mmap_size=0; PRAGMA temp_store=MEMORY;
    PRAGMA hard_heap_limit=${limits.sqliteHeapBytes}; PRAGMA trusted_schema=OFF;
    CREATE TABLE events(id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, connectionId TEXT NOT NULL,
      sequence INTEGER NOT NULL, localReceivedAt TEXT NOT NULL, receivedAt TEXT NOT NULL, hook TEXT NOT NULL,
      session TEXT, tool TEXT, bytes INTEGER NOT NULL, cost INTEGER NOT NULL, preview TEXT NOT NULL, text TEXT NOT NULL, context TEXT, model TEXT, command TEXT, responseBytes INTEGER) STRICT;
    CREATE INDEX event_sessions ON events(session); CREATE INDEX event_context ON events(session, id DESC) WHERE context IS NOT NULL; CREATE INDEX event_hooks ON events(hook); CREATE INDEX event_tools ON events(tool); CREATE INDEX event_models ON events(model); CREATE INDEX event_response ON events(COALESCE(responseBytes,-1) DESC, id DESC);`);
  search = new Search(database, shared);
  const summary =
    "id, receivedAt, substr(hook,1,160) AS hook, substr(session,1,160) AS session, preview";
  statements = {
    insert: prepare<never>(
      database,
      "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ),
    selected: prepare<StoredEvent>(
      database,
      "SELECT * FROM events WHERE id >= ? ORDER BY id LIMIT 1",
    ),
    newest: prepare<StoredEvent>(database, "SELECT * FROM events ORDER BY id DESC LIMIT 1"),
    before: prepare<EventRow>(
      database,
      `SELECT ${summary} FROM events WHERE id < ? ORDER BY id DESC LIMIT ?`,
    ),
    after: prepare<EventRow>(
      database,
      `SELECT ${summary} FROM events WHERE id >= ? ORDER BY id LIMIT ?`,
    ),
    oldest: prepare<StoredEvent & { cost: number }>(
      database,
      "SELECT * FROM events ORDER BY id LIMIT ?",
    ),
    remove: prepare<never>(database, "DELETE FROM events WHERE id <= ?"),
    first: prepare<EventPosition>(database, "SELECT id,receivedAt FROM events ORDER BY id LIMIT 1"),
    last: prepare<EventPosition>(
      database,
      "SELECT id,receivedAt FROM events ORDER BY id DESC LIMIT 1",
    ),
  };
  sequence = 0;
  state = {
    generation: Atomics.load(shared, 0),
    capturing: false,
    synthetic: !!workerData.synthetic,
    transport: state.transport,
    connectionId: randomUUID(),
    total: 0,
    accepted: 0,
    retainedBytes: 0,
    first: null,
    last: null,
    drops: {},
    evicted: 0,
  };
}
function diskBytes() {
  if (!directory) throw new Error("Recording directory is unavailable.");
  const location = directory;
  const size = entriesIn(directory, allowed.size).reduce(
    (sum, entry) => sum + fs.lstatSync(path.join(location, entry.name)).size,
    0,
  );
  maximumDiskBytes = Math.max(maximumDiskBytes, size);
  return size;
}
function hasRoom() {
  if (!directory || faults.disk || diskBytes() > limits.diskBytes) return false;
  const disk = fs.statfsSync(directory);
  return disk.bavail * disk.bsize >= limits.headroomBytes;
}
function appendEvents(events: readonly EventValue[]) {
  if (!database || !statements || !search || !current(state.generation)) return;
  let budget = limits.evictionCount;
  for (const original of events) {
    const event = { ...original, ...callMetadata(original.text) };
    if (!current(state.generation)) break;
    const started = performance.now();
    try {
      if (!hasRoom()) throw new Error("Storage pressure.");
      const cost =
        event.bytes +
        Buffer.byteLength(
          [
            event.hook,
            event.session,
            event.tool,
            event.preview,
            event.context,
            event.model,
            event.command,
            event.connectionId ?? state.connectionId,
          ].join(""),
        ) +
        256;
      if (
        state.total >= limits.retainedCount ||
        state.retainedBytes + cost > limits.retainedBytes
      ) {
        const old = statements.oldest.iterate(budget);
        let removedBytes = 0,
          count = 0,
          last = 0,
          matching = 0,
          removedResponseBytes = 0,
          removedMeasuredCalls = 0;
        for (const row of old) {
          if (
            state.total - count < limits.retainedCount &&
            state.retainedBytes - removedBytes + cost <= limits.retainedBytes
          )
            break;
          removedBytes += row.cost;
          count++;
          last = row.id;
          if (search.removing(row)) {
            matching++;
            if (row.responseBytes != null) {
              removedResponseBytes += row.responseBytes;
              removedMeasuredCalls++;
            }
          }
        }
        if (count) {
          database.exec("BEGIN IMMEDIATE");
          statements.remove.run(last);
          diskBytes();
          database.exec("COMMIT");
          state.total -= count;
          state.retainedBytes -= removedBytes;
          state.evicted += count;
          budget -= count;
          search.removedEvents(matching, last, removedResponseBytes, removedMeasuredCalls);
        }
        if (
          state.total >= limits.retainedCount ||
          state.retainedBytes + cost > limits.retainedBytes
        )
          throw new Error("Cleanup capacity exceeded.");
      }
      if (faults.write) throw new Error("Write failed.");
      const id = state.accepted + 1;
      const localReceivedAt = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      statements.insert.run(
        id,
        state.generation,
        event.connectionId ?? state.connectionId!,
        event.sequence,
        localReceivedAt,
        event.receivedAt,
        event.hook,
        event.session,
        event.tool,
        event.bytes,
        cost,
        event.preview,
        event.text,
        event.context ?? null,
        event.model,
        event.command,
        event.responseBytes,
      );
      diskBytes();
      database.exec("COMMIT");
      state.accepted = id;
      state.total++;
      state.retainedBytes += cost;
      search.accepted({
        ...event,
        id,
        generation: state.generation,
        connectionId: event.connectionId ?? state.connectionId!,
        localReceivedAt,
      });
      state.pressure = false;
    } catch {
      if (database.isTransaction) database.exec("ROLLBACK");
      increment(state.drops, "storage");
      state.pressure = true;
    } finally {
      maximumTransactionMs = Math.max(maximumTransactionMs, performance.now() - started);
    }
  }
  state.first = statements.first.get() ?? null;
  state.last = statements.last.get() ?? null;
  notify();
}
function ingest(frames: string[], connectionId: string | undefined) {
  if (!database || connectionId !== state.connectionId || frames.length > limits.batchCount) return;
  const header = JSON.stringify({
    type: "hello",
    protocol_version: 1,
    connection_id: connectionId,
    max_payload_bytes: MAX_PAYLOAD_BYTES,
    max_frame_bytes: MAX_FRAME_BYTES,
  });
  const events = [];
  for (const frame of frames) {
    if (
      typeof frame !== "string" ||
      !frame.isWellFormed() ||
      frame.includes("\n") ||
      frame.includes("\r")
    ) {
      increment(state.drops, "invalid");
      continue;
    }
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      increment(state.drops, "oversized");
      continue;
    }
    try {
      const parsed = parseRecording(Buffer.from(`${header}\n${frame}\n`));
      for (const [reason, count] of Object.entries(parsed.drops))
        increment(state.drops, reason, count);
      const event = parsed.events[0];
      if (!event) continue;
      if (event.sequence <= sequence) {
        increment(state.drops, "invalid");
        continue;
      }
      sequence = event.sequence;
      events.push(event);
    } catch {
      increment(state.drops, "invalid");
    }
  }
  appendEvents(events);
}
function startInput() {
  stopInput();
  if (!connectionConfig && !workerData.synthetic) configError = true;
  if (configError || terminalReason) {
    state.transport = {
      state: "disconnected",
      reason: terminalReason ?? "config",
      requiresRestart: true,
      coverageUnknown: true,
    };
    return;
  }
  state.capturing = true;
  if (!connectionConfig) {
    state.transport = undefined;
    startSynthetic();
    return;
  }
  const generation = state.generation;
  const active = activation;
  transport = new Transport({
    config: connectionConfig,
    current: () => current(generation) && active === activation,
    onEvent: async (event, active) => {
      if (faults.transportDelay)
        await new Promise((resolve) => setTimeout(resolve, faults.transportDelay));
      if (active() && current(generation) && state.capturing) appendEvents([event]);
    },
    onStatus: (value) => {
      if (current(generation) && active === activation) {
        state.transport = value;
        if (value.requiresRestart) terminalReason = value.reason;
        if (value.connectionId) state.connectionId = value.connectionId;
        notify();
      }
    },
  });
  transport.start();
}
function startSynthetic() {
  if (!workerData.continuous || !templates.length || !database) return;
  timer = setInterval(() => {
    if (!current(state.generation)) return;
    const template = templates[sequence % templates.length];
    appendEvents([{ ...template, sequence: ++sequence, receivedAt: new Date().toISOString() }]);
  }, 1000);
}
function inspect(id: number | null, rows: number): Reply<Inspection> {
  if (
    !(id === null || Number.isSafeInteger(id)) ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > limits.rows
  )
    return { error: "Invalid inspection request." };
  if (!database || !statements) return { ...state, rows: [], selected: null };
  const selected =
    id === null
      ? statements.newest.get()
      : (statements.selected.get(id) ?? statements.newest.get());
  const before = selected ? statements.before.all(selected.id, Math.floor(rows / 2)).reverse() : [];
  const after = selected ? statements.after.all(selected.id, rows - before.length) : [];
  if (selected && before.length + after.length < rows) {
    before.unshift(
      ...statements.before
        .all(before[0]?.id ?? selected.id, rows - before.length - after.length)
        .reverse(),
    );
  }
  return {
    ...state,
    rows: [...before, ...after],
    selected: selected ?? null,
    selectionEvicted: id !== null && selected?.id !== id,
  };
}
function closeDatabase() {
  stopInput();
  if (database) {
    database.close();
    database = null;
    statements = null;
    search = null;
  }
  if (directory) {
    removeOwned(directory, performance.now() + limits.cleanupMs);
    directory = null;
  }
}

port.on("message", async (message: WorkerRequest) => {
  if (message.operation === "ack") {
    notificationPending = false;
    if (notificationDirty) notify();
    return;
  }
  const { request, operation, generation } = message;
  let result: Reply<HistoryOperations[keyof HistoryOperations]["result"]> | undefined;
  try {
    if (operation === "open") {
      prepareDirectory();
      openDatabase();
      if (workerData.connectionFile) {
        try {
          connectionConfig = await loadConnection(
            workerData.connectionFile,
            workerData.optionalConnection,
          );
        } catch {
          configError = true;
        }
      }
      if (workerData.settingsFile) {
        try {
          const saved = await loadPreferences(workerData.settingsFile);
          if (saved) {
            diagnosis = saved.diagnosis;
            if (!commandLineOverride && !workerData.synthetic) {
              connectionConfig = saved.endpoint ? saved : null;
              configError = false;
            }
          }
        } catch {
          settingsError = "Saved settings could not be read. Enter the connection again and save.";
        }
      }
      state.synthetic = !!workerData.synthetic;
      if (workerData.synthetic) {
        const fixture = await loadRecording(workerData.fixture);
        templates = fixture.events.map((event) => ({ ...event, connectionId: undefined }));
        state.drops = { ...fixture.drops };
        appendEvents(templates);
        sequence = Math.max(0, ...templates.map((event) => event.sequence));
      }
      if (workerData.synthetic) startInput();
      else stopInput();
      result = { ok: true };
    } else if (operation === "settings") {
      result = settings();
    } else if (operation === "saveSettings") {
      try {
        const value = validateSettings(message.value, connectionConfig);
        if (!workerData.settingsFile) throw new Error("Settings unavailable");
        if (faults.settingsDelay)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(5000, faults.settingsDelay!)),
          );
        await savePreferences(workerData.settingsFile, value);
        stopInput();
        connectionConfig = value.endpoint ? { endpoint: value.endpoint, token: value.token } : null;
        diagnosis = value.diagnosis;
        configError = false;
        terminalReason = null;
        settingsError = undefined;
        result = settings();
      } catch {
        settingsError =
          "Settings were not saved. Check the origin URL, token, model choices and private settings directory, then try again.";
        result = settings();
      }
      settingsSave = { id: request, result: settings() };
    } else if (operation === "capture") {
      if (message.start) startInput();
      else stopInput();
      result =
        state.capturing || !message.start
          ? { ok: true }
          : { error: "Open Settings and save a valid connection before starting." };
    } else if (operation === "clear" || operation === "close") {
      const resume = state.capturing;
      state = {
        generation,
        synthetic: !!workerData.synthetic,
        retainedBytes: 0,
        evicted: 0,
        total: 0,
        accepted: 0,
        first: null,
        last: null,
        drops: {},
        clearing: true,
        transport:
          connectionConfig || configError
            ? { state: "disconnected", reason: terminalReason, coverageUnknown: true }
            : undefined,
      };
      closeDatabase();
      if (operation === "clear") {
        openDatabase();
        if (resume) startInput();
      }
      result = { ok: true, generation };
    } else if (operation === "test" && workerData.testMode) {
      faults = { ...faults, ...message.faults };
      if (typeof faults.queryOnly === "boolean" && database)
        database.exec(`PRAGMA query_only=${faults.queryOnly ? "ON" : "OFF"}`);
      if (typeof faults.diskFull === "boolean" && database) {
        const pages = faults.diskFull
          ? database.prepare("PRAGMA page_count").get()!.page_count
          : limits.databaseBytes / 4096;
        database.exec(`PRAGMA max_page_count=${Number(pages)}`);
      }
      result = {
        ok: true,
        directory,
        limits,
        ...snapshot(),
        transport: transport?.snapshot() ?? state.transport,
        transportBufferedBytes: transport?.attempt?.response?.readableLength ?? 0,
      };
    } else {
      if (faults.delay && ["inspect", "navigate", "append"].includes(operation))
        await new Promise((resolve) => setTimeout(resolve, faults.delay));
      if (!current(generation)) result = { stale: true };
      else if (operation === "analysis")
        result =
          database && !state.pressure && !state.error
            ? sessionEvidence(database, state, message.session)
            : { error: "Session analysis unavailable while history is under pressure." };
      else if (operation === "inspect") result = inspect(message.id, message.rows);
      else if (operation === "navigate")
        result = search
          ? search.navigate(state, message.query, faults.searchMs)
          : { error: state.error ?? "History is unavailable." };
      else if (operation === "choices")
        result = {
          generation,
          ...search!.choices(message.field, message.cursor, message.direction, message.text),
        };
      else if (operation === "append") {
        ingest(message.frames, message.connectionId);
        result = { ok: true };
      }
    }
  } catch {
    if (operation === "analysis") {
      result = {
        error: "Session evidence could not finish. Try again when capture is quieter.",
        generation,
      };
    } else if (operation === "navigate" || operation === "choices") {
      result = { error: "Search could not finish. Edit the query or Reset filters.", generation };
    } else {
      state.error =
        operation === "clear" || operation === "close"
          ? "Clear failed. Temporary recording files remain. Restart the app to retry cleanup."
          : "The recording could not be opened. Restart the app to try again.";
      state.clearing = false;
      result = { error: state.error, generation };
    }
  }
  port.postMessage({ request, result, status: snapshot() });
});
