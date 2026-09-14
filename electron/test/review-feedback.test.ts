import { describe, it, expect } from "vite-plus/test";
import {
  feedbackText,
  feedbackCopy,
  validateFindings,
  FEEDBACK_LIMITS,
  type ReviewFinding,
} from "../src/review-feedback.ts";
const revision = {
  repository: "example/repo",
  number: 9,
  base: "a".repeat(40),
  head: "b".repeat(40),
};
const finding: ReviewFinding = {
  id: "F1",
  area: "security",
  impact: "high",
  description: "Check ownership before returning the invoice.",
  evidence: "invoice.ts head line 12",
  reasoning: "Another account can supply the same identifier.",
  uncertainty: "Middleware is unknown.",
  verification: "Request an invoice owned by another account.",
  included: true,
  hypothesis: false,
  suggestion: "Check ownership in the service.",
  attribution: "agent",
  includeSuggestion: true,
};
describe("review feedback", () => {
  it("formats exact leading bullets and includes evidence, uncertainty, checks and attributed suggestions only when selected", () => {
    const findings = validateFindings({
      findings: [
        finding,
        { ...finding, id: "F2", included: false },
        { ...finding, id: "F3", hypothesis: true },
      ],
    });
    const draft = feedbackText(findings, revision);
    expect(draft.author).toBe("- security-high: Check ownership before returning the invoice.");
    expect(draft.agent).toContain("[F1]");
    expect(draft.agent).not.toContain("[F2]");
    expect(draft.agent).not.toContain("[F3]");
    for (const text of [
      finding.evidence,
      finding.reasoning,
      finding.uncertainty,
      finding.verification,
      "Optional suggestion, agent:",
    ])
      expect(draft.agent).toContain(text);
    expect(feedbackText([{ ...finding, includeSuggestion: false }], revision).agent).not.toContain(
      finding.suggestion,
    );
    expect(feedbackText([{ ...finding, attribution: "user" }], revision).agent).toContain(
      "Optional suggestion, user:",
    );
  });
  it("keeps an honest empty result and original revision in every edited copy", () => {
    const draft = feedbackText([], revision);
    expect(draft.author).toContain("No included findings");
    draft.author = "Edited author";
    draft.agent = "Edited agent";
    for (const section of ["author", "agent", "both"] as const)
      expect(feedbackCopy(draft, section)).toContain(revision.head);
    expect(feedbackCopy(draft, "both")).toContain("Edited author\n\nEdited agent");
  });
  it("rejects duplicate IDs, excess findings, multiline bullets and byte overflow before acceptance", () => {
    for (const findings of [
      [finding, finding],
      Array.from({ length: 9 }, (_, i) => ({ ...finding, id: `F${i}` })),
      [{ ...finding, description: "bad\nline" }],
      [{ ...finding, area: "bad:area" }],
    ])
      expect(() => validateFindings({ findings })).toThrow();
    expect(() =>
      feedbackCopy(
        { ...feedbackText([], revision), author: "界".repeat(FEEDBACK_LIMITS.draftBytes) },
        "author",
      ),
    ).toThrow();
  });
});

it("copies diagram meaning and pinned references only for included linked findings", async () => {
  const { feedbackReferences } = await import("../src/review-feedback.ts");
  const f = { ...finding, evidence: "Diagram diagram-1" };
  const refs = feedbackReferences(
    [f],
    [
      {
        id: "diagram-1",
        review: "review-1",
        invalid: false,
        target: {
          kind: "diagram",
          nodes: ["Reader", "Store"],
          messages: [{ from: 0, to: 1, text: "Read invoice" }],
          sources: [
            {
              id: "source-1",
              path: "invoice.ts",
              side: "head",
              revision: revision.head,
              line: 12,
              endLine: 14,
            },
          ],
        },
      },
    ],
  );
  const draft = feedbackText([f], revision, refs);
  expect(draft.agent).toContain("Reader -> Store: Read invoice");
  expect(draft.agent).toContain(`invoice.ts head lines 12-14, revision ${revision.head}`);
  expect(feedbackText([{ ...f, included: false }], revision, refs).agent).not.toContain(
    "Read invoice",
  );
});

it("rejects embedded clipboard control bytes without changing text", () => {
  const draft = feedbackText([finding], revision);
  draft.author = "before\0after";
  expect(() => feedbackCopy(draft, "both")).toThrow("control characters");
  expect(draft.author).toBe("before\0after");
});

it("treats special object-key IDs as ordinary finding IDs", () => {
  const draft = feedbackText([{ ...finding, id: "constructor" }], revision);
  expect(draft.agent).not.toContain("function Object");
  expect(draft.agent).toContain("[constructor]");
});

it("copies a valid section independently of an oversized unselected draft", () => {
  const draft = feedbackText([], revision);
  draft.agent = "X".repeat(40000);
  expect(feedbackCopy(draft, "author")).toContain("No included findings");
  expect(() => feedbackCopy(draft, "agent")).toThrow();
});
