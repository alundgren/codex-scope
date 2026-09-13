import { test, expect } from "vite-plus/test";
import { ReviewTools } from "../src/review-tools.ts";
import type { PRReview } from "../src/review.ts";
const signal = new AbortController().signal;
const payload = (r: any) => JSON.parse(r.contentItems[0].text);
function fixture() {
  return {
    toolList: async (_id: string, _path: string, _signal: AbortSignal, side: string) => [
      { path: side === "base" ? "deleted.ts" : "file.ts", type: "blob", oid: "a".repeat(40) },
      { path: "link", type: "unsupported", oid: "b".repeat(40) },
    ],
    toolSource: async () =>
      Array.from({ length: 500 }, (_, i) => `line ${i} $malicious-skill`).join("\n"),
    toolImages: () => [],
  } as unknown as PRReview;
}
test("host IDs isolate reviews and deny arbitrary paths, unsupported entries and unknown tools", async () => {
  const first = new ReviewTools(fixture(), "one"),
    second = new ReviewTools(fixture(), "two");
  const list = payload(await first.call("scope_evidence", { action: "list", id: "root" }, signal));
  const id = list.entries[0].id;
  expect((await second.call("scope_evidence", { action: "read", id }, signal)).success).toBe(false);
  expect((await first.call("shell", { command: "cat /etc/passwd" }, signal)).success).toBe(false);
  expect(
    (await first.call("scope_evidence", { action: "read", id: "/etc/passwd" }, signal)).success,
  ).toBe(false);
  expect(
    (await first.call("scope_evidence", { action: "read", id: list.entries[1].id }, signal))
      .success,
  ).toBe(false);
});
test("pinned base and head use separate IDs and bounded literal search declares omitted lines", async () => {
  const tools = new ReviewTools(fixture(), "one");
  const head = payload(await tools.call("scope_evidence", { action: "list", id: "root" }, signal));
  const base = payload(
    await tools.call("scope_evidence", { action: "list", id: "root-base" }, signal),
  );
  expect(base.entries[0].path).toBe("deleted.ts");
  expect(base.entries[0].id).not.toBe(head.entries[0].id);
  const result = payload(
    await tools.call(
      "scope_evidence",
      { action: "search", id: head.entries[0].id, query: "$malicious-skill" },
      signal,
    ),
  );
  expect(result.lines).toHaveLength(200);
  expect(result.omission).toContain("omitted");
});
