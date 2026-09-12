import type { AnalysisAPI, AnalysisSnapshot } from "./analysis-types.ts";
export interface EventValue {
  context?: string;
  connectionId?: string;
  sequence: number;
  receivedAt: string;
  hook: string;
  session: string | null;
  tool: string | null;
  bytes: number;
  preview: string;
  text: string;
}
export interface StoredEvent extends EventValue {
  id: number;
  generation?: number;
  localReceivedAt?: string;
  cost?: number;
}
export interface EventRow {
  id: number;
  receivedAt: string;
  hook: string;
  session: string | null;
  preview: string;
}
export interface EventPosition {
  id: number;
  receivedAt: string;
}
export interface Filter {
  text: string;
  session: string | null;
  hooks: string[];
}
export type ChoiceField = "session" | "hook";
export type Direction = "next" | "previous";
export interface ChoicePage {
  values: string[];
  labels?: (string | null)[];
  previous?: boolean;
  next?: boolean;
}
export interface NavigationSnapshot {
  queryId: number;
  upper: number;
  count: number;
  removed: number;
}
export type NavigationTarget = (
  | { kind: "live" }
  | { kind: "select"; id: number | null }
  | { kind: "rank"; rank: number }
) & { snapshot?: NavigationSnapshot };
export interface NavigationRequest {
  generation?: number;
  queryId: number;
  targetId: number;
  filter: Filter;
  target: NavigationTarget;
  rows: number;
}
export interface SearchStatus {
  queryId: number;
  first: EventPosition | null;
  count: number | null;
  arrivals: number;
  removed: number;
  maximumMs: number;
  canceled: number;
  timeouts: number;
}
export interface ConnectionConfig {
  endpoint: string;
  token: string;
}
export type TransportReason =
  | "auth"
  | "version"
  | "config"
  | "tls"
  | "endpoint"
  | "conflict"
  | "busy"
  | "protocol"
  | "frame"
  | "rate"
  | "stalled"
  | "disconnected"
  | "stopped";
export interface TransportStatus {
  state: "connecting" | "connected" | "disconnected";
  reason: TransportReason | null;
  coverageUnknown: boolean;
  connectionId?: string;
  collectorTotals?: Record<string, number> | null;
  requiresRestart?: boolean;
  retryPending?: boolean;
  requests?: number;
  processing?: number;
  metrics?: {
    attempts: number;
    heartbeatRequests: number;
    peakFrameBytes: number;
    peakChunkBytes: number;
    peakProcessing: number;
    rateDisconnects: number;
  };
}
export interface HistoryStatus {
  generation: number;
  total: number;
  accepted: number;
  first: EventPosition | null;
  last: EventPosition | null;
  drops: Record<string, number>;
  retainedBytes?: number;
  evicted?: number;
  connectionId?: string;
  starting?: boolean;
  clearing?: boolean;
  pressure?: boolean;
  error?: string;
  transport?: TransportStatus;
  view?: SearchStatus;
  localDrops?: number;
  rateDrops?: number;
  unknownGap?: boolean;
  peakQueueCount?: number;
  peakQueueBytes?: number;
  queuedCount?: number;
  queuedBytes?: number;
  pendingRequests?: number;
  peakPending?: number;
  maximumTransactionMs?: number;
  maximumDiskBytes?: number;
}
export interface OperationFailure {
  error?: string;
  stale?: boolean;
  timedOut?: boolean;
  snapshotLost?: boolean;
  generation?: number;
  queryId?: number;
  targetId?: number;
}
export interface Inspection extends HistoryStatus {
  rows: EventRow[];
  selected: StoredEvent | null;
  selectionEvicted?: boolean;
}
export interface Navigation extends Inspection {
  view: SearchStatus;
  snapshot: NavigationSnapshot;
  position: number;
  queryId: number;
  targetId: number;
}
export type Reply<T> = (T & OperationFailure) | OperationFailure;
export interface HistoryOptions {
  directory: string;
  fixture: string;
  continuous?: boolean;
  testMode?: boolean;
  connectionFile?: string | null;
  optionalConnection?: boolean;
}
export interface Faults {
  cleanup?: boolean;
  disk?: boolean;
  write?: boolean;
  queryOnly?: boolean;
  diskFull?: boolean;
  delay?: number;
  searchMs?: number;
  transportDelay?: number;
}
export interface ScopeAPI extends AnalysisAPI {
  status(): Promise<HistoryStatus>;
  onStatus(callback: (value: HistoryStatus) => void): void;
  onHidden(callback: () => void): void;
  inspect(generation: number, id: number | null, rows: number): Promise<Reply<Inspection>>;
  cancel(generation: number, targetId: number): void;
  navigate(generation: number, query: NavigationRequest): Promise<Reply<Navigation>>;
  choices(
    generation: number,
    field: ChoiceField,
    cursor?: string | null,
    direction?: Direction,
  ): Promise<Reply<ChoicePage>>;
  copyPayload(generation: number, id: number): Promise<boolean>;
  clear(generation: number): Promise<Reply<{ ok: boolean; generation?: number }>>;
}
export interface HistoryOperations {
  analysis: { data: { session: string }; result: AnalysisSnapshot };
  open: { data: Record<string, never>; result: { ok: boolean } };
  inspect: { data: { id: number | null; rows: number }; result: Inspection };
  navigate: { data: { query: NavigationRequest }; result: Navigation };
  choices: {
    data: { field: ChoiceField; cursor: string | null; direction: Direction };
    result: ChoicePage & { generation: number };
  };
  append: { data: { frames: string[]; connectionId?: string }; result: { ok: boolean } };
  clear: { data: Record<string, never>; result: { ok: boolean; generation?: number } };
  close: { data: Record<string, never>; result: { ok: boolean; generation?: number } };
  test: {
    data: { faults: Faults };
    result: HistoryStatus & {
      ok: boolean;
      directory: string | null;
      limits: typeof import("./history.ts").LIMITS;
      transportBufferedBytes: number;
    };
  };
}
export type WorkerRequest =
  | {
      [Operation in keyof HistoryOperations]: {
        request: number;
        generation: number;
        operation: Operation;
      } & HistoryOperations[Operation]["data"];
    }[keyof HistoryOperations]
  | { operation: "ack" };
