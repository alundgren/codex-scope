import type { FeedbackResult } from "./review-feedback.ts";
import type { TurnPromptVersions } from "./review-prompts.ts";
import type { ModelSelection } from "./model-types.ts";
export const SESSION_LIMITS = {
  frameBytes: 1024 * 1024,
  protocolBytes: 8 * 1024 * 1024,
  protocolFrames: 8192,
  transcriptBytes: 512 * 1024,
  entries: 256,
  pageEntries: 20,
  messageBytes: 16384,
  toolBytes: 32768,
  toolCalls: 64,
  turnMs: 120000,
  requestMs: 10000,
  sessionMs: 60 * 60 * 1000,
} as const;
export const LENSES = ["Overview", "Security", "UX", "Performance", "Architecture"] as const;
export type ReviewLens = (typeof LENSES)[number];
export interface ConversationEntry {
  id: string;
  role: "user" | "assistant" | "activity";
  text: string;
  lens: ReviewLens;
  prompts: TurnPromptVersions;
}
export interface ConversationState {
  review: string;
  version: number;
  status: "idle" | "starting" | "running" | "ready" | "failed" | "capacity";
  selection: ModelSelection | null;
  lens: ReviewLens;
  prompts: TurnPromptVersions | null;
  error: string | null;
  total: number;
  offset: number;
  entries: ConversationEntry[];
  feedback?: FeedbackResult;
}
export type ConversationRequest =
  | { action: "read"; review: string; offset: number }
  | { action: "send"; review: string; text: string; lens: ReviewLens }
  | { action: "feedback"; review: string; lens: ReviewLens }
  | { action: "stop"; review: string }
  | { action: "copy"; review: string };
export interface ToolResult {
  success: boolean;
  contentItems: ({ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string })[];
}
