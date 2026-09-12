import { test, expect } from "vite-plus/test";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { PRReview, parsePR, parsePatch, pngDimensions, runGh } from "../src/review.ts";
const fixture = path.resolve("test/fixtures/review-gh.cjs");
async function setup(initial: unknown = {}) {
  const root = await mkdtemp("/tmp/scope-review-unit-");
  const review = new PRReview(path.join(root, "review"), async () => undefined, fixture);
  const control = (value: unknown) =>
    writeFile(path.join(root, "review-control.json"), JSON.stringify(value));
  await control(initial);
  const opened = await review.request({ action: "open", input: "example/shop #148" });
  expect(opened.error).toBeUndefined();
  return { root, review, control, pr: opened.pr! };
}
test("PR input rejects commands, non-GitHub hosts and invalid numbers", () => {
  expect(parsePR("https://github.com/example/shop/pull/148")).toEqual({
    repository: "example/shop",
    number: 148,
  });
  expect(parsePR("example/shop 148").number).toBe(148);
  for (const input of [
    "$(id)",
    "example/shop #-1",
    "https://evil.test/example/shop/pull/148",
    "https://github.com/a/b/pull/1?x=y",
    "a/b;echo x #1",
  ])
    expect(() => parsePR(input)).toThrow();
});
test("patch validates both sides and detects incomplete hunks", () => {
  expect(parsePatch("@@ -2,2 +2,2 @@\n-old\n+new\n same")).toEqual([
    { base: null, head: null, text: "@@ -2,2 +2,2 @@", kind: "header" },
    { base: 2, head: null, text: "old", kind: "delete" },
    { base: null, head: 2, text: "new", kind: "add" },
    { base: 3, head: 3, text: "same", kind: "context" },
  ]);
  expect(() => parsePatch("@@ -1,5 +1,5 @@\n one")).toThrow("incomplete");
});
test("pinned fork and rename source use correct repositories and comparison base, pages omit patches", async () => {
  const { root, review, pr } = await setup();
  try {
    const page = await review.request({ action: "files", id: pr.id, page: 1 });
    expect(page.files).toHaveLength(10);
    expect(JSON.stringify(page)).not.toContain("export const");
    expect(pr.diffBase).toBe("c".repeat(40));
    for (const mode of ["base", "head"] as const) {
      const content = await review.request({
        action: "content",
        id: pr.id,
        path: "src/renamed.ts",
        mode,
        offset: 0,
      });
      expect(content.content?.rows).toHaveLength(200);
    }
    const requests = (await readFile(path.join(root, "review-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x).args[3]);
    expect(requests).toContain(`repos/example/shop/contents/src/old.ts?ref=${pr.diffBase}`);
    expect(requests).toContain(`repos/contributor/shop/contents/src/renamed.ts?ref=${pr.head}`);
    expect(requests.filter((x: string) => x.includes("/contents/"))).toHaveLength(2);
  } finally {
    await review.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("missing binary deleted added oversized and truncated evidence remains explicit", async () => {
  const { root, review, pr } = await setup();
  try {
    await review.request({ action: "files", id: pr.id, page: 1 });
    for (const [file, mode, expected] of [
      ["asset.bin", "head", "Binary"],
      ["missing.txt", "head", "failed"],
      ["large.ts", "head", "limit"],
      ["truncated.ts", "diff", "incomplete"],
    ] as const) {
      expect(
        (await review.request({ action: "content", id: pr.id, path: file, mode, offset: 0 })).error,
      ).toContain(expected);
    }
    for (const [file, mode] of [
      ["deleted.ts", "head"],
      ["added.ts", "base"],
    ] as const)
      expect(
        (await review.request({ action: "content", id: pr.id, path: file, mode, offset: 0 }))
          .content?.omission,
      ).toContain("does not exist");
    expect(
      (
        await review.request({
          action: "content",
          id: pr.id,
          path: "large.ts",
          mode: "diff",
          offset: 0,
        })
      ).content?.omission,
    ).toContain("128 KiB");
  } finally {
    await review.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("refresh and replacement are explicit, stale page reads keep pinned review", async () => {
  const { root, review, control, pr } = await setup();
  try {
    await control({ stale: true });
    expect(await review.request({ action: "refresh", id: pr.id })).toEqual({ changed: true });
    expect((await review.request({ action: "files", id: pr.id, page: 1 })).error).toContain(
      "changed",
    );
    expect((await review.request({ action: "open", input: "example/shop #2" })).error).toContain(
      "Leave",
    );
    const next = await review.request({ action: "open", input: "example/shop #2", replace: true });
    expect(next.pr?.head).toBe("d".repeat(40));
    expect((await review.request({ action: "refresh", id: pr.id })).error).toContain("ended");
  } finally {
    await review.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("command cancellation, missing CLI and response limits recover without a queue", async () => {
  const { root, review, control, pr } = await setup();
  try {
    await control({ mode: "hang" });
    const pending = review.request({ action: "refresh", id: pr.id });
    await new Promise((r) => setTimeout(r, 150));
    expect((await review.request({ action: "refresh", id: pr.id })).error).toContain("running");
    review.cancel();
    expect((await pending).error).toContain("cancelled");
    await control({ mode: "oversized" });
    expect((await review.request({ action: "refresh", id: pr.id })).error).toContain("limit");
    await control({});
    expect(await review.request({ action: "refresh", id: pr.id })).toEqual({ changed: false });
    await expect(
      runGh([], new AbortController().signal, root, "/not-installed-gh"),
    ).rejects.toThrow("unavailable");
    expect(await readdir(path.join(root, "review"))).toEqual([]);
  } finally {
    await review.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("PNG pixel checks happen from encoded headers before decoding", () => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  expect(pngDimensions(bytes)).toEqual({ width: 1, height: 1 });
  bytes.writeUInt32BE(10000000, 16);
  expect(() => pngDimensions(bytes)).toThrow("pixels");
  expect(() => pngDimensions(Buffer.from("jpeg"))).toThrow("PNG");
});

test("screenshots are bounded, revision attributed, removed and never restored", async () => {
  const root = await mkdtemp("/tmp/scope-review-images-");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const supplied = path.join(root, "supplied.png");
  await writeFile(supplied, png);
  const directory = path.join(root, "review");
  const review = new PRReview(directory, async () => supplied, fixture);
  try {
    const pr = (await review.request({ action: "open", input: "example/shop #148" })).pr!;
    const attached = await review.request({ action: "attach", id: pr.id });
    expect(attached.images?.[0]).toMatchObject({
      name: "supplied.png",
      head: pr.head,
      base: pr.base,
      width: 1,
      height: 1,
    });
    const image = attached.images![0];
    const url = (await review.request({ action: "image", id: pr.id, image: image.id })).imageUrl!;
    expect(await review.readImage(url)).toEqual(png);
    expect(await review.readImage("scope://app/review-image/unknown")).toBeNull();
    for (let i = 0; i < 3; i++) await review.request({ action: "attach", id: pr.id });
    expect((await review.request({ action: "attach", id: pr.id })).error).toContain(
      "Four screenshots",
    );
    await review.request({ action: "remove-image", id: pr.id, image: image.id });
    expect((await review.request({ action: "image", id: pr.id, image: image.id })).error).toContain(
      "no longer",
    );
    await review.close();
    expect(await readdir(directory)).toEqual([]);
    await writeFile(path.join(directory, "image-deadbeef.png"), png, { mode: 0o600 });
    const next = new PRReview(directory, async () => undefined, fixture);
    await next.ready;
    expect(await readdir(directory)).toEqual([]);
    await next.close();
  } finally {
    await review.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("browsing a new file page keeps the selected source available", async () => {
  const { root, review, pr } = await setup({ large: true });
  try {
    await review.request({ action: "files", id: pr.id, page: 1 });
    await review.request({
      action: "content",
      id: pr.id,
      path: "src/checkout/submit.ts",
      mode: "diff",
      offset: 0,
    });
    expect((await review.request({ action: "files", id: pr.id, page: 2 })).files).toHaveLength(10);
    expect(
      (
        await review.request({
          action: "content",
          id: pr.id,
          path: "src/checkout/submit.ts",
          mode: "diff",
          offset: 200,
        })
      ).content?.rows.length,
    ).toBeGreaterThan(0);
  } finally {
    await review.close();
    await rm(root, { recursive: true, force: true });
  }
});
