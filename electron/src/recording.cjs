const { open } = require('node:fs/promises');

const { MAX_PAYLOAD_BYTES, MAX_FRAME_BYTES, eventValue } = require('./stream.cjs');
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
    try {
      const event = eventValue(message, connection, lastSequence);
      events.push(Object.freeze({ ...event, id: events.length + 1 }));
      payloadBytes += event.bytes;
      lastSequence = event.sequence;
    } catch { drops.invalid++; }

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
