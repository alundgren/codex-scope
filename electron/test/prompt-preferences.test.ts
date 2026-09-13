import { test, expect } from "vite-plus/test";
import { mkdtemp, readFile, stat, writeFile, rm, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  loadPromptPreferences,
  savePromptPreferences,
  PROMPT_PREFERENCES_BYTES,
} from "../src/prompt-preferences.ts";
import {
  REVIEW_PROMPTS,
  PROMPT_IDS,
  effectivePrompt,
  snapshotReviewPrompts,
  validPromptText,
  type PromptOverrides,
} from "../src/review-prompts.ts";

test("all review defaults register and are bounded, including feedback", () => {
  expect(PROMPT_IDS).toEqual([
    "base",
    "Overview",
    "Security",
    "UX",
    "Performance",
    "Architecture",
    "feedback",
  ]);
  for (const prompt of Object.values(REVIEW_PROMPTS))
    expect(validPromptText(prompt.text)).toBe(true);
  for (const invalid of ["", " ", "\0", "x".repeat(8193), "é".repeat(4097), null])
    expect(validPromptText(invalid)).toBe(false);
  expect(validPromptText("é".repeat(4096))).toBe(true);
});

test("private explicit overrides persist independently and reverting follows later shipped defaults", async () => {
  const root = await mkdtemp("/tmp/scope-prompts-");
  const file = path.join(root, "review-prompts.json");
  try {
    let saved = await loadPromptPreferences(file);
    expect(saved).toEqual({});
    saved = await savePromptPreferences(file, saved, {
      id: "base",
      text: "Keep explanations concise.",
    });
    const base = saved.base;
    saved = await savePromptPreferences(file, saved, {
      id: "Security",
      text: "Prioritize authorization.",
    });
    expect(saved.base).toEqual(base);
    expect(await loadPromptPreferences(file)).toEqual(saved);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const snapshot = snapshotReviewPrompts("Security", saved);
    const oldSecurity = saved.Security;
    saved = await savePromptPreferences(file, saved, { id: "Security", text: null });
    expect(saved.base).toEqual(base);
    expect(saved.Security).toBeUndefined();
    expect(snapshot.lens.text).toBe(oldSecurity!.text);
    expect(effectivePrompt("Security", saved).version).toBe("system:1");
    // Simulate a new shipped revision while the persisted document remains unchanged.
    const system = REVIEW_PROMPTS.Security as { text: string; version: number };
    const prior = { ...system };
    try {
      system.text = "New shipped authorization guidance.";
      system.version = 2;
      expect(effectivePrompt("Security", await loadPromptPreferences(file)).text).toBe(system.text);
      expect(effectivePrompt("base", await loadPromptPreferences(file)).text).toBe(base!.text);
    } finally {
      Object.assign(system, prior);
    }
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, overrides: { base } });
    expect(await readdir(root)).toEqual(["review-prompts.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed and invalid saves preserve prior effective values and original private bytes", async () => {
  const root = await mkdtemp("/tmp/scope-prompt-failure-");
  const file = path.join(root, "review-prompts.json");
  try {
    const saved = await savePromptPreferences(file, {}, { id: "UX", text: "Inspect recovery." });
    const before = await readFile(file);
    for (const text of ["", "é".repeat(4097), "bad\0text"])
      await expect(savePromptPreferences(file, saved, { id: "UX", text })).rejects.toThrow();
    await mkdir(path.join(root, ".prompt-preferences.tmp"));
    await expect(
      savePromptPreferences(file, saved, { id: "UX", text: "New draft" }),
    ).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
    expect(effectivePrompt("UX", saved).text).toBe("Inspect recovery.");
    await rm(path.join(root, ".prompt-preferences.tmp"), { recursive: true });
    const recovered = await savePromptPreferences(file, saved, { id: "UX", text: "New draft" });
    expect(recovered.UX!.version).not.toBe(saved.UX!.version);
    await writeFile(file, JSON.stringify({ version: 99, overrides: {} }));
    await expect(loadPromptPreferences(file)).rejects.toThrow("Saved prompts");
    await writeFile(file, "x".repeat(PROMPT_PREFERENCES_BYTES + 1));
    await expect(loadPromptPreferences(file)).rejects.toThrow("Saved prompts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maximum seven UTF-8 overrides remain within the private document budget", async () => {
  const root = await mkdtemp("/tmp/scope-prompt-max-");
  const file = path.join(root, "review-prompts.json");
  try {
    let saved: PromptOverrides = {};
    for (const id of PROMPT_IDS)
      saved = await savePromptPreferences(file, saved, { id, text: "x" + "\t".repeat(8191) });
    expect((await stat(file)).size).toBeLessThan(PROMPT_PREFERENCES_BYTES);
    expect(await loadPromptPreferences(file)).toEqual(saved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
