import type { HistoryStatus, TransportStatus } from "../src/types.ts";
export interface ProcessSample {
  pid: number;
  parent: number;
  group: number;
  ticks: number;
  rssBytes: number;
  pssBytes: number | null;
  role: string;
}
export interface Distribution {
  operations: number;
  minimum: number;
  maximum: number | undefined;
  p95: number;
  mean: number;
}
export interface InteractionMetrics {
  searchMs: Distribution;
  keyboardMs: Distribution;
  pointerMoves: number;
  summaryRows: number;
  tickNodes: number;
}
export interface Workload {
  [key: string]: unknown;
  durationMs: number;
  samples: number;
  meanCpuPercentOneCore: number;
  steadyRssBytes: number;
  peakProcesses: number;
  peakSampleCpuPercentOneCore: number;
  peakRssBytes: number;
  finalRssBytes: number;
  finalPssBytes: number | null;
  history?: HistoryStatus;
  maximumMainDelayMs?: number;
  maximumRendererDelayMs?: number;
  workload?: { durationMs?: number; searchMs?: Distribution; keyboardMs?: Distribution };
  timings?: InteractionMetrics;
  maximumMainTimerDelayMs?: number;
}
export interface MeasurementReport {
  [key: string]: unknown;
  workloads: Record<string, Workload>;
  final?: Partial<HistoryStatus> & { directory?: string | null };
  startup?: Record<string, number[]>;
  clipboardLatencyMs?: number[];
  recordings?: Record<string, unknown>;
}
export interface TrialReport {
  [key: string]: unknown;
  index: number;
  complete?: boolean;
  startupMs?: number;
  baseline: { startupMs?: number; idle?: Workload };
  workloads: Record<string, Workload>;
  assertions: string[];
}
export interface RegressionReport {
  [key: string]: unknown;
  completed: boolean;
  trials: TrialReport[];
  appBytes?: number;
  runtimeBytes?: number;
  evaluation?: { pass: boolean };
}
export type MeasuredHistory = HistoryStatus & {
  transport: TransportStatus;
  transportBufferedBytes: number;
};
