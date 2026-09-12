const MAX_PAYLOAD_BYTES = 61440, MAX_FRAME_BYTES = 393216;
const COUNTERS = Object.freeze(['no_viewer', 'invalid', 'oversized', 'rate', 'queue', 'disconnect']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const safe = value => Number.isSafeInteger(value) && value >= 0;
class StreamError extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const reject = () => { throw new StreamError('protocol'); };
function eventValue(message, connection, sequence) {
  const raw = message.payload;
  if (typeof raw !== 'string' || raw.length > MAX_PAYLOAD_BYTES || Buffer.byteLength(raw) > MAX_PAYLOAD_BYTES) reject();
  const text = value => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= MAX_PAYLOAD_BYTES;
  if (message.connection_id !== connection || !safe(message.sequence) || message.sequence <= sequence ||
      !text(message.hook_type) || !(message.session_id === null || text(message.session_id)) ||
      !(message.tool_name === null || text(message.tool_name)) || !raw.isWellFormed() ||
      !safe(message.payload_bytes) || Buffer.byteLength(raw) !== message.payload_bytes ||
      typeof message.received_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(message.received_at)) reject();
  const timestamp = Date.parse(message.received_at);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== message.received_at.slice(0, 19)) reject();
  let payload;
  try { payload = JSON.parse(raw); } catch { reject(); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.hook_event_name !== message.hook_type ||
      (typeof payload.session_id === 'string' ? payload.session_id : null) !== message.session_id ||
      (typeof payload.tool_name === 'string' ? payload.tool_name : null) !== message.tool_name) reject();
  const pending = [payload];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'number' && !Number.isFinite(value)) reject();
    if (value && typeof value === 'object') for (const key of Object.keys(value)) pending.push(value[key]);
  }
  const preview = [payload.message, payload.tool_input?.command, payload.tool_input?.patch, payload.demo_note]
    .find(value => typeof value === 'string') ?? 'Inspect the complete accepted payload';
  return { connectionId: connection, sequence: message.sequence, receivedAt: new Date(timestamp).toISOString(),
    hook: message.hook_type, session: message.session_id, tool: message.tool_name, bytes: message.payload_bytes,
    preview: preview.slice(0, 180).replace(/\s+/g, ' '), text: raw };
}
class StreamParser {
  constructor() {
    this.buffer = Buffer.allocUnsafe(MAX_FRAME_BYTES);
    this.length = 0; this.peakBytes = 0; this.connection = null; this.sequence = 0;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
  }
  *push(chunk) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const count = end - start;
      if (this.length + count + (newline < 0 ? 0 : 1) > MAX_FRAME_BYTES) throw new StreamError('frame');
      chunk.copy(this.buffer, this.length, start, end); this.length += count;
      this.peakBytes = Math.max(this.peakBytes, this.length);
      start = end + 1;
      if (newline < 0) return;
      let message;
      try { message = JSON.parse(this.decoder.decode(this.buffer.subarray(0, this.length))); } catch { reject(); }
      this.length = 0;
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') reject();
      if (!this.connection) {
        if (message.type !== 'hello') reject();
        if (message.protocol_version !== 1) throw new StreamError('version');
        if (!uuid(message.connection_id) || message.max_payload_bytes !== MAX_PAYLOAD_BYTES || message.max_frame_bytes !== MAX_FRAME_BYTES ||
            message.heartbeat_interval_ms !== 2000 || message.heartbeat_expiry_ms !== 6000 || message.loss_before_connection !== 'unknown') reject();
        this.connection = message.connection_id;
        yield { type: 'hello', connectionId: this.connection };
      } else if (message.type === 'hello') reject();
      else if (message.type === 'event') {
        const event = eventValue(message, this.connection, this.sequence);
        this.sequence = event.sequence;
        yield { type: 'event', event };
      } else if (message.type === 'health') {
        if (message.connection_id !== this.connection || message.loss_outside_collector !== 'unknown' ||
            !message.known_drops || typeof message.known_drops !== 'object' || Array.isArray(message.known_drops) ||
            COUNTERS.some(key => !safe(message.known_drops[key]))) reject();
        yield { type: 'health', totals: Object.fromEntries(COUNTERS.map(key => [key, message.known_drops[key]])) };
      } else yield { type: 'ignored' };
    }
  }
  end() { if (this.length || !this.connection) reject(); }
}
module.exports = { StreamParser, StreamError, COUNTERS, eventValue, MAX_PAYLOAD_BYTES, MAX_FRAME_BYTES };
