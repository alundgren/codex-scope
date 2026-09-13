import { test, expect } from "vite-plus/test";
import { ReviewTools } from "../src/review-tools.ts";
import type { PRReview } from "../src/review.ts";
const payload = (r: any) => JSON.parse(r.contentItems[0].text);
const signal = new AbortController().signal;
async function fixture() {
  let images = [{ id: "image-one", head: "a".repeat(40), width: 300, height: 200 }];
  const review = {
    identity: () => ({ head: "a".repeat(40), diffBase: "b".repeat(40) }),
    toolImages: () => images,
    toolList: async () => [{ path: "source.ts", type: "blob", oid: "c".repeat(40) }],
    toolSource: async () => "one\ntwo\nthree\nfour",
  } as unknown as PRReview;
  const tools = new ReviewTools(review, "review-one", async () => "Retained. Follow paused.");
  const entry = payload(await tools.call("scope_evidence", { action: "list", id: "root" }, signal))
    .entries[0];
  const anchor = {
    id: entry.id,
    path: entry.path,
    revision: entry.revision,
    side: "head",
    line: 1,
    endLine: 2,
  };
  return {
    tools,
    anchor,
    removeImage: () => {
      images = [];
    },
  };
}
test("guidance acknowledges retention, rejects stale IDs and anchors, and bounds source display", async () => {
  const { tools, anchor } = await fixture();
  for (const change of [
    { id: "x".repeat(32) },
    { revision: "d".repeat(40) },
    { path: "else.ts" },
    { side: "base" },
    { line: 0 },
    { endLine: 5 },
    { endLine: 201 },
    { line: 1.5 },
    { html: "<script>" },
  ]) {
    const result = await tools.call(
      "scope_guide",
      { action: "source", data: { anchor: { ...anchor, ...change }, highlight: true } },
      signal,
    );
    expect(result.success).toBe(false);
  }
  const good = await tools.call(
    "scope_guide",
    { action: "source", data: { anchor, highlight: true } },
    signal,
  );
  expect(good.success).toBe(true);
  expect(payload(good).outcome).toContain("Retained");
  const id = payload(good).id;
  expect((await tools.guidance.content(id, signal)).rows).toHaveLength(4);
  tools.guidance.remove(id);
  expect((await tools.guidance.content(id, signal)).rows).toHaveLength(4);
  await expect(tools.guidance.content("unknown", signal)).rejects.toThrow("unavailable");
  const diagram = await tools.call(
    "scope_guide",
    {
      action: "diagram",
      data: {
        nodes: ["Reader", "Source"],
        messages: [{ from: 0, to: 0, text: "Read" }],
        sources: [anchor],
      },
    },
    signal,
  );
  const diagramId = payload(diagram).id;
  await tools.guidance.content(diagramId, signal, 0);
  tools.guidance.remove();
  expect((await tools.guidance.content(diagramId, signal, 0, 2)).offset).toBe(2);
  await expect(tools.guidance.content(id, signal)).rejects.toThrow("unavailable");
});
test("drawing validation rejects invalid coordinates, unknown markup and excessive points; removal invalidates existing marks", async () => {
  const { tools, removeImage } = await fixture();
  const data = {
    image: "image-one",
    revision: "a".repeat(40),
    marks: [
      {
        kind: "stroke",
        points: [
          [1, 2],
          [4, 5],
        ],
        text: "",
      },
    ],
  };
  for (const marks of [
    [{ kind: "svg", points: [[1, 1]], text: "<script>" }],
    [{ kind: "stroke", points: Array.from({ length: 129 }, () => [1, 1]), text: "" }],
    [
      {
        kind: "arrow",
        points: [
          [-1, 1],
          [5, 5],
        ],
        text: "",
      },
    ],
    [{ kind: "text", points: [[301, 1]], text: "outside" }],
  ])
    expect(
      (await tools.call("scope_guide", { action: "image", data: { ...data, marks } }, signal))
        .success,
    ).toBe(false);
  expect((await tools.call("scope_guide", { action: "image", data }, signal)).success).toBe(true);
  removeImage();
  expect(tools.guidance.read()[0].invalid).toBe(true);
  expect((await tools.call("scope_guide", { action: "image", data }, signal)).success).toBe(false);
});
test("diagrams require bounded local nodes, messages and valid source references; cancellation retains nothing", async () => {
  const { tools, anchor } = await fixture();
  const data = {
    nodes: ["A", "B"],
    messages: [{ from: 0, to: 1, text: "<script>literal text only</script>" }],
    sources: [anchor],
  };
  expect((await tools.call("scope_guide", { action: "diagram", data }, signal)).success).toBe(true);
  for (const change of [
    { nodes: Array(9).fill("node") },
    { messages: Array(25).fill(data.messages[0]) },
    { url: "https://example.com" },
    { sources: [] },
    { messages: [{ from: 0, to: 2, text: "bad" }] },
  ])
    expect(
      (await tools.call("scope_guide", { action: "diagram", data: { ...data, ...change } }, signal))
        .success,
    ).toBe(false);
  const controller = new AbortController();
  controller.abort();
  expect(
    (await tools.call("scope_guide", { action: "diagram", data }, controller.signal)).success,
  ).toBe(false);
  expect(tools.guidance.read()).toHaveLength(1);
});
test("active-review artifacts reject overflow before source work and clear explicitly", async () => {
  const { tools } = await fixture();
  const value = { action: "view", data: { lens: "Overview", view: "Changes" } };
  for (let i = 0; i < 24; i++)
    expect((await tools.call("scope_guide", value, signal)).success).toBe(true);
  expect((await tools.call("scope_guide", value, signal)).success).toBe(false);
  tools.guidance.remove();
  expect(tools.guidance.read()).toEqual([]);
  expect((await tools.call("scope_guide", value, signal)).success).toBe(true);
});

test("aggregate image geometry is rejected before dispatch and removal frees its allowance", async () => {
  const { tools } = await fixture();
  const data = {
    image: "image-one",
    revision: "a".repeat(40),
    marks: Array.from({ length: 8 }, () => ({
      kind: "stroke",
      points: Array.from({ length: 128 }, () => [1, 1]),
      text: "",
    })),
  };
  expect((await tools.call("scope_guide", { action: "image", data }, signal)).success).toBe(true);
  expect((await tools.call("scope_guide", { action: "image", data }, signal)).success).toBe(true);
  const excess = await tools.call("scope_guide", { action: "image", data }, signal);
  expect(excess.success).toBe(false);
  expect(payload(excess).error).toContain("2,048");
  tools.guidance.remove(tools.guidance.read()[0].id);
  expect((await tools.call("scope_guide", { action: "image", data }, signal)).success).toBe(true);
});
