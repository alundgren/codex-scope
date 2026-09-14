export const ANALYSIS_LIMITS = Object.freeze({
  events: 128,
  calls: 64,
  snapshotBytes: 192 * 1024,
  fieldChars: 1024,
  excerptChars: 1536,
  queryMs: 100,
  runs: 4,
  findings: 24,
});
export interface AnalysisCall {
  order: number;
  receivedAt: string;
  tool: string;
  command: string;
  model: string | null;
  actor: string | null;
  turn: string | null;
  toolUseId: string | null;
  responseBytes: number | null;
  excerpt: string;
  excerptOmitted: boolean;
  argumentsOmitted: boolean;
}
export interface AnalysisSnapshot {
  generation: number;
  session: string;
  createdAt: string;
  upper: number;
  calls: AnalysisCall[];
  sampledEvents: number;
  omittedEvents: number;
  omittedCalls: number;
  coverageUnknown: true;
  evictedBeforeSnapshot: number;
  localDrops: number;
  collectorDrops: Record<string, number> | null;
}
export interface AnalysisFinding {
  id: string;
  title: string;
  detail: string;
  suggestion: string;
  callOrders: number[];
}
export interface AnalysisUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}
export type AnalysisDecision = "unreviewed" | "kept" | "dismissed";
export interface AnalysisRunSummary {
  id: string;
  session: string;
  model: string;
  effort: string;
  createdAt: string;
  state: "running" | "completed" | "failed" | "cancelled";
  error: string | null;
  usage: AnalysisUsage | null;
}
export interface AnalysisRun extends AnalysisRunSummary {
  snapshot: AnalysisSnapshot;
  findings: AnalysisFinding[];
  decisions: Record<string, AnalysisDecision>;
}
export interface AnalysisState {
  generation: number;
  version: number;
  activeRunId: string | null;
  handoffRunId: string | null;
  runs: AnalysisRunSummary[];
}
export interface AnalysisAPI {
  analysisList(generation: number): Promise<AnalysisState>;
  analysisRun(generation: number, id: string): Promise<AnalysisRun | null>;
  analysisStart(
    generation: number,
    session: string,
    model: string,
    effort: string,
    sourceRunId: string | null,
  ): Promise<AnalysisState>;
  analysisCancel(generation: number): Promise<void>;
  analysisDecide(
    generation: number,
    id: string,
    finding: string,
    decision: AnalysisDecision,
  ): Promise<AnalysisRun>;
  analysisExport(generation: number, id: string): Promise<boolean>;
  onAnalysis(callback: () => void): void;
}
