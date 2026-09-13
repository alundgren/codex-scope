import { test, expect } from "vite-plus/test";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { PRReview } from "../src/review.ts";
import { feedbackCopy, feedbackText } from "../src/review-feedback.ts";
const fixture = path.resolve("test/fixtures/review-gh.cjs");
async function setup() {
  const root = await mkdtemp("/tmp/scope-post-unit-");
  const review = new PRReview(path.join(root, "review"), async () => undefined, fixture);
  const pr = (await review.request({ action: "open", input: "example/shop #148" })).pr!;
  const draft = feedbackText([], pr);
  draft.author = "- access-high: Check ownership.\n\nUser edit: `code` & <literal>";
  draft.agent = "Verify independently.\nTwo lines.\n";
  const body = feedbackCopy(draft, "both");
  const control = (value: unknown) =>
    writeFile(path.join(root, "review-control.json"), JSON.stringify(value));
  const requests = async () =>
    (await readFile(path.join(root, "review-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).args as string[]);
  return {
    root,
    review,
    pr,
    body,
    control,
    requests,
    close: async () => {
      await review.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("posting sends exact multiline body to pinned destination once and cleans private body", async () => {
  const s = await setup();
  try {
    const request = { action: "post" as const, review: s.pr.id, body: s.body };
    const pending = s.review.posting.request(request);
    await expect(s.review.posting.request(request)).rejects.toThrow("pending");
    const result = await pending;
    expect(result.status).toBe("sent");
    expect(result.body).toBe(s.body);
    expect(result.comment?.url).toBe("https://github.com/example/shop/pull/148#issuecomment-1000");
    await expect(s.review.posting.request(request)).rejects.toThrow("already been sent");
    expect((await s.requests()).filter((args) => args[0] === "pr")).toHaveLength(1);
    expect(await readdir(path.join(s.root, "comment"))).toEqual([]);
    expect(
      JSON.parse(await readFile(path.join(s.root, "posted-comments.json"), "utf8"))[0].body,
    ).toBe(s.body);
  } finally {
    await s.close();
  }
});
test("stale head and definitive preflight failure preserve body without writing; explicit retry succeeds", async () => {
  const s = await setup();
  try {
    await s.control({ stale: true });
    const r = { action: "post" as const, review: s.pr.id, body: s.body };
    expect((await s.review.posting.request(r)).status).toBe("stale");
    await s.control({ postMode: "preflight-failed" });
    expect((await s.review.posting.request(r)).status).toBe("failed");
    expect((await s.requests()).filter((args) => args[0] === "pr")).toHaveLength(0);
    await s.control({});
    expect((await s.review.posting.request(r)).status).toBe("sent");
  } finally {
    await s.close();
  }
});
test("unchanged closed PR permits the explicit comment", async () => {
  const s = await setup();
  try {
    await s.control({ closed: true });
    const result = await s.review.posting.request({
      action: "post",
      review: s.pr.id,
      body: s.body,
    });
    expect(result.status).toBe("sent");
    expect(result.body).toBe(s.body);
    expect((await s.requests()).filter((args) => args[0] === "pr")).toHaveLength(1);
  } finally {
    await s.close();
  }
});
test("uncertain success is read-only verified and duplicate retry stays blocked", async () => {
  const s = await setup();
  try {
    await s.control({ postMode: "timeout" });
    const r = { action: "post" as const, review: s.pr.id, body: s.body };
    const uncertain = await s.review.posting.request(r);
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.body).toBe(s.body);
    await expect(s.review.posting.request(r)).rejects.toThrow("uncertain");
    expect((await s.review.request({ action: "end", id: s.pr.id })).error).toContain(
      "pending comment",
    );
    await s.control({});
    const verified = await s.review.posting.request({ action: "verify", review: s.pr.id });
    expect(verified.status).toBe("sent");
    expect((await s.requests()).filter((args) => args[0] === "pr")).toHaveLength(1);
    expect(await readdir(path.join(s.root, "comment"))).toEqual([]);
  } finally {
    await s.close();
  }
}, 20000);
test("ambiguous exact matches require explicit resolution; wrong account/body/time do not match", async () => {
  const s = await setup();
  try {
    await s.control({ postMode: "ambiguous" });
    await s.review.posting.request({ action: "post", review: s.pr.id, body: s.body });
    const file = path.join(s.root, "posted-comments.json"),
      comments = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify([
        ...comments,
        { ...comments[0], id: 5, user: { id: 3 } },
        { ...comments[0], body: "other" },
        { ...comments[0], created_at: "2000-01-01T00:00:00Z" },
      ]),
    );
    const checked = await s.review.posting.request({ action: "verify", review: s.pr.id });
    expect(checked.status).toBe("uncertain");
    expect(checked.candidates).toHaveLength(2);
    await expect(
      s.review.posting.request({ action: "resolve", review: s.pr.id, candidate: 999 }),
    ).rejects.toThrow("candidate");
    expect(
      (await s.review.posting.request({ action: "resolve", review: s.pr.id, candidate: 1001 }))
        .status,
    ).toBe("sent");
  } finally {
    await s.close();
  }
});
test("invalid byte limits and removed revision reject before gh; session switch during preflight cannot write", async () => {
  const s = await setup();
  try {
    const before = (await s.requests()).length;
    for (const body of [
      "x".repeat(65537),
      "edited without revision",
      "\0" + s.body,
      "\ud800" + s.body,
    ])
      await expect(
        s.review.posting.request({ action: "post", review: s.pr.id, body }),
      ).rejects.toThrow();
    expect((await s.requests()).length).toBe(before);
    await s.control({ preflightDelay: 300 });
    const pending = s.review.posting.request({ action: "post", review: s.pr.id, body: s.body });
    await new Promise((resolve) => setTimeout(resolve, 100));
    Reflect.set(s.review, "active", { ...s.pr, id: "other-review" });
    expect((await pending).status).toBe("failed");
    expect((await s.requests()).filter((args) => args[0] === "pr")).toHaveLength(0);
  } finally {
    await s.close();
  }
});
test("posting cannot overtake an already pending replacement", async () => {
  const s = await setup();
  try {
    await s.control({ preflightDelay: 250 });
    const switching = s.review.request({
      action: "open",
      input: "example/shop #149",
      replace: true,
    });
    const result = await s.review.posting.request({
      action: "post",
      review: s.pr.id,
      body: s.body,
    });
    expect(result.status).toBe("failed");
    expect((await switching).pr?.number).toBe(149);
    expect((await s.requests()).filter((args) => args[0] === "pr")).toHaveLength(0);
  } finally {
    await s.close();
  }
});
test("untrusted comment storage is rejected without cleanup deleting foreign files", async () => {
  const { mkdir, symlink } = await import("node:fs/promises");
  const root = await mkdtemp("/tmp/scope-post-storage-");
  await mkdir(path.join(root, "foreign"));
  await writeFile(path.join(root, "foreign/body.md"), "keep");
  await symlink(path.join(root, "foreign"), path.join(root, "comment"));
  const review = new PRReview(path.join(root, "review"), async () => undefined, fixture);
  await review.ready;
  await review.close();
  expect(await readFile(path.join(root, "foreign/body.md"), "utf8")).toBe("keep");
  await rm(root, { recursive: true, force: true });
});
