import { test, expect } from "@playwright/test";
import { launch, append, fault, state, capture } from "./navigation-helpers.ts";
function call(index: number, overrides: Record<string, unknown> = {}) {
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: `session-${index % 3}`,
    tool_name: index % 2 ? "Read" : "Bash",
    model: index % 3 ? "gpt-5.6-sol" : "gpt-6-astra",
    tool_input: { command: index % 4 ? `rg files-${index}` : `cd project && rg files-${index}` },
    tool_response: "output\n".repeat(index * 20),
    ...overrides,
  });
  const value = JSON.parse(payload);
  return {
    type: "event",
    hook_type: value.hook_event_name,
    session_id: value.session_id,
    tool_name: value.tool_name,
    received_at: new Date(Date.UTC(2026, 8, 15, 10, 24, index)).toISOString(),
    payload,
    payload_bytes: Buffer.byteLength(payload),
  };
}

test("A journal combines filters, sorts responses, and holds rows while totals stay live", async ({}, info) => {
  const { app, page, video } = await launch(info);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await append(
      app,
      Array.from({ length: 30 }, (_, i) => call(i + 1)),
    );
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "31");
    await expect(page.locator("#entries tr")).toHaveCount(12);
    await expect(page.locator("#scrubber,#hooks,#session")).toHaveCount(0);
    await page.locator("#sort").selectOption("largest");
    await expect(page.locator("#entries")).toHaveAttribute("aria-busy", "false");
    await capture(page, info, "largest-table");
    await page.locator("#filter-open").click();
    await page.locator('[data-field="tool"]').click();
    await page.getByRole("checkbox", { name: "Bash", exact: true }).check();
    await page.locator('[data-field="model"]').click();
    await page.getByRole("checkbox", { name: "gpt-5.6-sol", exact: true }).check();
    await page.locator('[data-field="prefix"]').click();
    await page.locator("#command-prefix").fill("rg");
    await page.getByRole("button", { name: "Apply prefix" }).click();
    await page.locator('[data-field="size"]').click();
    await page.locator("#response-size").fill("1");
    await page.getByLabel("Response size unit").selectOption("KB");
    await page.getByRole("button", { name: "Apply size" }).click();
    await capture(page, info, "combined-picker");
    await page.locator("#filter-done").click();
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "4");
    const rows = await page.locator("#entries").textContent();
    await page.locator("#entries tr").first().click();
    await expect(page.locator("#call-detail")).toBeVisible();
    await expect(page.locator("#json")).toContainText("output");
    await page.locator("#payload").evaluate((n) => (n.scrollTop = 200));
    const offset = await page.locator("#payload").evaluate((n) => n.scrollTop);
    await append(app, [call(38), call(39), call(42)]);
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "5");
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "1");
    expect(await page.locator("#entries").textContent()).toBe(rows);
    expect(await page.locator("#payload").evaluate((n) => n.scrollTop)).toBe(offset);
    await capture(page, info, "held-overlay-live-totals");
    await page.keyboard.press("Escape");
    await expect(page.locator("#live")).toHaveText("Resume live");
    await page.locator("#live").click();
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "0");
    await page.locator("#filter-reset").click();
    await append(app, [
      call(50, { tool_response: undefined }),
      call(51, { tool_response: "" }),
      call(52, { tool_response: { ok: true } }),
    ]);
    await expect(page.locator("#response-unknown")).toContainText("1 unknown");
    await expect(page.locator("#response-total")).not.toHaveText("Unknown");
    await page.locator("#next-page").click();
    await expect(page.locator("#page-position")).toContainText("13–24");
    await page.locator("#previous-page").click();
    await expect(page.locator("#page-position")).toContainText("1–12");
    await page.locator("#search").fill("no matching response marker");
    await expect(page.locator("#empty-results")).toContainText("No calls match");
    await capture(page, info, "no-matches");
    await page.locator("#filter-reset").click();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("journal-walkthrough.webm"));
  }
});

test("catalog search, unknown-only size, delayed filters, timeout, pressure and Clear recover", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await append(
      app,
      Array.from({ length: 80 }, (_, i) =>
        call(i, {
          tool_name: `Tool ${String(i).padStart(3, "0")}`,
          tool_response: i === 79 ? undefined : "known",
        }),
      ),
    );
    await page.locator("#filter-open").click();
    await page.locator('[data-field="tool"]').click();
    await expect(page.locator("#filter-options input")).toHaveCount(32);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator("#filter-options")).toContainText("Tool 062");
    await page.getByLabel("Search tool choices").fill("Tool 079");
    await expect(page.locator("#filter-options input")).toHaveCount(1);
    await page.getByRole("checkbox", { name: "Tool 079" }).check();
    await page.locator('[data-field="size"]').click();
    await page.getByRole("checkbox", { name: "Size unknown" }).check();
    await page.locator("#filter-done").click();
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "1");
    await expect(page.locator("#response-total")).toHaveText("0 B");
    await expect(page.locator("#response-denominator")).toHaveText("Across 0 measured calls");
    await capture(page, info, "unknown-only");
    await page.locator("#filter-reset").click();
    await fault(app, { delay: 600 });
    await page.locator("#search").fill("not-final");
    await page.waitForTimeout(230);
    await page.locator("#search").fill("files-79");
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "1");
    await expect(page.locator("#entries")).toContainText("files-79");
    await fault(app, { delay: 0, searchMs: 0 });
    await page.locator("#search").fill("missing");
    await expect(page.locator("#notice")).toContainText("Search timed out");
    await capture(page, info, "timeout");
    await fault(app, { searchMs: 250 });
    await page.locator("#filter-reset").click();
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "81");
    await fault(app, { disk: true });
    await append(app, [call(100)]);
    await expect(page.locator("#notice")).toContainText("Storage pressure");
    await capture(page, info, "pressure");
    await fault(app, { disk: false });
    await append(app, [call(101)]);
    await expect(page.locator("#notice")).not.toContainText("Storage pressure");
    await fault(app, { delay: 600 });
    await page.locator("#search").fill("pending");
    await page.waitForTimeout(230);
    await page.locator("#clear").click();
    await page.locator("#clear").click();
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "0");
    await expect(page.locator("#entries tr")).toHaveCount(0);
    await capture(page, info, "clear-generation");
    expect((await state(app)).peakPending).toBeLessThanOrEqual(4);
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("journal-recovery.webm"));
  }
});

test("inspection cancels a delayed live reply and empty held results only update totals", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await append(
      app,
      Array.from({ length: 20 }, (_, i) => call(i + 1)),
    );
    await expect(page.locator("#count")).toHaveText("21");
    await expect(page.locator("#entries")).toHaveAttribute("aria-busy", "false");
    const table = page.locator(".tablewrap");
    await table.evaluate((node) => (node.scrollTop = 90));
    const rows = await page
      .locator("#entries tr")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.event));
    const id = rows[2]!;
    await app.evaluate(() => {
      const history = globalThis.scopeHistory;
      const original = history.navigate.bind(history);
      history.navigate = async (...args) => {
        const result = await original(...args);
        await new Promise((resolve) => setTimeout(resolve, 700));
        return result;
      };
    });
    await append(app, [call(25)]);
    await expect(page.locator("#entries")).toHaveAttribute("aria-busy", "true");
    await page.locator(`tr[data-event="${id}"]`).click();
    const offset = await table.evaluate((node) => node.scrollTop);
    await expect(page.locator("#call-detail")).toBeVisible();
    expect(
      await page
        .locator("#entries tr")
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.event)),
    ).toEqual(rows);
    expect(await table.evaluate((node) => node.scrollTop)).toBe(offset);
    await page.keyboard.press("Escape");
    await expect(page.locator(`tr[data-event="${id}"]`)).toBeFocused();
    await capture(page, info, "delayed-reply-held");
    await page.locator("#search").fill("futureunique");
    await expect(page.locator("#count")).toHaveText("0");
    await expect(page.locator("#entries tr")).toHaveCount(0);
    await append(app, [call(26, { tool_response: "futureunique" })]);
    await expect(page.locator("#count")).toHaveText("1");
    await expect(page.locator("#response-total")).toHaveText("12 B");
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "1");
    await page.waitForTimeout(900);
    await expect(page.locator("#entries tr")).toHaveCount(0);
    await capture(page, info, "empty-held-live-totals");
    await page.locator("#live").click();
    await expect(page.locator("#entries tr")).toHaveCount(1);
    await capture(page, info, "explicit-resume");
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("held-races-walkthrough.webm"));
  }
});
