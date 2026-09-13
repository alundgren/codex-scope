import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ReviewSession } from "../src/review-session.ts";
import type { PRReview } from "../src/review.ts";
let root: string, original: string | undefined, sessions: ReviewSession[];
beforeEach(async () => {
  root = await mkdtemp("/tmp/scope-conversation-");
  await mkdir(path.join(root, "auth"));
  await writeFile(path.join(root, "auth", "auth.json"), "{}", { mode: 0o600 });
  original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, "auth");
  sessions = [];
});
afterEach(async () => {
  await Promise.all(sessions.map((s) => s.close()));
  if (original === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = original;
  await rm(root, { recursive: true, force: true });
});
const review = {
  identity: (id: string) => {
    if (id !== "review-1") throw Error("Wrong review");
    return { repository: "example/repo", number: 1, head: "a".repeat(40) };
  },
  toolImages: () => [],
  toolList: async () => [{ path: "a.ts", type: "blob", oid: "b".repeat(40) }],
} as unknown as PRReview;
function session() {
  const s = new ReviewSession("review-1", review, path.join(root, "session"), process.execPath, [
    path.resolve("test/fixtures/review-cli.cjs"),
  ]);
  sessions.push(s);
  return s;
}
async function wait(s: ReviewSession, status: string) {
  await expect.poll(() => s.read(256).status, { timeout: 5000 }).toBe(status);
}
const selection = { model: "test-success", effort: "low" };
describe("temporary review session", () => {
  it("keeps a thread across turns, ignores stale and duplicate completion, and clears owned files", async () => {
    const s = session();
    await s.send("First turn", "Overview", selection);
    await wait(s, "ready");
    await s.send("Second turn", "Security", { model: "other-model", effort: "high" });
    await wait(s, "ready");
    expect(s.read(256).selection).toEqual(selection);
    expect(s.export()).not.toContain("STALE");
    expect(s.read(256).entries.filter((e) => e.role === "assistant")).toHaveLength(2);
    expect(s.export()).toContain("Security");
    await s.close();
    expect(await readdir(path.join(root, "session"))).toEqual([]);
  });
  it("answers a bounded source callback and cancels a live turn", async () => {
    const s = session();
    await s.send("source", "Overview", selection);
    await wait(s, "ready");
    expect(s.export()).toContain("Evidence request completed");
    await s.send("slow", "Performance", selection);
    await wait(s, "running");
    await s.stop();
    await wait(s, "ready");
    expect(
      s.read(256).entries.filter((e) => e.text.startsWith("Using scope_evidence")),
    ).toHaveLength(1);
  });
  for (const mode of ["malformed", "oversized", "approval", "exit-fixture"])
    it(`preserves copy after ${mode}`, async () => {
      const s = session();
      await s.send(mode, "Overview", selection);
      await wait(s, "failed");
      expect(s.export()).toContain(mode);
      await expect(s.send("retry", "UX", selection)).rejects.toThrow();
    });
  it("stops at retained history capacity and preserves accepted text for copy", async () => {
    const s = session();
    await s.send("capacity", "Overview", selection);
    await wait(s, "capacity");
    expect(Buffer.byteLength(s.export())).toBeLessThan(530000);
    expect(s.export()).toContain("Conversation capacity reached");
  });
});

it("rejects newly discovered skill metadata before a later turn", async () => {
  const s = session();
  await s.send("changed-skills", "Overview", selection);
  await wait(s, "ready");
  await s.send("next", "Overview", selection);
  await wait(s, "failed");
  expect(s.read(256).error).toContain("Local skill configuration changed");
});
it("bounds entry count without evicting earlier conversation", async () => {
  const s = session();
  for (let i = 0; i < 140; i++) {
    await s.send(`Question ${i}`, "Overview", selection);
    await expect.poll(() => s.read(256).status).not.toBe("running");
    if (s.read(256).status === "capacity") break;
  }
  expect(s.read(256).status).toBe("capacity");
  expect(s.read(0).entries[0].text).toBe("Question 0");
  expect(s.read(256).total).toBe(256);
});
it("close during startup does not leave a child or owned work directory", async () => {
  const s = session();
  const sending = s.send("First", "Overview", selection);
  await s.close();
  await sending;
  expect(s.ownsProcess).toBe(false);
  expect(await readdir(path.join(root, "session"))).toEqual([]);
});

it("bounds ignored protocol traffic as well as accepted conversation", async () => {
  const s = session();
  await s.send("protocol-capacity", "Overview", selection);
  await wait(s, "capacity");
  expect(s.read(256).error).toContain("protocol capacity");
  expect(s.export().length).toBeLessThan(1000);
});

it("stops visibly when CLI context compaction occurs", async () => {
  const s = session();
  await s.send("compaction", "Overview", selection);
  await wait(s, "capacity");
  expect(s.read(256).error).toContain("shortened its model context");
  expect(s.export()).toContain("compaction");
});

it("rejects a no-writer auth FIFO and permits immediate cleanup", async () => {
  const auth = path.join(root, "auth", "auth.json");
  await rm(auth);
  execFileSync("mkfifo", ["-m", "600", auth]);
  const s = session();
  await s.send("First turn", "Overview", selection);
  await wait(s, "failed");
  await s.close();
  expect(await readdir(path.join(root, "session"))).toEqual([]);
}, 2000);

it("snapshots base and lens versions before startup and applies saved edits to the next turn", async () => {
  const { snapshotReviewPrompts } = await import("../src/review-prompts.ts");
  const { randomUUID } = await import("node:crypto");
  const prompts = snapshotReviewPrompts("Security", {
    base: { text: "BASE FIRST", version: randomUUID() },
    Security: { text: "LENS FIRST", version: randomUUID() },
  });
  const s = session();
  const sending = s.send("echo-prompts", "Security", selection, prompts);
  const firstVersion = prompts.base.version;
  prompts.base.text = "BASE SECOND";
  prompts.base.version = randomUUID();
  prompts.lens.text = "LENS SECOND";
  prompts.lens.version = randomUUID();
  await sending;
  await wait(s, "ready");
  expect(s.export()).toContain("BASE FIRST");
  expect(s.export()).not.toContain("BASE SECOND");
  expect(s.read(0).entries[0].prompts.base).toBe(firstVersion);
  await s.send("echo-prompts next", "Security", selection, prompts);
  await wait(s, "ready");
  expect(s.export()).toContain("BASE SECOND");
  expect(s.export()).toContain("LENS SECOND");
  expect(s.read(0).entries[0].prompts.base).toBe(firstVersion);
  expect(s.read(0).prompts!.base).toBe(prompts.base.version);
  const invalid = structuredClone(prompts);
  invalid.base.text = "x".repeat(8193);
  const count = s.read(0).total;
  await expect(s.send("invalid", "Security", selection, invalid)).rejects.toThrow();
  expect(s.read(0).total).toBe(count);
});

it("generates feedback in the same thread with the registry prompt and preserves results after interruption", async () => {
  const { snapshotReviewPrompts } = await import("../src/review-prompts.ts");
  const s = session();
  await s.send("First review turn", "Overview", selection);
  await wait(s, "ready");
  const thread = Reflect.get(s, "thread");
  await s.send("Generate now", "Overview", selection, snapshotReviewPrompts("feedback", {}));
  await wait(s, "ready");
  expect(Reflect.get(s, "thread")).toBe(thread);
  expect(s.read(256).feedback?.error).toBeNull();
  expect(s.read(256).feedback?.findings[0]?.id).toBe("F1");
  await s.send("slow", "Overview", selection, snapshotReviewPrompts("feedback", {}));
  await s.stop();
  await wait(s, "ready");
  expect(s.read(256).feedback?.error).toContain("interrupted");
  expect(s.read(256).feedback?.findings[0]?.id).toBe("F1");
});

it("accepts honest empty feedback and preserves it after invalid generation", async () => {
  const { snapshotReviewPrompts } = await import("../src/review-prompts.ts");
  const s = session();
  await s.send("no-findings", "Overview", selection, snapshotReviewPrompts("feedback", {}));
  await wait(s, "ready");
  expect(s.read(256).feedback?.findings).toEqual([]);
  expect(s.read(256).feedback?.error).toBeNull();
  await s.send("malformed", "Overview", selection, snapshotReviewPrompts("feedback", {}));
  await wait(s, "failed");
  expect(s.read(256).feedback?.findings).toEqual([]);
});
