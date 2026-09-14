import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
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
  await session.send(
    "Discuss this synthetic finding: invoice.ts head line 12 returns an invoice without checking ownership. This is unverified because middleware was not supplied. Proposed agent suggestion: check ownership at the service boundary. Verify by requesting another account's invoice. Reply briefly and do not use tools.",
    "Overview",
    selection,
  );
  while (["starting", "running"].includes(session.read(256).status))
    await new Promise((resolve) => setTimeout(resolve, 50));
  thread = Reflect.get(session, "thread");
  assert.equal(session.read(256).status, "ready");
  const prompts = snapshotReviewPrompts("feedback", {});
  await session.send(prompts.lens.text, "Overview", selection, prompts);
  while (["starting", "running"].includes(session.read(256).status))
    await new Promise((resolve) => setTimeout(resolve, 50));
  const state = session.read(256);
  assert.equal(state.status, "ready", state.error ?? "");
  assert.equal(Reflect.get(session, "thread"), thread);
  assert.equal(state.feedback?.error, null);
  assert.ok(state.feedback?.findings.length);
  result.feedback = {
    accepted: true,
    count: state.feedback.findings.length,
    promptVersion: state.prompts?.lens,
  };
  result.sameSession = true;
  await session.close();
  result.remaining = await readdir(path.join(root, "session"));
  assert.deepEqual(result.remaining, []);
  await mkdir("measurements", { recursive: true });
  await writeFile("measurements/review-feedback-cli.json", JSON.stringify(result, null, 2));
} finally {
  await session.close();
  await rm(root, { recursive: true, force: true });
}
