import type { ReviewLens } from "./review-session-types.ts";
export const GUIDANCE_LIMITS = {
  artifacts: 24,
  bytes: 8192,
  points: 128,
  imagePoints: 2048,
  marks: 16,
  nodes: 8,
  messages: 24,
  text: 256,
  acknowledgmentsMs: 2500,
} as const;
export interface SourceTarget {
  id: string;
  revision: string;
  path: string;
  side: "base" | "head";
  line: number;
  endLine: number;
}
export interface Drawing {
  kind: "stroke" | "arrow" | "text";
  points: [number, number][];
  text: string;
}
export type GuideTarget =
  | { kind: "view"; lens: ReviewLens; view: "Changes" | "Visual evidence" }
  | { kind: "source"; anchor: SourceTarget; highlight: boolean }
  | {
      kind: "image";
      image: string;
      name: string;
      revision: string;
      width: number;
      height: number;
      marks: Drawing[];
    }
  | {
      kind: "diagram";
      nodes: string[];
      messages: { from: number; to: number; text: string }[];
      sources: SourceTarget[];
    };
export interface GuideAction {
  id: string;
  review: string;
  target: GuideTarget;
}
export interface GuideArtifact extends GuideAction {
  invalid: boolean;
}
export type GuideRequest = { review: string } & (
  | { action: "read" }
  | { action: "remove"; id: string }
  | { action: "clear" }
  | { action: "source"; id: string; source?: number; offset?: number }
);
