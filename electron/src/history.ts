import type {
  HistoryOptions,
  HistoryStatus,
  HistoryOperations,
  NavigationRequest,
  ChoiceField,
  Direction,
  Reply,
  Inspection,
  Navigation,
} from "./types.ts";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { validNavigation, positive } from "./search.ts";
import { MAX_FRAME_BYTES } from "./recording.ts";

const LIMITS = Object.freeze({
  queueCount: 32,
  queueBytes: 1024 * 1024,
  batchCount: 4,
  batchBytes: 512 * 1024,
  eventsPerSecond: 256,
  bytesPerSecond: 2 * 1024 * 1024,
  requests: 4,
  requestMs: 2500,
  cleanupMs: 1500,
  rows: 5,
  retainedBytes: 8 * 1024 * 1024,
  retainedCount: 10000,
  databaseBytes: 16 * 1024 * 1024,
  diskBytes: 33 * 1024 * 1024,
  headroomBytes: 34 * 1024 * 1024,
  cacheKiB: 2048,
  sqliteHeapBytes: 8 * 1024 * 1024,
  evictionCount: 64,
});

interface PendingRequest {
  resolve: (result: Reply<HistoryOperations[keyof HistoryOperations]["result"]>) => void;
  timer: NodeJS.Timeout;
  generation: number;
  operation: keyof HistoryOperations;
}
class History extends EventEmitter {
  generation: number;
  shared: Int32Array;
  pending: Map<number, PendingRequest>;
  queue: { frame: string; bytes: number }[];
  queueBytes: number;
  sending: boolean;
  closed: boolean;
  nextRequest: number;
  localDrops: number;
  rateDrops: number;
  unknownGap: boolean;
  eventTokens: number;
  byteTokens: number;
  tokenTime: number;
  peakQueueCount: number;
  peakQueueBytes: number;
  peakPending: number;
  status: HistoryStatus;
  worker: Worker;
  ready: Promise<Reply<{ ok: boolean }>>;
  constructor(options: HistoryOptions) {
    super();
    this.generation = 1;
    this.shared = new Int32Array(new SharedArrayBuffer(8));
    Atomics.store(this.shared, 0, this.generation);
    this.pending = new Map();
    this.queue = [];
    this.queueBytes = 0;
    this.sending = false;
    this.closed = false;
    this.nextRequest = 0;
    this.localDrops = 0;
    this.rateDrops = 0;
    this.unknownGap = false;
    this.eventTokens = LIMITS.queueCount;
    this.byteTokens = LIMITS.batchBytes;
    this.tokenTime = performance.now();
    this.peakQueueCount = 0;
    this.peakQueueBytes = 0;
    this.peakPending = 0;
    this.status = {
      generation: 1,
      total: 0,
      accepted: 0,
      first: null,
      last: null,
      drops: {},
      starting: true,
    };
    this.worker = new Worker(new URL("./history-worker.mjs", import.meta.url), {
      workerData: { ...options, limits: LIMITS, shared: this.shared.buffer },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
    });
    this.worker.on(
      "message",
      (message: {
        notification?: boolean;
        status?: HistoryStatus;
        request: number;
        result?: Reply<HistoryOperations[keyof HistoryOperations]["result"]>;
      }) => {
        if (message.notification) this.worker.postMessage({ operation: "ack" });
        if (message.status && message.status.generation === this.generation) {
          this.status = message.status;
          this.emit("status", this.snapshot());
        }
        const request = this.pending.get(message.request);
        if (!request) return;
        this.pending.delete(message.request);
        clearTimeout(request.timer);
        if (request.generation !== this.generation && request.operation !== "close")
          request.resolve({ stale: true });
        else request.resolve(message.result ?? { error: "History operation failed." });
      },
    );
    this.worker.on("error", () => this.fail());
    this.worker.on("exit", () => {
      if (!this.closed) this.fail();
    });
    this.ready = this.call("open");
  }
  snapshot() {
    return {
      ...this.status,
      localDrops: this.localDrops,
      rateDrops: this.rateDrops,
      unknownGap: this.unknownGap,
      peakQueueCount: this.peakQueueCount,
      peakQueueBytes: this.peakQueueBytes,
      queuedCount: this.queue.length,
      queuedBytes: this.queueBytes,
      pendingRequests: this.pending.size,
      peakPending: this.peakPending,
    };
  }
  fail() {
    this.closed = true;
    this.queue = [];
    this.queueBytes = 0;
    const transport = this.status.transport
      ? {
          ...this.status.transport,
          state: "disconnected" as const,
          reason: null,
          requiresRestart: true,
          coverageUnknown: true,
          retryPending: false,
          requests: 0,
          processing: 0,
        }
      : undefined;
    this.status = {
      ...this.status,
      transport,
      error: "Temporary history is unavailable. Restart the app to try again.",
      starting: false,
    };
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.resolve({ error: this.status.error });
    }
    this.pending.clear();
    this.emit("status", this.snapshot());
  }
  call<Operation extends keyof HistoryOperations>(
    operation: Operation,
    ...args: {} extends HistoryOperations[Operation]["data"]
      ? [data?: HistoryOperations[Operation]["data"]]
      : [data: HistoryOperations[Operation]["data"]]
  ): Promise<Reply<HistoryOperations[Operation]["result"]>> {
    const data = args[0] ?? {};
    const control = operation === "clear" || operation === "close" || operation === "capture";
    if (this.closed)
      return Promise.resolve({
        error:
          this.status.error ?? "Temporary history is unavailable. Restart the app to try again.",
      });
    if (this.pending.size >= LIMITS.requests - (control ? 0 : 1))
      return Promise.resolve({ error: "History is busy. Try again." });
    const request = ++this.nextRequest;
    return new Promise<Reply<HistoryOperations[Operation]["result"]>>((resolve) => {
      // A timed-out request keeps its slot until the worker replies or exits.
      const timer = setTimeout(
        () => resolve({ error: "History operation timed out. Try again.", timedOut: true }),
        LIMITS.requestMs,
      );
      this.pending.set(request, {
        resolve: (result) => resolve(result as Reply<HistoryOperations[Operation]["result"]>),
        timer,
        generation: this.generation,
        operation,
      });
      this.peakPending = Math.max(this.peakPending, this.pending.size);
      try {
        this.worker.postMessage({ request, generation: this.generation, operation, ...data });
      } catch {
        clearTimeout(timer);
        this.pending.delete(request);
        resolve({ error: "History operation failed." });
      }
    });
  }
  append(generation: number, connectionId: string | undefined, frame: string) {
    if (
      this.closed ||
      this.status.clearing ||
      generation !== this.generation ||
      connectionId !== this.status.connectionId
    )
      return false;
    if (
      typeof frame !== "string" ||
      frame.length > MAX_FRAME_BYTES ||
      Buffer.byteLength(frame) > MAX_FRAME_BYTES ||
      this.queue.length >= LIMITS.queueCount ||
      this.queueBytes + Buffer.byteLength(frame) > LIMITS.queueBytes
    ) {
      this.localDrops = Math.min(Number.MAX_SAFE_INTEGER, this.localDrops + 1);
      this.emit("status", this.snapshot());
      return false;
    }
    const bytes = Buffer.byteLength(frame);
    const now = performance.now();
    const elapsed = (now - this.tokenTime) / 1000;
    this.tokenTime = now;
    this.eventTokens = Math.min(
      LIMITS.queueCount,
      this.eventTokens + elapsed * LIMITS.eventsPerSecond,
    );
    this.byteTokens = Math.min(
      LIMITS.batchBytes,
      this.byteTokens + elapsed * LIMITS.bytesPerSecond,
    );
    if (this.eventTokens < 1 || this.byteTokens < bytes) {
      this.rateDrops = Math.min(Number.MAX_SAFE_INTEGER, this.rateDrops + 1);
      this.emit("status", this.snapshot());
      return false;
    }
    this.eventTokens--;
    this.byteTokens -= bytes;
    this.queue.push({ frame, bytes });
    this.queueBytes += bytes;
    this.peakQueueCount = Math.max(this.peakQueueCount, this.queue.length);
    this.peakQueueBytes = Math.max(this.peakQueueBytes, this.queueBytes);
    void this.pump();
    return true;
  }
  async pump() {
    if (this.sending || this.closed) return;
    this.sending = true;
    const generation = this.generation;
    while (this.queue.length && generation === this.generation && !this.closed) {
      const frames = [];
      let bytes = 0;
      while (
        this.queue.length &&
        frames.length < LIMITS.batchCount &&
        bytes + this.queue[0].bytes <= LIMITS.batchBytes
      ) {
        const item = this.queue.shift()!;
        frames.push(item.frame);
        bytes += item.bytes;
        this.queueBytes -= item.bytes;
      }
      const result = await this.call("append", { frames, connectionId: this.status.connectionId });
      if (generation !== this.generation) break;
      if ("error" in result && result.error) {
        this.localDrops +=
          this.queue.length + ("timedOut" in result && result.timedOut ? 0 : frames.length);
        this.unknownGap ||= !!("timedOut" in result && result.timedOut);
        this.queue = [];
        this.queueBytes = 0;
        this.emit("status", this.snapshot());
        break;
      }
    }
    this.sending = false;
    if (this.queue.length) void this.pump();
  }
  inspect(generation: number, id: number | null, rows: number): Promise<Reply<Inspection>> {
    if (generation !== this.generation) return Promise.resolve({ stale: true });
    return this.call("inspect", { id, rows });
  }
  cancel(generation: number, targetId: number) {
    if (
      generation === this.generation &&
      positive(targetId) &&
      targetId > Atomics.load(this.shared, 1)
    )
      Atomics.store(this.shared, 1, targetId);
  }
  navigate(generation: number, query: NavigationRequest): Promise<Reply<Navigation>> {
    if (generation !== this.generation) return Promise.resolve({ stale: true });
    if (!validNavigation(query, LIMITS.rows))
      return Promise.resolve({ error: "Invalid navigation request." });
    this.cancel(generation, query.targetId);
    if (query.targetId !== Atomics.load(this.shared, 1)) return Promise.resolve({ stale: true });
    return this.call("navigate", { query });
  }
  choices(generation: number, field: ChoiceField, cursor: string | null, direction: Direction) {
    if (generation !== this.generation) return Promise.resolve({ stale: true });
    return this.call("choices", { field, cursor, direction });
  }
  async clear(generation: number) {
    if (this.closed) return this.call("clear");
    if (generation !== this.generation || this.status.clearing || !this.status.total)
      return { stale: true };
    this.generation++;
    Atomics.store(this.shared, 0, this.generation);
    Atomics.store(this.shared, 1, 0);
    this.queue = [];
    this.queueBytes = 0;
    this.localDrops = 0;
    this.rateDrops = 0;
    this.unknownGap = false;
    const transport = this.status.transport
      ? {
          state: "disconnected" as const,
          reason: null,
          coverageUnknown: true,
          collectorTotals: null,
        }
      : undefined;
    this.status = {
      generation: this.generation,
      total: 0,
      accepted: 0,
      first: null,
      last: null,
      drops: {},
      clearing: true,
      transport,
    };
    this.emit("status", this.snapshot());
    const result = await this.call("clear");
    if ("error" in result && result.error) {
      this.status.error =
        "timedOut" in result && result.timedOut
          ? "Clear could not finish. Temporary files may remain. Restart the app to retry cleanup."
          : result.error;
      this.emit("status", this.snapshot());
    }
    return result;
  }
  async close() {
    if (this.closed) return false;
    this.generation++;
    Atomics.store(this.shared, 0, this.generation);
    Atomics.store(this.shared, 1, 0);
    this.queue = [];
    this.queueBytes = 0;
    const result = await this.call("close");
    this.closed = true;
    await this.worker.terminate();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.resolve({ stale: true });
    }
    this.pending.clear();
    return "ok" in result && result.ok === true;
  }
}

export { History, LIMITS };
