import { test, expect, vi } from "vite-plus/test";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rm: vi.fn(actual.rm) };
});
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
      .map((line) => JSON.parse(line).args as string[]);
    expect(
      requests.some(
        (args) => args.includes(`expression=${pr.diffBase}:src`) && args.includes("owner=example"),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (args) => args.includes(`expression=${pr.head}:src`) && args.includes("owner=contributor"),
      ),
    ).toBe(true);
    for (const [repository, name] of [
      ["example/shop", "src/old.ts"],
      ["contributor/shop", "src/renamed.ts"],
    ])
      expect(
        requests.some((args) =>
          args.includes(
            `repos/${repository}/git/blobs/${createHash("sha1").update(name).digest("hex")}`,
          ),
        ),
      ).toBe(true);
    expect(requests.filter((args) => args.some((x) => x.includes("/git/blobs/")))).toHaveLength(2);
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

test("FIFO screenshots reject promptly and leave the review usable", async () => {
  const root = await mkdtemp("/tmp/scope-review-fifo-"),
    file = path.join(root, "supplied.png");
  execFileSync("mkfifo", [file]);
  const review = new PRReview(path.join(root, "review"), async () => file, fixture);
  try {
    const pr = (await review.request({ action: "open", input: "example/shop #148" })).pr!;
    const start = performance.now();
    const result = await review.request({ action: "attach", id: pr.id });
    expect(result.error).toContain("regular");
    expect(performance.now() - start).toBeLessThan(500);
    expect(await review.request({ action: "refresh", id: pr.id })).toEqual({ changed: false });
    expect(await readdir(path.join(root, "review"))).toEqual([]);
  } finally {
    await review.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("partial writes are removed and failed cleanup blocks attachment until End recovers", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const root = await mkdtemp("/tmp/scope-review-write-"),
    file = path.join(root, "supplied.png"),
    directory = path.join(root, "review");
  await writeFile(
    file,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const review = new PRReview(directory, async () => file, fixture);
  try {
    const pr = (await review.request({ action: "open", input: "example/shop #148" })).pr!;
    vi.mocked(writeFile).mockImplementation(async (destination, ...args) => {
      if (
        typeof destination === "string" &&
        destination.startsWith(path.join(directory, "image-"))
      ) {
        await actual.writeFile(destination, Buffer.alloc(32), { mode: 0o600 });
        throw new Error("ENOSPC");
      }
      return actual.writeFile(destination, ...args);
    });
    for (let i = 0; i < 5; i++) {
      expect((await review.request({ action: "attach", id: pr.id })).error).toContain(
        "could not be saved",
      );
      expect(await readdir(directory)).toEqual([]);
    }
    vi.mocked(rm).mockImplementation(async (destination, ...args) => {
      if (typeof destination === "string" && destination.startsWith(path.join(directory, "image-")))
        throw new Error("EACCES");
      return actual.rm(destination, ...args);
    });
    expect((await review.request({ action: "attach", id: pr.id })).error).toContain(
      "save and cleanup failed",
    );
    expect(await readdir(directory)).toHaveLength(1);
    expect((await review.request({ action: "attach", id: pr.id })).error).toContain(
      "cleanup failed",
    );
    expect(await readdir(directory)).toHaveLength(1);
    expect((await review.request({ action: "images", id: pr.id })).images).toEqual([]);
    vi.mocked(rm).mockImplementation(actual.rm);
    vi.mocked(writeFile).mockImplementation(actual.writeFile);
    expect(await review.request({ action: "end", id: pr.id })).toEqual({});
    expect(await readdir(directory)).toEqual([]);
    const next = (await review.request({ action: "open", input: "example/shop #149" })).pr!;
    expect((await review.request({ action: "attach", id: next.id })).images).toHaveLength(1);
  } finally {
    vi.mocked(rm).mockImplementation(actual.rm);
    vi.mocked(writeFile).mockImplementation(actual.writeFile);
    await review.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("symlink and submodule entries never become source line anchors", async () => {
  const { root, review, pr } = await setup();
  try {
    await review.request({ action: "files", id: pr.id, page: 1 });
    for (const name of ["link.ts", "dependency"]) {
      const result = await review.request({
        action: "content",
        id: pr.id,
        path: name,
        mode: "head",
        offset: 0,
      });
      expect(result.error).toContain("Symlink and submodule");
      expect(result.content).toBeUndefined();
    }
    const requests = await readFile(path.join(root, "review-requests.jsonl"), "utf8");
    expect(requests).not.toContain("/git/blobs/");
  } finally {
    await review.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized parent directories omit source before reading a blob", async () => {
  const { root, review, control, pr } = await setup();
  try {
    await review.request({ action: "files", id: pr.id, page: 1 });
    await control({ mode: "tree-pressure" });
    const result = await review.request({
      action: "content",
      id: pr.id,
      path: "src/checkout/submit.ts",
      mode: "head",
      offset: 0,
    });
    expect(result.error).toContain("10,000-entry");
    expect(await readFile(path.join(root, "review-requests.jsonl"), "utf8")).not.toContain(
      "/git/blobs/",
    );
  } finally {
    await review.close();
    await rm(root, { recursive: true, force: true });
  }
});
