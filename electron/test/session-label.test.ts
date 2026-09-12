import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { eventContext, sessionLabel } from "../src/session-label.ts";
const git = {
  repo: "codex-scope",
  branch: "identify-sessions",
  observed_at: "2026-09-12T12:00:00Z",
};
test("labels prefer Git, recognize T3 worktrees, and fall back without invalidating events", () => {
  assert.equal(eventContext("/tmp/worktree", git), "codex-scope · identify-sessions");
  assert.equal(
    eventContext("/tmp/worktree", { ...git, branch: null }),
    "codex-scope · branch unavailable",
  );
  assert.equal(
    eventContext("/workspace/.t3/worktrees/codex-scope/t3code-abcd/subdir", null),
    "codex-scope / t3code-abcd",
  );
  assert.equal(eventContext("/workspace/project/", { ...git, repo: 1 }), "project");
  assert.equal(eventContext("relative", null), undefined);
  assert.equal(eventContext("/" + "x".repeat(4096), null), undefined);
  assert.equal(eventContext("/workspace/project", { ...git, branch: "x".repeat(513) }), "project");
  assert.equal(eventContext("/workspace/project", { ...git, observed_at: "invalid" }), "project");
  assert.equal(
    eventContext("/workspace/project", { ...git, branch: "a\n\u202eb" }),
    "codex-scope · a b",
  );
  assert.equal(eventContext("/" + "x".repeat(300), null)?.length, 160);
  assert.equal(
    sessionLabel("11111111-2222-4333-8444-000000000001", "codex-scope · identify-sessions"),
    "codex-scope · identify-sessions · …00000001",
  );
  assert.equal(sessionLabel("full-session-id"), "full-session-id");
});
