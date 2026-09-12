const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { parseRecording, loadRecording, MAX_PAYLOAD_BYTES, MAX_FRAME_BYTES } = require('./recording.cjs');

const { Search } = require('./search.cjs');

const limits = workerData.limits;
const shared = new Int32Array(workerData.shared);
const root = workerData.directory;
const marker = 'codex-scope-temporary-recording-v1';
const allowed = new Set(['owner.json', 'history.sqlite', 'history.sqlite-journal', 'history.sqlite-wal', 'history.sqlite-shm']);
let database, directory, statements, search, timer, templates = [], sequence = 0;
let state = { generation: 1, total: 0, accepted: 0, retainedBytes: 0, first: null, last: null, drops: {}, evicted: 0 };
let faults = {};
let maximumTransactionMs = 0;
let maximumDiskBytes = 0;
let notificationPending = false, notificationDirty = false;
const current = generation => generation === state.generation && generation === Atomics.load(shared, 0);
const increment = (object, key, amount = 1) => { object[key] = Math.min(Number.MAX_SAFE_INTEGER, (object[key] ?? 0) + amount); };
function notify() {
  if (notificationPending) { notificationDirty = true; return; }
  notificationPending = true;
  notificationDirty = false;
  parentPort.postMessage({ notification: true, status: snapshot() });
}

function snapshot() { return { ...state, view: search?.status(), maximumTransactionMs, maximumDiskBytes }; }

function entriesIn(location, maximum) {
  const handle = fs.opendirSync(location);
  const entries = [];
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (entries.length >= maximum) throw new Error('Cleanup capacity exceeded.');
      entries.push(entry);
    }
  } finally { handle.closeSync(); }
  return entries;
}
function removeOwned(location, deadline) {
  if (faults.cleanup || performance.now() > deadline) throw new Error('Cleanup failed.');
  const info = fs.lstatSync(location);
  if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(location) !== root) throw new Error('Unsafe recording directory.');
  const entries = entriesIn(location, allowed.size);
  if (entries.some(entry => !allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())) throw new Error('Unrecognized recording files.');
  const markerPath = path.join(location, 'owner.json');
  if (fs.statSync(markerPath).size > 128 || fs.readFileSync(markerPath, 'utf8') !== marker) throw new Error('Unrecognized recording owner.');
  for (const entry of entries.filter(entry => entry.name !== 'owner.json')) {
    if (performance.now() > deadline) throw new Error('Cleanup timed out.');
    fs.unlinkSync(path.join(location, entry.name));
  }
  fs.unlinkSync(markerPath);
  fs.rmdirSync(location);
}
function prepareDirectory() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe recording owner.');
  fs.chmodSync(root, 0o700);
  const deadline = performance.now() + limits.cleanupMs;
  for (const entry of entriesIn(root, 32)) {
    if (!/^recording-[0-9a-f-]{36}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    removeOwned(path.join(root, entry.name), deadline);
  }
}
function openDatabase() {
  directory = path.join(root, `recording-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'owner.json'), marker, { mode: 0o600, flag: 'wx' });
  const file = path.join(directory, 'history.sqlite');
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  database = new DatabaseSync(file, { timeout: 0, allowExtension: false, defensive: true });
  database.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=${limits.databaseBytes / 4096};
    PRAGMA journal_mode=TRUNCATE; PRAGMA journal_size_limit=0; PRAGMA synchronous=OFF;
    PRAGMA cache_size=-${limits.cacheKiB}; PRAGMA mmap_size=0; PRAGMA temp_store=MEMORY;
    PRAGMA hard_heap_limit=${limits.sqliteHeapBytes}; PRAGMA trusted_schema=OFF;
    CREATE TABLE events(id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, connectionId TEXT NOT NULL,
      sequence INTEGER NOT NULL, localReceivedAt TEXT NOT NULL, receivedAt TEXT NOT NULL, hook TEXT NOT NULL,
      session TEXT, tool TEXT, bytes INTEGER NOT NULL, cost INTEGER NOT NULL, preview TEXT NOT NULL, text TEXT NOT NULL) STRICT;
    CREATE INDEX event_sessions ON events(session); CREATE INDEX event_hooks ON events(hook);`);
  search = new Search(database, shared);
  const summary = 'id, receivedAt, substr(hook,1,160) AS hook, substr(session,1,160) AS session, preview';
  statements = {
    insert: database.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    selected: database.prepare('SELECT * FROM events WHERE id >= ? ORDER BY id LIMIT 1'),
    newest: database.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1'),
    before: database.prepare(`SELECT ${summary} FROM events WHERE id < ? ORDER BY id DESC LIMIT ?`),
    after: database.prepare(`SELECT ${summary} FROM events WHERE id >= ? ORDER BY id LIMIT ?`),
    oldest: database.prepare('SELECT * FROM events ORDER BY id LIMIT ?'),
    remove: database.prepare('DELETE FROM events WHERE id <= ?'),
    first: database.prepare('SELECT id,receivedAt FROM events ORDER BY id LIMIT 1'),
    last: database.prepare('SELECT id,receivedAt FROM events ORDER BY id DESC LIMIT 1'),
  };
  sequence = 0;
  state = { generation: Atomics.load(shared, 0), connectionId: randomUUID(), total: 0, accepted: 0,
    retainedBytes: 0, first: null, last: null, drops: {}, evicted: 0 };
}
function diskBytes() {
  const size = entriesIn(directory, allowed.size).reduce((sum, entry) => sum + fs.lstatSync(path.join(directory, entry.name)).size, 0);
  maximumDiskBytes = Math.max(maximumDiskBytes, size);
  return size;
}
function hasRoom() {
  if (faults.disk || diskBytes() > limits.diskBytes) return false;
  const disk = fs.statfsSync(directory);
  return disk.bavail * disk.bsize >= limits.headroomBytes;
}
function appendEvents(events) {
  if (!database || !current(state.generation)) return;
  let budget = limits.evictionCount;
  for (const event of events) {
    if (!current(state.generation)) break;
    const started = performance.now();
    try {
      if (!hasRoom()) throw new Error('Storage pressure.');
      const cost = event.bytes + Buffer.byteLength([event.hook, event.session, event.tool, event.preview, state.connectionId].join('')) + 256;
      if (state.total >= limits.retainedCount || state.retainedBytes + cost > limits.retainedBytes) {
        const old = statements.oldest.iterate(budget);
        let removedBytes = 0, count = 0, last = 0, matching = 0;
        for (const row of old) {
          if (state.total - count < limits.retainedCount && state.retainedBytes - removedBytes + cost <= limits.retainedBytes) break;
          removedBytes += row.cost; count++; last = row.id; matching += search.removing(row);
        }
        if (count) {
          database.exec('BEGIN IMMEDIATE');
          statements.remove.run(last);
          diskBytes();
          database.exec('COMMIT');
          state.total -= count; state.retainedBytes -= removedBytes; state.evicted += count; budget -= count;
          search.removedEvents(matching, last);
        }
        if (state.total >= limits.retainedCount || state.retainedBytes + cost > limits.retainedBytes) throw new Error('Cleanup capacity exceeded.');
      }
      if (faults.write) throw new Error('Write failed.');
      const id = state.accepted + 1;
      const localReceivedAt = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      statements.insert.run(id, state.generation, state.connectionId, event.sequence, localReceivedAt,
        event.receivedAt, event.hook, event.session, event.tool, event.bytes, cost, event.preview, event.text);
      diskBytes();
      database.exec('COMMIT');
      state.accepted = id;
      state.total++;
      state.retainedBytes += cost;
      search.accepted({ ...event, id, generation: state.generation, connectionId: state.connectionId, localReceivedAt });
      state.pressure = false;
    } catch {
      if (database.isTransaction) database.exec('ROLLBACK');
      increment(state.drops, 'storage');
      state.pressure = true;
    } finally { maximumTransactionMs = Math.max(maximumTransactionMs, performance.now() - started); }
  }
  state.first = statements.first.get() ?? null;
  state.last = statements.last.get() ?? null;
  notify();
}
function ingest(frames, connectionId) {
  if (!database || connectionId !== state.connectionId || frames.length > limits.batchCount) return;
  const header = JSON.stringify({ type: 'hello', protocol_version: 1, connection_id: connectionId,
    max_payload_bytes: MAX_PAYLOAD_BYTES, max_frame_bytes: MAX_FRAME_BYTES });
  const events = [];
  for (const frame of frames) {
    if (typeof frame !== 'string' || !frame.isWellFormed() || frame.includes('\n') || frame.includes('\r')) { increment(state.drops, 'invalid'); continue; }
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) { increment(state.drops, 'oversized'); continue; }
    try {
      const parsed = parseRecording(Buffer.from(`${header}\n${frame}\n`));
      for (const [reason, count] of Object.entries(parsed.drops)) increment(state.drops, reason, count);
      const event = parsed.events[0];
      if (!event) continue;
      if (event.sequence <= sequence) { increment(state.drops, 'invalid'); continue; }
      sequence = event.sequence;
      events.push(event);
    } catch { increment(state.drops, 'invalid'); }
  }
  appendEvents(events);
}
function startSynthetic() {
  if (!workerData.continuous || !templates.length || !database) return;
  timer = setInterval(() => {
    if (!current(state.generation)) return;
    const template = templates[sequence % templates.length];
    appendEvents([{ ...template, sequence: ++sequence, receivedAt: new Date().toISOString() }]);
  }, 1000);
}
function inspect(id, rows) {
  if (!(id === null || Number.isSafeInteger(id)) || !Number.isInteger(rows) || rows < 1 || rows > limits.rows) return { error: 'Invalid inspection request.' };
  if (!database) return { ...state, rows: [], selected: null };
  const selected = id === null ? statements.newest.get() : statements.selected.get(id) ?? statements.newest.get();
  const before = selected ? statements.before.all(selected.id, Math.floor(rows / 2)).reverse() : [];
  const after = selected ? statements.after.all(selected.id, rows - before.length) : [];
  if (selected && before.length + after.length < rows) {
    before.unshift(...statements.before.all(before[0]?.id ?? selected.id, rows - before.length - after.length).reverse());
  }
  return { ...state, rows: [...before, ...after], selected: selected ?? null,
    selectionEvicted: id !== null && selected?.id !== id };
}
function closeDatabase() {
  clearInterval(timer);
  if (database) { database.close(); database = null; statements = null; search = null; }
  if (directory) { removeOwned(directory, performance.now() + limits.cleanupMs); directory = null; }
}

parentPort.on('message', async message => {
  const { request, operation, generation } = message;
  if (operation === 'ack') { notificationPending = false; if (notificationDirty) notify(); return; }
  let result;
  try {
    if (operation === 'open') {
      prepareDirectory();
      openDatabase();
      const fixture = await loadRecording(workerData.fixture);
      templates = fixture.events;
      state.drops = { ...fixture.drops };
      appendEvents(templates);
      sequence = Math.max(0, ...templates.map(event => event.sequence));
      startSynthetic();
      result = { ok: true };
    } else if (operation === 'clear' || operation === 'close') {
      state = { generation, total: 0, accepted: 0, first: null, last: null, drops: {}, clearing: true };
      closeDatabase();
      if (operation === 'clear') { openDatabase(); startSynthetic(); }
      result = { ok: true, generation };
    } else if (operation === 'test' && workerData.testMode) {
      faults = { ...faults, ...message.faults };
      if (typeof faults.queryOnly === 'boolean' && database) database.exec(`PRAGMA query_only=${faults.queryOnly ? 'ON' : 'OFF'}`);
      if (typeof faults.diskFull === 'boolean' && database) {
        const pages = faults.diskFull ? database.prepare('PRAGMA page_count').get().page_count : limits.databaseBytes / 4096;
        database.exec(`PRAGMA max_page_count=${pages}`);
      }
      result = { ok: true, directory, limits, ...snapshot() };
    } else {
      if (faults.delay && ['inspect', 'navigate', 'append'].includes(operation)) await new Promise(resolve => setTimeout(resolve, faults.delay));
      if (!current(generation)) result = { stale: true };
      else if (operation === 'inspect') result = inspect(message.id, message.rows);
      else if (operation === 'navigate') result = search ? search.navigate(state, message.query, faults.searchMs) : { error: state.error ?? 'History is unavailable.' };
      else if (operation === 'choices') result = { generation, ...search.choices(message.field, message.cursor, message.direction) };
      else if (operation === 'append') { ingest(message.frames, message.connectionId); result = { ok: true }; }
    }
  } catch {
    if (operation === 'navigate' || operation === 'choices') {
      result = { error: 'Search could not finish. Edit the query or Reset filters.', generation };
    } else {
    state.error = operation === 'clear' || operation === 'close' ?
      'Clear failed. Temporary recording files remain. Restart the app to retry cleanup.' :
      'The synthetic recording could not be opened. Restart the app to try again.';
    state.clearing = false;
    result = { error: state.error, generation };
    }
  }
  parentPort.postMessage({ request, result, status: snapshot() });
});
