const { open } = require('node:fs/promises');

const MAX_PAYLOAD_BYTES = 61440;
const MAX_FRAME_BYTES = 393216;
const MAX_EVENTS = 16;
const MAX_RECORDING_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = MAX_RECORDING_BYTES * 6 + MAX_FRAME_BYTES;
const MAX_ROWS = 5;

function parseRecording(bytes) {
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('Fixture recording is too large.');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const events = [];
  const drops = { invalid: 0, oversized: 0, capacity: 0 };
  let connection;
  let payloadBytes = 0;
  let lastSequence = 0;
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { drops.oversized++; continue; }
    let message;
    try { message = JSON.parse(line); } catch { drops.invalid++; continue; }
    if (!message || typeof message !== 'object') { drops.invalid++; continue; }
    if (message.type === 'hello') {
      if (connection || message.protocol_version !== 1 || typeof message.connection_id !== 'string' ||
          message.max_payload_bytes !== MAX_PAYLOAD_BYTES || message.max_frame_bytes !== MAX_FRAME_BYTES) {
        throw new Error('Unsupported fixture recording.');
      }
      connection = message.connection_id;
      continue;
    }
    if (message.type !== 'event') continue;
    const raw = message.payload;
    if (typeof raw !== 'string') { drops.invalid++; continue; }
    if (raw.length > MAX_PAYLOAD_BYTES || Buffer.byteLength(raw) > MAX_PAYLOAD_BYTES) {
      drops.oversized++;
      continue;
    }
    if (events.length >= MAX_EVENTS || payloadBytes + Buffer.byteLength(raw) > MAX_RECORDING_BYTES) {
      drops.capacity++;
      continue;
    }
    const boundedText = value => typeof value === 'string' && value.length <= MAX_PAYLOAD_BYTES && value.isWellFormed();
    if (!connection || message.connection_id !== connection || !Number.isSafeInteger(message.sequence) ||
        message.sequence <= lastSequence || !boundedText(message.hook_type) ||
        !(message.session_id === null || boundedText(message.session_id)) ||
        !(message.tool_name === null || boundedText(message.tool_name)) ||
        typeof message.received_at !== 'string' || message.received_at.length > 64 || !/T.*(?:Z|\+00:00)$/.test(message.received_at) ||
        !Number.isFinite(Date.parse(message.received_at)) || !raw.isWellFormed() ||
        Buffer.byteLength(raw) !== message.payload_bytes) {
      drops.invalid++;
      continue;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch { drops.invalid++; continue; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        payload.hook_event_name !== message.hook_type ||
        (typeof payload.session_id === 'string' ? payload.session_id : null) !== message.session_id ||
        (typeof payload.tool_name === 'string' ? payload.tool_name : null) !== message.tool_name) {
      drops.invalid++;
      continue;
    }
    // Iteration also accepts deeply nested JSON without recursive formatting or traversal.
    const pending = [payload];
    let finite = true;
    while (pending.length && finite) {
      const value = pending.pop();
      if (typeof value === 'number') finite = Number.isFinite(value);
      else if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) pending.push(value[key]);
      }
    }
    if (!finite) { drops.invalid++; continue; }
    const preview = [payload.message, payload.tool_input?.command, payload.tool_input?.patch, payload.demo_note]
      .find(value => typeof value === 'string') ?? 'Inspect the complete accepted payload';
    events.push(Object.freeze({
      id: events.length + 1,
      connectionId: connection,
      sequence: message.sequence,
      receivedAt: new Date(message.received_at).toISOString(),
      hook: message.hook_type,
      session: message.session_id,
      tool: message.tool_name,
      bytes: message.payload_bytes,
      preview: preview.slice(0, 180).replace(/\s+/g, ' '),
      text: raw,
    }));
    payloadBytes += message.payload_bytes;
    lastSequence = message.sequence;
  }
  if (!connection) throw new Error('Missing fixture protocol header.');
  return Object.freeze({ events: Object.freeze(events), drops: Object.freeze(drops), payloadBytes });
}

async function loadRecording(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('Fixture recording is too large.');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error('Fixture recording changed while loading.');
    return parseRecording(buffer.subarray(0, length));
  } finally { await file.close(); }
}

function inspect(recording, id, rows) {
  if (!(id === null || Number.isSafeInteger(id)) || !Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) {
    throw new Error('Invalid inspection request.');
  }
  const selected = id === null ? recording.events[Math.min(2, recording.events.length - 1)] :
    recording.events.find(event => event.id === id);
  if (id !== null && !selected) throw new Error('Unknown fixture event.');
  const index = selected ? recording.events.indexOf(selected) : 0;
  const start = Math.max(0, Math.min(index - Math.floor(rows / 2), recording.events.length - rows));
  return {
    selected: selected ?? null,
    rows: recording.events.slice(start, start + rows).map(({ id, receivedAt, hook, session, preview }) => ({
      id, receivedAt, hook: label(hook), session: label(session), preview,
    })),
    total: recording.events.length,
    drops: recording.drops,
  };
}

function label(value) {
  return value && value.length > 160 ? value.slice(0, 159) + '…' : value;
}

module.exports = { MAX_PAYLOAD_BYTES, MAX_FRAME_BYTES, MAX_EVENTS, MAX_RECORDING_BYTES, MAX_SOURCE_BYTES, MAX_ROWS,
  parseRecording, loadRecording, inspect };
