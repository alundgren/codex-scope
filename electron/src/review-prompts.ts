import type { ReviewLens } from "./review-session-types.ts";

export const PROMPT_LIMITS = { promptBytes: 8192, registryBytes: 7 * 8192 } as const;
export const PROMPT_REGISTRY_VERSION = 1;
export const REVIEW_PROMPTS = {
  base: {
    label: "Base review",
    version: 2,
    text: "Discuss the pinned pull request using supplied evidence. Explain concrete findings, uncertainty and relevant source references. Never claim to have run or verified the reviewed application. Missing or omitted evidence is unknown. Do not invent access or results. Use scope_guide to show relevant evidence and add bounded highlights, screenshot marks or sequence diagrams when they clarify the discussion. Use IDs and pinned revisions returned by scope_evidence. A retained target has not been shown. Respect Pause follow and never claim that retained or rejected navigation happened.",
  },
  Overview: {
    label: "Overview lens",
    version: 1,
    text: "Explain the intended behavior, main changes and important open questions.",
  },
  Security: {
    label: "Security lens",
    version: 1,
    text: "Inspect trust boundaries, authorization and concrete misuse cases in the supplied changes.",
  },
  UX: {
    label: "UX lens",
    version: 1,
    text: "Assess the complete affected user task, visible states, navigation and recovery using supplied evidence.",
  },
  Performance: {
    label: "Performance lens",
    version: 1,
    text: "Look for bounded resource use, expensive operations and responsiveness risks. Separate measurements from inference.",
  },
  Architecture: {
    label: "Architecture lens",
    version: 1,
    text: "Assess module responsibilities, dependencies, data contracts and the simplest coherent implementation.",
  },
  feedback: {
    label: "Feedback generation",
    version: 2,
    text: "Return structured findings from this review conversation using the supplied output contract. Reuse stable finding IDs from previous feedback. Use compact one-sentence descriptions and editable areas such as security, UX, performance, architecture or correctness. Cite file, side, line and revision or supplied evidence, including diagram source references. Include reasoning, uncertainty and concrete checks. Keep working hypotheses separate with hypothesis true and included false. Include optional suggestions only if discussed, with user or agent attribution; otherwise leave suggestion empty and includeSuggestion false. Return an empty findings array when there are no supported findings. Never invent verification or completed work.",
  },
} as const;
export type PromptId = keyof typeof REVIEW_PROMPTS;
export const PROMPT_IDS = Object.keys(REVIEW_PROMPTS) as PromptId[];
export interface PromptEdit {
  id: PromptId;
  text: string | null;
}
export interface PromptOverride {
  text: string;
  version: string;
}
export type PromptOverrides = Partial<Record<PromptId, PromptOverride>>;
export interface EffectivePrompt extends PromptOverride {
  id: PromptId;
}
export interface ReviewPromptSnapshot {
  registryVersion: number;
  base: EffectivePrompt;
  lens: EffectivePrompt;
}
export interface TurnPromptVersions {
  registryVersion: number;
  base: string;
  lens: string;
}
const encoder = new TextEncoder();
export function promptBytes(text: string) {
  return encoder.encode(text).byteLength;
}
export function validPromptId(id: unknown): id is PromptId {
  return typeof id === "string" && Object.hasOwn(REVIEW_PROMPTS, id);
}
export function validPromptText(text: unknown): text is string {
  return (
    typeof text === "string" &&
    text.length <= PROMPT_LIMITS.promptBytes &&
    !!text.trim() &&
    // Control characters are rejected before prompt persistence or submission.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) &&
    promptBytes(text) <= PROMPT_LIMITS.promptBytes
  );
}
export function validPromptOverrides(value: unknown): value is PromptOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    Object.entries(value).length <= PROMPT_IDS.length &&
    Object.entries(value).every(
      ([id, entry]) =>
        validPromptId(id) &&
        !!entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.keys(entry).length === 2 &&
        validPromptText(entry.text) &&
        typeof entry.version === "string" &&
        /^[0-9a-f-]{36}$/.test(entry.version),
    )
  );
}
export function effectivePrompt(id: PromptId, overrides: PromptOverrides): EffectivePrompt {
  const entry = overrides[id];
  const system = REVIEW_PROMPTS[id];
  if (entry && !validPromptText(entry.text)) throw Error("Invalid saved review prompt.");
  return {
    id,
    text: entry?.text ?? system.text,
    version: entry?.version ?? `system:${system.version}`,
  };
}
export function snapshotReviewPrompts(
  lens: ReviewLens | "feedback",
  overrides: PromptOverrides,
): ReviewPromptSnapshot {
  if (!validPromptOverrides(overrides)) throw Error("Invalid saved review prompts.");
  const base = effectivePrompt("base", overrides);
  const selected = effectivePrompt(lens, overrides);
  if (!validPromptText(base.text) || !validPromptText(selected.text))
    throw Error("Review prompt exceeds its byte limit.");
  return { registryVersion: PROMPT_REGISTRY_VERSION, base, lens: selected };
}
