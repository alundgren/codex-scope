const http = require('node:http');
const https = require('node:https');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const { StreamParser, StreamError } = require('./stream.cjs');
const TRANSPORT_LIMITS = Object.freeze({ heartbeatMs: 2000, requestMs: 1500, connectMs: 2500,
  progressMs: 4000, processingMs: 2000, retryMs: 500, maxRetryMs: 8000,
  chunkBytes: 64 * 1024, burstBytes: 512 * 1024, bytesPerSecond: 2 * 1024 * 1024,
  burstFrames: 512, framesPerSecond: 512 });
const terminal = new Set(['auth', 'version', 'config', 'tls', 'endpoint']);
const statusReason = code => code === 401 ? 'auth' : code === 409 ? 'conflict' : code === 503 ? 'busy' : 'endpoint';
function failure(error) {
  if (error instanceof StreamError) return error.reason;
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(error?.code ?? '')) return 'tls';
  return 'disconnected';
}
class Transport {
  constructor({ config, current, onEvent, onStatus }) {
    this.config = config; this.current = current; this.onEvent = onEvent; this.onStatus = onStatus;
    this.wanted = false; this.running = false; this.attempt = null; this.retry = null; this.failures = 0;
    this.state = { state: 'connecting', reason: null, coverageUnknown: true, collectorTotals: null };
    this.metrics = { attempts: 0, heartbeatRequests: 0, peakFrameBytes: 0, peakChunkBytes: 0, peakProcessing: 0, rateDisconnects: 0 };
  }
  snapshot() { return { ...this.state, requiresRestart: terminal.has(this.state.reason), metrics: { ...this.metrics }, retryPending: !!this.retry,
    requests: Number(!!this.attempt?.request) + Number(!!this.attempt?.heartbeat), processing: Number(!!this.attempt?.processing) }; }
  notify() { this.onStatus(this.snapshot()); }
  start() { if (terminal.has(this.state.reason)) return; this.wanted = true; this.failures = 0; this.launch(); }
  stop() {
    this.wanted = false; clearTimeout(this.retry); this.retry = null;
    this.finish(this.attempt, 'stopped');
  }
  finish(attempt, reason) {
    if (!attempt || attempt.done) return;
    attempt.done = true; attempt.reason = reason;
    for (const timer of ['deadline', 'heartbeatTimer', 'heartbeatDeadline']) clearTimeout(attempt[timer]);
    attempt.request?.destroy(); attempt.response?.destroy(); attempt.heartbeat?.destroy();
    attempt.request = null; attempt.heartbeat = null;
    if (this.current() && reason !== 'stopped') {
      if (reason === 'rate') this.metrics.rateDisconnects = Math.min(Number.MAX_SAFE_INTEGER, this.metrics.rateDisconnects + 1);
      this.state = { ...this.state, state: 'disconnected', reason, coverageUnknown: true };
      this.notify();
    }
  }
  valid(attempt) { return this.wanted && !attempt.done && this.attempt === attempt && this.current(); }
  request(route, method, connection) {
    const client = this.config.endpoint.startsWith('https:') ? https : http;
    return client.request(new URL(route, this.config.endpoint), { method, agent: false, rejectUnauthorized: true,
      highWaterMark: TRANSPORT_LIMITS.chunkBytes, maxHeaderSize: 8192, headers: {
        Authorization: `Bearer ${this.config.token}`, Connection: 'close',
        ...(connection ? { 'X-Connection-Id': connection, 'Content-Length': '0' } : { Accept: 'application/x-ndjson' }),
      } });
  }
  heartbeat(attempt) {
    if (!this.valid(attempt)) { this.finish(attempt, 'stopped'); return; }
    const now = performance.now();
    if (now - attempt.progress >= TRANSPORT_LIMITS.progressMs || attempt.processing && now - attempt.processing >= TRANSPORT_LIMITS.processingMs) {
      this.finish(attempt, 'stalled'); return;
    }
    if (attempt.heartbeat) { this.finish(attempt, 'stalled'); return; }
    const request = attempt.heartbeat = this.request('/v1/heartbeat', 'POST', attempt.parser.connection);
    this.metrics.heartbeatRequests = Math.min(Number.MAX_SAFE_INTEGER, this.metrics.heartbeatRequests + 1);
    attempt.heartbeatDeadline = setTimeout(() => this.finish(attempt, 'disconnected'), TRANSPORT_LIMITS.requestMs);
    request.once('response', response => {
      response.on('error', () => {});
      if (!this.valid(attempt)) { response.destroy(); return; }
      clearTimeout(attempt.heartbeatDeadline);
      attempt.heartbeat = null;
      if (response.statusCode !== 204) this.finish(attempt, statusReason(response.statusCode));
      else if (performance.now() - attempt.started >= 6000) this.failures = 0;
      response.destroy(); request.destroy();
    });
    request.once('error', error => { if (this.valid(attempt)) this.finish(attempt, failure(error)); });
    request.end();
    attempt.heartbeatTimer = setTimeout(() => this.heartbeat(attempt), TRANSPORT_LIMITS.heartbeatMs);
  }
  async launch() {
    if (this.running || this.retry || !this.wanted || !this.current()) return;
    this.running = true;
    const attempt = this.attempt = { done: false, parser: new StreamParser(), started: performance.now(), progress: performance.now(),
      processing: 0, bytes: TRANSPORT_LIMITS.burstBytes, frames: TRANSPORT_LIMITS.burstFrames, tokenTime: performance.now() };
    this.metrics.attempts = Math.min(Number.MAX_SAFE_INTEGER, this.metrics.attempts + 1);
    this.state = { ...this.state, state: 'connecting', reason: null };
    this.notify();
    try {
      const response = await new Promise((resolve, reject) => {
        const request = attempt.request = this.request('/v1/stream', 'GET');
        attempt.deadline = setTimeout(() => this.finish(attempt, 'disconnected'), TRANSPORT_LIMITS.connectMs);
        request.once('response', resolve); request.once('error', reject);
        request.once('close', () => { if (!attempt.response) reject(new StreamError(attempt.reason ?? 'disconnected')); });
        request.end();
      });
      attempt.response = response;
      response.on('error', () => {});
      if (!this.valid(attempt)) { response.destroy(); return; }
      if (response.statusCode !== 200) throw new StreamError(statusReason(response.statusCode));
      if (!/^application\/x-ndjson(?:\s*;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '') ||
          response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new StreamError('protocol');
      for await (const chunk of response) {
        if (!this.valid(attempt)) break;
        this.metrics.peakChunkBytes = Math.max(this.metrics.peakChunkBytes, chunk.length);
        const now = performance.now(), elapsed = (now - attempt.tokenTime) / 1000;
        attempt.tokenTime = now;
        attempt.bytes = Math.min(TRANSPORT_LIMITS.burstBytes, attempt.bytes + elapsed * TRANSPORT_LIMITS.bytesPerSecond);
        attempt.frames = Math.min(TRANSPORT_LIMITS.burstFrames, attempt.frames + elapsed * TRANSPORT_LIMITS.framesPerSecond);
        if (chunk.length > attempt.bytes) throw new StreamError('rate');
        attempt.bytes -= chunk.length;
        for (const message of attempt.parser.push(chunk)) {
          if (!this.valid(attempt)) break;
          if (--attempt.frames < 0) throw new StreamError('rate');
          if (performance.now() - attempt.progress >= TRANSPORT_LIMITS.progressMs) throw new StreamError('stalled');
          if (message.type === 'hello') {
            clearTimeout(attempt.deadline);
            this.state = { state: 'connected', reason: null, connectionId: message.connectionId, coverageUnknown: true, collectorTotals: null };
            attempt.heartbeatTimer = setTimeout(() => this.heartbeat(attempt), TRANSPORT_LIMITS.heartbeatMs);
          } else if (message.type === 'event') {
            attempt.processing = performance.now(); this.metrics.peakProcessing = 1;
            await this.onEvent(message.event, () => this.valid(attempt));
            if (!this.valid(attempt)) break;
            if (performance.now() - attempt.processing >= TRANSPORT_LIMITS.processingMs) throw new StreamError('stalled');
            attempt.processing = 0;
          } else if (message.type === 'health') this.state.collectorTotals = message.totals;
          if (message.type !== 'ignored') attempt.progress = performance.now();
        }
        this.metrics.peakFrameBytes = Math.max(this.metrics.peakFrameBytes, attempt.parser.peakBytes);
        if (this.valid(attempt)) this.notify();
        await yieldTurn();
      }
      if (!attempt.done) { attempt.parser.end(); this.finish(attempt, 'disconnected'); }
    } catch (error) { this.finish(attempt, failure(error)); }
    finally {
      this.finish(attempt, 'disconnected');
      this.running = false;
      if (this.attempt === attempt) this.attempt = null;
      if (this.wanted && this.current() && !terminal.has(attempt.reason)) {
        const delay = Math.min(TRANSPORT_LIMITS.maxRetryMs, TRANSPORT_LIMITS.retryMs * 2 ** Math.min(this.failures++, 5));
        this.retry = setTimeout(() => { this.retry = null; this.launch(); }, delay);
      }
    }
  }
}
module.exports = { Transport, TRANSPORT_LIMITS };
