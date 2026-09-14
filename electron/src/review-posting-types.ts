export const POST_LIMITS = { bodyBytes: 65536, pages: 3, pageSize: 20, candidates: 20 } as const;
export type PostingRequest =
  | { action: "read" | "verify"; review: string }
  | { action: "post"; review: string; body: string }
  | { action: "resolve"; review: string; candidate: number | null };
export interface PostedComment {
  id: number;
  url: string;
  created: string;
}
export interface PostingState {
  status: "idle" | "failed" | "stale" | "uncertain" | "sent";
  body: string;
  message: string;
  comment: PostedComment | null;
  candidates: PostedComment[];
  checked: boolean;
}
