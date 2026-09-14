import type { GuideArtifact } from "./review-guidance-types.ts";
import type { ReviewIdentity } from "./review-types.ts";
export const FEEDBACK_LIMITS = {
  findings: 8,
  dataBytes: 16384,
  draftBytes: 32768,
  copyBytes: 69632,
} as const;
export const IMPACTS = ["critical", "high", "medium", "low"] as const;
export interface ReviewFinding {
  id: string;
  area: string;
  impact: (typeof IMPACTS)[number];
  description: string;
  evidence: string;
  reasoning: string;
  uncertainty: string;
  verification: string;
  included: boolean;
  hypothesis: boolean;
  suggestion: string;
  attribution: "user" | "agent";
  includeSuggestion: boolean;
}
export interface FeedbackResult {
  sequence: number;
  findings: ReviewFinding[];
  error: string | null;
  references?: Record<string, string>;
}
export interface FeedbackDraft {
  revision: ReviewIdentity;
  author: string;
  agent: string;
}
const fields = {
  id: 64,
  area: 48,
  description: 320,
  evidence: 768,
  reasoning: 512,
  uncertainty: 256,
  verification: 512,
  suggestion: 320,
} as const;
export const FEEDBACK_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      maxItems: FEEDBACK_LIMITS.findings,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...Object.fromEntries(
            Object.entries(fields).map(([key, maxLength]) => [key, { type: "string", maxLength }]),
          ),
          impact: { type: "string", enum: IMPACTS },
          included: { type: "boolean" },
          hypothesis: { type: "boolean" },
          attribution: { type: "string", enum: ["user", "agent"] },
          includeSuggestion: { type: "boolean" },
        },
        required: [
          ...Object.keys(fields),
          "impact",
          "included",
          "hypothesis",
          "attribution",
          "includeSuggestion",
        ],
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};
const bytes = (text: string) => new TextEncoder().encode(text).length;
export function validateFindings(value: unknown): ReviewFinding[] {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "findings"
  )
    throw Error("Invalid feedback result. Drafts were preserved.");
  const findings = (value as { findings: unknown }).findings;
  if (
    !Array.isArray(findings) ||
    findings.length > FEEDBACK_LIMITS.findings ||
    bytes(JSON.stringify(value)) > FEEDBACK_LIMITS.dataBytes
  )
    throw Error("Feedback exceeds its limit. Drafts were preserved.");
  const ids = new Set<string>();
  for (const item of findings) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).length !== Object.keys(fields).length + 5 ||
      Object.entries(fields).some(
        ([key, max]) => typeof item[key] !== "string" || item[key].length > max,
      ) ||
      !IMPACTS.includes(item.impact) ||
      typeof item.included !== "boolean" ||
      typeof item.hypothesis !== "boolean" ||
      typeof item.includeSuggestion !== "boolean" ||
      !["user", "agent"].includes(item.attribution) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) ||
      ids.has(item.id) ||
      !item.area.trim() ||
      !item.description.trim() ||
      /[\r\n:]/.test(item.area) ||
      /[\r\n]/.test(item.description)
    )
      throw Error("Invalid finding. Drafts were preserved.");
    ids.add(item.id);
  }
  return structuredClone(findings);
}
export function revisionText(p: ReviewIdentity) {
  return `${p.repository} #${p.number}\nBase ${p.base}\nHead ${p.head}`;
}
export function feedbackText(
  findings: ReviewFinding[],
  revision: ReviewIdentity,
  references: Record<string, string> = {},
): FeedbackDraft {
  const selected = findings.filter((f) => f.included && !f.hypothesis);
  return {
    revision: {
      repository: revision.repository,
      number: revision.number,
      base: revision.base,
      head: revision.head,
    },
    author: selected.length
      ? selected.map((f) => `- ${f.area.trim()}-${f.impact}: ${f.description.trim()}`).join("\n")
      : "No included findings. This does not establish that the PR is free of problems.",
    agent: `${revisionText(revision)}\n\nThe author and their agent should verify this feedback and decide what to change.\n\n${selected.length ? selected.map((f) => `[${f.id}] ${f.area}-${f.impact}: ${f.description}\nEvidence: ${f.evidence || "Not supplied"}${Object.hasOwn(references, f.id) ? `\n${references[f.id]}` : ""}\nReasoning: ${f.reasoning || "Not supplied"}\nUncertainty: ${f.uncertainty || "Not supplied"}\nVerification: ${f.verification || "No checks supplied"}${f.includeSuggestion && f.suggestion.trim() ? `\nOptional suggestion, ${f.attribution}: ${f.suggestion}` : ""}`).join("\n\n") : "No included findings."}`,
  };
}
export function feedbackCopy(draft: FeedbackDraft, section: "author" | "agent" | "both") {
  if (
    !["author", "agent", "both"].includes(section) ||
    typeof draft.author !== "string" ||
    typeof draft.agent !== "string" ||
    (section !== "agent" && bytes(draft.author) > FEEDBACK_LIMITS.draftBytes) ||
    (section !== "author" && bytes(draft.agent) > FEEDBACK_LIMITS.draftBytes)
  )
    throw Error("Feedback editor exceeds its byte limit.");
  // Native clipboard text cannot preserve embedded control bytes reliably.
  if (
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
      section === "author"
        ? draft.author
        : section === "agent"
          ? draft.agent
          : draft.author + draft.agent,
    )
  )
    throw Error("Feedback contains unsupported control characters. Remove them before copying.");
  const text = `${section === "agent" ? draft.agent : section === "author" ? draft.author : `${draft.author}\n\n${draft.agent}`}\n\nFeedback revision\n${revisionText(draft.revision)}`;
  if (bytes(text) > FEEDBACK_LIMITS.copyBytes) throw Error("Feedback copy exceeds its limit.");
  return text;
}

export function feedbackReferences(
  findings: ReviewFinding[],
  artifacts: GuideArtifact[],
): Record<string, string> {
  const references: Record<string, string> = Object.create(null);
  let used = 0;
  for (const finding of findings) {
    const selected = artifacts.filter((a) => finding.evidence.includes(a.id));
    if (!selected.length) continue;
    const text = selected
      .map((a) => {
        const t = a.target;
        if (t.kind === "diagram")
          return `Diagram ${a.id}, agent-generated${a.invalid ? ", unavailable" : ""}.\n${t.messages.map((m) => `${t.nodes[m.from]} -> ${t.nodes[m.to]}: ${m.text}`).join("\n")}\n${t.sources.map((s) => `${s.path} ${s.side} lines ${s.line}-${s.endLine}, revision ${s.revision}`).join("\n")}`;
        if (t.kind === "image")
          return `Supplied image ${t.name}, ${t.image}, ${t.width}x${t.height}, revision ${t.revision}${a.invalid ? ", unavailable" : ""}. Image bytes are not included in this text handoff.`;
        if (t.kind === "source")
          return `${t.anchor.path} ${t.anchor.side} lines ${t.anchor.line}-${t.anchor.endLine}, revision ${t.anchor.revision}`;
        return `View target ${a.id}: ${t.lens}, ${t.view}`;
      })
      .join("\n");
    if (used + bytes(text) <= 7168) {
      references[finding.id] = text;
      used += bytes(text);
    } else
      references[finding.id] =
        "Artifact details omitted at export limit. Add pinned source references manually.";
  }
  return references;
}
