export const REVIEW_LIMITS = {
  responseBytes: 2 * 1024 * 1024,
  sourceBytes: 256 * 1024,
  patchBytes: 128 * 1024,
  pageFiles: 10,
  maxFiles: 3000,
  treeEntries: 10000,
  rows: 200,
  maxLines: 20000,
  commandMs: 10000,
  imageBytes: 4 * 1024 * 1024,
  imagePixels: 4 * 1024 * 1024,
  images: 4,
} as const;
export type ReviewSide = "base" | "head";
export interface ReviewIdentity {
  repository: string;
  number: number;
  base: string;
  head: string;
}
export interface ReviewPR extends ReviewIdentity {
  id: string;
  title: string;
  body: string;
  state: string;
  baseRepository: string;
  headRepository: string | null;
  fileCount: number;
  diffBase: string;
}
export interface ReviewFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patchAvailable: boolean;
  omission: string | null;
}
export interface ReviewAnchor extends ReviewIdentity {
  path: string;
  sourcePath: string;
  sourceOid: string;
  side: ReviewSide;
  line: number;
}
export interface ReviewRow {
  base: number | null;
  head: number | null;
  text: string;
  kind: "context" | "add" | "delete" | "header";
}
export interface ReviewContent {
  path: string;
  previousPath?: string | null;
  mode: "diff" | ReviewSide;
  rows: ReviewRow[];
  offset: number;
  total: number;
  omission: string | null;
}
export interface ReviewImage extends ReviewIdentity {
  id: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  attribution: string;
}
export type ReviewRequest =
  | { action: "open"; input: string; replace?: boolean }
  | { action: "refresh"; id: string }
  | { action: "files"; id: string; page: number }
  | { action: "content"; id: string; path: string; mode: "diff" | ReviewSide; offset: number }
  | { action: "images"; id: string }
  | { action: "attach"; id: string }
  | { action: "image"; id: string; image: string }
  | { action: "remove-image"; id: string; image: string }
  | { action: "end"; id: string };
export interface ReviewReply {
  error?: string;
  pr?: ReviewPR;
  changed?: boolean;
  files?: ReviewFile[];
  page?: number;
  content?: ReviewContent;
  images?: ReviewImage[];
  imageUrl?: string;
}
