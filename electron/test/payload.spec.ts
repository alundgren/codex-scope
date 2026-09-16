import { test, expect, type Page } from "@playwright/test";
import { append, capture, frame, launch } from "./navigation-helpers.ts";

async function fillsWindow(page: Page) {
  const bounds = await page.locator("#call-detail").boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(bounds).toEqual({ x: 0, y: 0, ...viewport });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
}

test("full-window payload walkthrough formats every JSON tab and keeps copy and held reading intact", async ({}, info) => {
  const { app, page, video } = await launch(info);
  const input = {
    command:
      "*** Begin Patch\n*** Add File: docs/workflow.md\n+# Workflow\n+Read the selected request.\n*** End Patch",
    options: { preview: true, retries: 2, timeout: null },
    files: ["docs/workflow.md", "docs/examples.md"],
  };
  const response = {
    success: true,
    changed: ["docs/workflow.md", "docs/examples.md"],
    bytes_written: 611,
    warning: null,
    message: "Updated both files.\nReady for review.",
    literal: '<script>alert("text only")</script>',
  };
  const event = {
    hook_event_name: "PostToolUse",
    session_id: "synthetic-payload-session",
    tool_name: "apply_patch",
    model: "synthetic-model",
    tool_input: input,
    tool_response: response,
    captured_notes: "Synthetic captured note.\n".repeat(240),
  };
  const extra = ',"precise":9007199254740993,"repeated":1,"repeated":2';
  const raw = " \n" + JSON.stringify(event).slice(0, -1) + extra + "}\n ";
  const formatted =
    JSON.stringify(event, null, 2).slice(0, -2) +
    ',\n  "precise": 9007199254740993,\n  "repeated": 1,\n  "repeated": 2\n}';
  const makeFrame = (payload: string) => ({
    ...frame({ session: event.session_id }),
    tool_name: "apply_patch",
    payload,
    payload_bytes: Buffer.byteLength(payload),
  });
  const copy = async (expected: string) => {
    await page.locator("#copy").click();
    await expect(page.locator("#copy")).toHaveText("Copied");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(expected);
  };
  try {
    await append(app, [makeFrame(raw)]);
    await page.locator('#entries tr[data-event="6"]').click();
    await fillsWindow(page);
    expect(await page.locator("#json").textContent()).toBe(JSON.stringify(response, null, 2));
    const colors = [];
    for (const kind of ["key", "string", "number", "boolean", "null"]) {
      const token = page.locator(`#json .json-${kind}`).first();
      await expect(token).toBeVisible();
      colors.push(await token.evaluate((node) => getComputedStyle(node).color));
    }
    expect(new Set(colors).size).toBe(5);
    await expect(page.locator("#json script")).toHaveCount(0);
    await copy(JSON.stringify(response));
    await capture(page, info, "response-json");

    await page.locator('[data-tab="input"]').click();
    expect(await page.locator("#json").textContent()).toBe(JSON.stringify(input, null, 2));
    await copy(JSON.stringify(input));
    await capture(page, info, "input-json");
    await page.locator('[data-tab="json"]').click();
    expect(await page.locator("#json").textContent()).toBe(formatted);
    await copy(raw);
    await capture(page, info, "original-json");
    await page.locator("#payload").evaluate((node) => (node.scrollTop = 240));
    const offset = await page.locator("#payload").evaluate((node) => node.scrollTop);
    expect(offset).toBeGreaterThan(0);
    await append(app, [makeFrame(JSON.stringify({ ...event, captured_notes: "new arrival" }))]);
    expect(await page.locator("#payload").evaluate((node) => node.scrollTop)).toBe(offset);
    expect(await page.locator("#json").textContent()).toBe(formatted);
    await capture(page, info, "held-during-capture");

    for (const [width, height] of [
      [440, 820],
      [360, 640],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]),
        [width, height],
      );
      await page.locator('[data-tab="input"]').click();
      await fillsWindow(page);
      await expect(page.locator("#detail-close")).toBeInViewport();
      await expect(page.locator("#copy")).toBeInViewport();
      await capture(page, info, `input-${width}`);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("#call-detail")).toBeHidden();
    await expect(page.locator('#entries tr[data-event="6"]')).toBeFocused();
    await expect(page.locator("#live")).toHaveText("Resume live");
    await expect(page.locator("#json")).toBeEmpty();
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("payload-walkthrough.webm"));
  }
});

test("payload walkthrough keeps text and missing responses readable and recovers from formatting limits", async ({}, info) => {
  const { app, page, video } = await launch(info);
  let nextId = 6;
  const show = async (response?: unknown) => {
    if (await page.locator("#call-detail").isVisible()) await page.keyboard.press("Escape");
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "synthetic-payload-session",
      tool_name: "read_file",
      tool_input: { path: "docs/workflow.md" },
      tool_response: response,
    });
    await append(app, [
      {
        ...frame({ session: "synthetic-payload-session" }),
        tool_name: "read_file",
        payload,
        payload_bytes: Buffer.byteLength(payload),
      },
    ]);
    await page.locator("#live").click();
    await page.locator(`#entries tr[data-event="${nextId++}"]`).click();
    return payload;
  };
  try {
    const text = 'Read complete.\n<script>This is captured text.</script>\n{"incomplete":';
    await show(text);
    expect(await page.locator("#json").textContent()).toBe(text);
    await expect(page.locator("#json span, #json script")).toHaveCount(0);
    await capture(page, info, "plain-response");
    await show();
    await expect(page.locator("#json")).toHaveText("Response unavailable.");
    await capture(page, info, "missing-response");
    await page.locator('[data-tab="json"]').click();
    await expect(page.locator("#json .json-key").first()).toBeVisible();
    await capture(page, info, "missing-response-original");

    const response = Array.from({ length: 10000 }, (_, i) => i % 10);
    const raw = await show(response);
    await expect(page.locator("#copy-status")).toContainText("Formatting limit reached");
    expect(await page.locator("#json").textContent()).toBe(JSON.stringify(response));
    await expect(page.locator("#json span")).toHaveCount(0);
    await page.getByRole("scrollbar", { name: "Scroll payload" }).press("End");
    await capture(page, info, "formatting-limit-complete-text");
    await page.locator('[data-tab="json"]').click();
    await page.locator("#copy").click();
    await expect(page.locator("#copy")).toHaveText("Copied");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(raw);
    await page.locator('[data-tab="input"]').click();
    await expect(page.locator("#copy-status")).not.toContainText("Formatting limit");
    await expect(page.locator("#json .json-key")).toHaveText('"path"');
    await capture(page, info, "formatting-recovered");
    await show('{"ok":true,"items":[1,2]}');
    expect(await page.locator("#json").textContent()).toBe(
      '{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}',
    );
    await capture(page, info, "json-string-response");
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("payload-recovery-walkthrough.webm"));
  }
});
