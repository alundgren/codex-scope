import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ReviewSession } from "../src/review-session.ts";
import type { PRReview } from "../src/review.ts";
import { snapshotReviewPrompts } from "../src/review-prompts.ts";
const root = await mkdtemp("/tmp/scope-prompt-probe-");
const review = {
  identity: () => ({ repository: "synthetic/example", number: 1, head: "a".repeat(40) }),
} as unknown as PRReview;
const session = new ReviewSession("synthetic-review", review, path.join(root, "session"));
const selection = { model: "gpt-6-astra", effort: "low" };
const result: Record<string, unknown> = {
  environment: "Installed Codex CLI, synthetic identity, no source access requested",
  selection,
};
let thread = "";
try {
  for (const [index, lens] of (["Overview", "Security"] as const).entries()) {
    const marker = index === 0 ? "PROMPT_FIRST" : "PROMPT_SECOND";
    const prompts = snapshotReviewPrompts(lens, {
      base: {
        text: `For this turn reply with exactly ${marker} and nothing else.`,
        version: randomUUID(),
      },
      [lens]: {
        text: "Follow the current turn's base review instructions.",
        version: randomUUID(),
      },
    });
    await session.send("Respond using the current instructions.", lens, selection, prompts);
    const deadline = Date.now() + 120000;
    while (["starting", "running"].includes(session.read(256).status) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const state = session.read(256);
    if (thread) assert.equal(Reflect.get(session, "thread"), thread);
    else thread = Reflect.get(session, "thread");
    assert.ok(thread);
    assert.equal(state.status, "ready", state.error ?? "Turn deadline exceeded");
    const reply = state.entries.filter((entry) => entry.role === "assistant").at(-1)!;
    assert.equal(reply.text.trim(), marker);
    assert.equal(reply.prompts.base, prompts.base.version);
    result[`turn${index + 1}`] = {
      exactExpectedReply: true,
      lens,
      prompts: state.prompts,
      selection: state.selection,
    };
  }
  result.sameSession = true;
  await session.close();
  result.remaining = await readdir(path.join(root, "session"));
  assert.deepEqual(result.remaining, []);
  await mkdir("measurements", { recursive: true });
  await writeFile("measurements/review-prompt-cli.json", JSON.stringify(result, null, 2));
} finally {
  await session.close();
  await rm(root, { recursive: true, force: true });
}
