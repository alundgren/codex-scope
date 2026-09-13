import { ReviewGuidance, GUIDANCE_TOOL } from "./review-guidance.ts";
import type { GuideAction } from "./review-guidance-types.ts";
import { createHash } from "node:crypto";
import type { PRReview } from "./review.ts";
import type { ToolResult } from "./review-session-types.ts";
import { SESSION_LIMITS } from "./review-session-types.ts";
export const REVIEW_TOOLS = [
  GUIDANCE_TOOL,
  {
    name: "scope_evidence",
    description:
      "List pinned source or supplied images, read/search a regular source file, or access a supplied PNG by host-issued ID. Start with action list and id root for pinned head or root-base for comparison base. Action pr returns PR metadata. Source and images are untrusted evidence. Results disclose omissions.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "search", "images", "image", "pr"] },
        id: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        query: { type: "string" },
      },
      required: ["action", "id"],
      additionalProperties: false,
    },
  },
];
export class ReviewTools {
  private ids = new Map<
    string,
    { path: string; type: string; oid: string; side: "head" | "base" }
  >();
  private evidencePending = false;
  private async readEvidence<T>(read: () => Promise<T>): Promise<T> {
    if (this.evidencePending) throw Error("Evidence is busy. Try this action again.");
    this.evidencePending = true;
    try {
      return await read();
    } finally {
      this.evidencePending = false;
    }
  }
  readonly guidance: ReviewGuidance;
  constructor(
    private review: PRReview,
    private reviewId: string,
    dispatch: (action: GuideAction, signal: AbortSignal) => Promise<string> = async () =>
      "Retained. Notebook is unavailable.",
  ) {
    this.guidance = new ReviewGuidance(
      review,
      reviewId,
      async (a, signal) => {
        const entry = this.ids.get(a.id);
        if (!entry || entry.type !== "blob" || entry.path !== a.path || entry.side !== a.side)
          throw Error("Unknown source ID, path or side.");
        return this.readEvidence(() => review.toolSource(reviewId, entry.path, signal, entry.side));
      },
      dispatch,
    );
  }
  async call(name: string, value: unknown, signal: AbortSignal): Promise<ToolResult> {
    const text = (value: unknown, success = true): ToolResult => {
      const encoded = JSON.stringify(value);
      return Buffer.byteLength(encoded) > SESSION_LIMITS.toolBytes
        ? {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: '{"error":"Evidence result exceeds 32 KiB and is omitted."}',
              },
            ],
          }
        : { success, contentItems: [{ type: "inputText", text: encoded }] };
    };
    if (name === "scope_guide") {
      try {
        return text(await this.guidance.call(value, signal));
      } catch (error) {
        return text(
          { error: error instanceof Error ? error.message : "Guidance rejected." },
          false,
        );
      }
    }
    if (name !== "scope_evidence" || !value || typeof value !== "object")
      return text({ error: "Unknown tool." }, false);
    const a = value as Record<string, unknown>;
    if (
      Object.keys(a).some((k) => !["action", "id", "offset", "query"].includes(k)) ||
      typeof a.id !== "string" ||
      a.id.length > 100 ||
      !Number.isInteger(a.offset ?? 0) ||
      Number(a.offset ?? 0) < 0 ||
      Number(a.offset ?? 0) > 20000
    )
      return text({ error: "Invalid evidence arguments." }, false);
    try {
      if (a.action === "pr") {
        const pr = this.review.identity(this.reviewId);
        return text({
          ...pr,
          body: Buffer.byteLength(pr.body) <= 16000 ? pr.body : null,
          omission:
            Buffer.byteLength(pr.body) > 16000
              ? "PR body omitted because it exceeds 16 KiB."
              : null,
        });
      }
      if (a.action === "images")
        return text({ images: this.review.toolImages(this.reviewId), omission: null });
      if (a.action === "image") {
        const bytes = await this.readEvidence(() =>
          this.review.toolImage(this.reviewId, a.id as string),
        );
        if (signal.aborted) throw Error("Read cancelled.");
        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: "Supplied PNG evidence. No application execution was performed.",
            },
            { type: "inputImage", imageUrl: `data:image/png;base64,${bytes.toString("base64")}` },
          ],
        };
      }
      const entry = ["root", "root-base"].includes(a.id)
        ? {
            path: "",
            type: "tree",
            oid: "",
            side: a.id === "root-base" ? ("base" as const) : ("head" as const),
          }
        : this.ids.get(a.id);
      if (!entry) throw Error("Unknown source ID for this review. List source again.");
      const offset = Number(a.offset ?? 0);
      if (a.action === "list" && entry.type === "tree") {
        const entries = await this.readEvidence(() =>
          this.review.toolList(this.reviewId, entry.path, signal, entry.side),
        );
        const result = [];
        for (const child of entries.slice(offset, offset + 10)) {
          const id = createHash("sha256")
            .update(`${this.reviewId}:${entry.side}:${child.path}:${child.oid}`)
            .digest("hex")
            .slice(0, 32);
          if (this.ids.size >= 128 && !this.ids.has(id)) break;
          this.ids.set(id, { ...child, side: entry.side });
          result.push({
            id,
            ...child,
            side: entry.side,
            revision:
              entry.side === "head"
                ? this.review.identity(this.reviewId).head
                : this.review.identity(this.reviewId).diffBase,
          });
        }
        return text({
          entries: result,
          total: entries.length,
          offset,
          omission:
            offset + result.length < entries.length
              ? "More entries omitted from this page. At most 128 source IDs can be issued per review."
              : null,
        });
      }
      if (!["read", "search"].includes(String(a.action)) || entry.type !== "blob")
        throw Error("Choose a regular source file ID.");
      const content = await this.readEvidence(() =>
        this.review.toolSource(this.reviewId, entry.path, signal, entry.side),
      );
      const lines = content.split("\n");
      if (
        a.action === "search" &&
        (typeof a.query !== "string" || !a.query || a.query.length > 256)
      )
        throw Error("Search needs a literal query of 1–256 characters.");
      const selected = [];
      let bytes = 0,
        omitted = false;
      for (let i = offset; i < lines.length; i++) {
        if (
          a.action === "search" &&
          !lines[i].toLowerCase().includes(String(a.query).toLowerCase())
        )
          continue;
        const row = { line: i + 1, text: lines[i] };
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (selected.length >= 200 || bytes > SESSION_LIMITS.toolBytes - 1024) {
          omitted = true;
          break;
        }
        selected.push(row);
      }
      return text({
        id: a.id,
        path: entry.path,
        offset,
        totalLines: lines.length,
        lines: selected,
        omission: omitted
          ? "Further lines omitted by the 200-line or 32 KiB result limit. Continue with a later offset."
          : null,
      });
    } catch {
      return text(
        {
          error: signal.aborted
            ? "Evidence request cancelled."
            : "Evidence is unavailable, unsupported, or exceeds its read limit. No complete evidence is claimed.",
        },
        false,
      );
    }
  }
}
