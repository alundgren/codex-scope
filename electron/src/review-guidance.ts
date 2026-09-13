import { randomUUID } from "node:crypto";
import { LENSES } from "./review-session-types.ts";
import {
  GUIDANCE_LIMITS as L,
  type GuideAction,
  type GuideArtifact,
  type GuideTarget,
  type SourceTarget,
} from "./review-guidance-types.ts";
import type { PRReview } from "./review.ts";
const string = { type: "string", maxLength: L.text };
const anchorSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 32, maxLength: 32 },
    revision: { type: "string", minLength: 40, maxLength: 40 },
    path: { type: "string", maxLength: 1024 },
    side: { type: "string", enum: ["base", "head"] },
    line: { type: "integer", minimum: 1, maximum: 20000 },
    endLine: { type: "integer", minimum: 1, maximum: 20000 },
  },
  required: ["id", "revision", "path", "side", "line", "endLine"],
  additionalProperties: false,
};
export const GUIDANCE_TOOL = {
  name: "scope_guide",
  description:
    "Guide the current notebook with bounded declarative actions. Use evidence IDs and pinned revisions issued by scope_evidence. Image points use original pixel coordinates. Tool results distinguish shown targets from retained targets. No executable markup or remote links.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["view", "source", "image", "diagram"] },
      data: {
        oneOf: [
          {
            type: "object",
            properties: {
              lens: { type: "string", enum: LENSES },
              view: { type: "string", enum: ["Changes", "Visual evidence"] },
            },
            required: ["lens", "view"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { anchor: anchorSchema, highlight: { type: "boolean" } },
            required: ["anchor", "highlight"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              image: { type: "string", maxLength: 36 },
              revision: { type: "string", minLength: 40, maxLength: 40 },
              marks: {
                type: "array",
                minItems: 1,
                maxItems: L.marks,
                items: {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["stroke", "arrow", "text"] },
                    points: {
                      type: "array",
                      minItems: 1,
                      maxItems: L.points,
                      items: {
                        type: "array",
                        minItems: 2,
                        maxItems: 2,
                        items: { type: "number", minimum: 0 },
                      },
                    },
                    text: string,
                  },
                  required: ["kind", "points", "text"],
                  additionalProperties: false,
                },
              },
            },
            required: ["image", "revision", "marks"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              nodes: { type: "array", minItems: 2, maxItems: L.nodes, items: string },
              messages: {
                type: "array",
                minItems: 1,
                maxItems: L.messages,
                items: {
                  type: "object",
                  properties: {
                    from: { type: "integer", minimum: 0, maximum: 7 },
                    to: { type: "integer", minimum: 0, maximum: 7 },
                    text: string,
                  },
                  required: ["from", "to", "text"],
                  additionalProperties: false,
                },
              },
              sources: { type: "array", minItems: 1, maxItems: 4, items: anchorSchema },
            },
            required: ["nodes", "messages", "sources"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["action", "data"],
    additionalProperties: false,
  },
};
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected an object.");
  return value;
}
function keys(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).some((k) => !names.includes(k))) throw Error("Unknown action field.");
}
function text(value: unknown, empty = false): asserts value is string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > L.text ||
    value.split("").some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw Error("Invalid annotation text.");
}
export class ReviewGuidance {
  private artifacts: GuideArtifact[] = [];
  constructor(
    private review: PRReview,
    readonly reviewId: string,
    private source: (anchor: SourceTarget, signal: AbortSignal) => Promise<string>,
    private dispatch: (action: GuideAction, signal: AbortSignal) => Promise<string>,
  ) {}
  read() {
    const images = this.review.toolImages(this.reviewId);
    for (const item of this.artifacts) {
      const target = item.target;
      if (target.kind === "image" && !images.some((i) => i.id === target.image))
        item.invalid = true;
    }
    return this.artifacts;
  }
  remove(id?: string) {
    this.artifacts = id ? this.artifacts.filter((a) => a.id !== id) : [];
    return this.read();
  }
  async content(id: string, signal: AbortSignal, source?: number, requestedOffset?: number) {
    const item = this.artifacts.find((a) => a.id === id);
    if (!item || item.invalid) throw Error("Source target is unavailable.");
    const a =
      item.target.kind === "source"
        ? item.target.anchor
        : item.target.kind === "diagram" && Number.isInteger(source)
          ? item.target.sources[source!]
          : undefined;
    if (!a) throw Error("Source target is unavailable.");
    const lines = (await this.source(a, signal)).split("\n");
    if (
      requestedOffset !== undefined &&
      (!Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset >= lines.length)
    )
      throw Error("Invalid source page.");
    const offset = requestedOffset ?? Math.floor((a.line - 1) / 200) * 200;
    const rows = lines.slice(offset, offset + 200).map((text, i) => ({
      text,
      kind: "context" as const,
      base: a.side === "base" ? offset + i + 1 : null,
      head: a.side === "head" ? offset + i + 1 : null,
    }));
    if (Buffer.byteLength(JSON.stringify(rows)) > 32768)
      throw Error("Source display exceeds 32 KiB. Choose a smaller source target.");
    return { path: a.path, mode: a.side, rows, offset, total: lines.length, omission: null };
  }
  private async anchor(value: unknown, signal: AbortSignal) {
    const a = object(value);
    keys(a, ["id", "revision", "path", "side", "line", "endLine"]);
    if (
      typeof a.id !== "string" ||
      a.id.length !== 32 ||
      typeof a.path !== "string" ||
      a.path.length > 1024 ||
      !["base", "head"].includes(a.side) ||
      !Number.isInteger(a.line) ||
      !Number.isInteger(a.endLine) ||
      a.line < 1 ||
      a.endLine < a.line ||
      a.endLine - a.line >= 200 ||
      a.endLine > 20000
    )
      throw Error("Invalid source anchor.");
    const pr = this.review.identity(this.reviewId);
    if (a.revision !== (a.side === "head" ? pr.head : pr.diffBase))
      throw Error("Stale source revision.");
    const anchor = a as SourceTarget;
    const content = await this.source(anchor, signal);
    if (anchor.endLine > content.split("\n").length)
      throw Error("Source line is outside the evidence.");
    return anchor;
  }
  async call(value: unknown, signal: AbortSignal) {
    if (Buffer.byteLength(JSON.stringify(value) ?? "") > L.bytes)
      throw Error("Action exceeds 8 KiB.");
    const a = object(value);
    keys(a, ["action", "data"]);
    const d = object(a.data);
    if (this.artifacts.length >= L.artifacts)
      throw Error("Guidance capacity reached. Remove artifacts or end review.");
    let target: GuideTarget;
    if (a.action === "view") {
      keys(d, ["lens", "view"]);
      if (!LENSES.includes(d.lens) || !["Changes", "Visual evidence"].includes(d.view))
        throw Error("Invalid lens or view.");
      target = { kind: "view", lens: d.lens, view: d.view };
    } else if (a.action === "source") {
      keys(d, ["anchor", "highlight"]);
      if (typeof d.highlight !== "boolean") throw Error("Highlight must be boolean.");
      target = {
        kind: "source",
        anchor: await this.anchor(d.anchor, signal),
        highlight: d.highlight,
      };
    } else if (a.action === "image") {
      keys(d, ["image", "revision", "marks"]);
      const image = this.review.toolImages(this.reviewId).find((i) => i.id === d.image);
      if (!image || image.head !== d.revision)
        throw Error("Image was removed or its revision is stale.");
      if (!Array.isArray(d.marks) || !d.marks.length || d.marks.length > L.marks)
        throw Error("Image needs 1–16 marks.");
      for (const value of d.marks) {
        const mark = object(value);
        keys(mark, ["kind", "points", "text"]);
        text(mark.text, true);
        if (
          !["stroke", "arrow", "text"].includes(mark.kind) ||
          !Array.isArray(mark.points) ||
          mark.points.length < 1 ||
          mark.points.length > L.points ||
          (mark.kind === "arrow" && mark.points.length !== 2) ||
          (mark.kind === "text" && (mark.points.length !== 1 || !mark.text))
        )
          throw Error("Invalid drawing or excessive points.");
        for (const p of mark.points)
          if (
            !Array.isArray(p) ||
            p.length !== 2 ||
            !p.every(Number.isFinite) ||
            p[0] < 0 ||
            p[1] < 0 ||
            p[0] > image.width ||
            p[1] > image.height
          )
            throw Error("Drawing coordinates are outside the image.");
      }
      const retainedPoints = this.read().reduce(
        (sum, item) =>
          sum +
          (!item.invalid && item.target.kind === "image" && item.target.image === image.id
            ? item.target.marks.reduce((n, mark) => n + mark.points.length, 0)
            : 0),
        0,
      );
      const newPoints = d.marks.reduce(
        (sum: number, mark: { points: unknown[] }) => sum + mark.points.length,
        0,
      );
      if (retainedPoints + newPoints > L.imagePoints)
        throw Error(
          "Image drawing capacity reached. Remove marks before adding more than 2,048 points to one image.",
        );
      target = {
        kind: "image",
        image: image.id,
        revision: image.head,
        width: image.width,
        height: image.height,
        marks: d.marks,
      };
    } else if (a.action === "diagram") {
      keys(d, ["nodes", "messages", "sources"]);
      if (
        !Array.isArray(d.nodes) ||
        d.nodes.length < 2 ||
        d.nodes.length > L.nodes ||
        !Array.isArray(d.messages) ||
        !d.messages.length ||
        d.messages.length > L.messages ||
        !Array.isArray(d.sources) ||
        !d.sources.length ||
        d.sources.length > 4
      )
        throw Error("Diagram exceeds node, message or source limits.");
      d.nodes.forEach((v: unknown) => text(v));
      for (const value of d.messages) {
        const m = object(value);
        keys(m, ["from", "to", "text"]);
        text(m.text);
        if (![m.from, m.to].every((i) => Number.isInteger(i) && i >= 0 && i < d.nodes.length))
          throw Error("Invalid diagram node index.");
      }
      const sources = [];
      for (const source of d.sources) sources.push(await this.anchor(source, signal));
      target = { kind: "diagram", nodes: d.nodes, messages: d.messages, sources };
    } else throw Error("Unknown guidance action.");
    if (signal.aborted) throw Error("Guidance cancelled.");
    this.review.identity(this.reviewId);
    const action = { id: randomUUID(), review: this.reviewId, target };
    this.artifacts.push({ ...action, invalid: false });
    const outcome = await this.dispatch(action, signal);
    return { id: action.id, outcome };
  }
}
