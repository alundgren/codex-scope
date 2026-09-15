import { test, expect } from "@playwright/test";
import { launch, append, capture } from "./navigation-helpers.ts";

// Same authored synthetic calls as the selected A reference, for comparable screenshots.
function referenceCall(i: number) {
  const tools = ["Bash", "Read", "Write", "Agent", "WebSearch"],
    sessions = ["orbit/main", "orbit/fix-search", "meadow/main"],
    models = ["gpt-5.6-sol", "gpt-6-astra"];
  const tool = i === 71 || i % 13 === 0 ? "Bash" : tools[i % 5];
  let command = [
    'rg -n "response_bytes|context" src/collector test/fixtures',
    "src/components/ResultTable.tsx",
    "src/components/FilterPicker.tsx",
    "Inspect cancellation and retained-call query behavior",
    "Electron IPC bounded payload rendering",
  ][i % 5];
  if (i % 13 === 0) command = 'cd /workspace/orbit && rg -n "response" src/collector';
  if (i === 71) command = 'rg -n "response|payload|tool_result" src test --glob "*.ts"';
  let response: unknown =
    i % 11 === 4 || i === 70
      ? undefined
      : i % 5 === 2
        ? {
            ok: true,
            path: command,
            bytes_written: 486,
            summary: "Updated the filter selection and preserved keyboard focus.",
          }
        : `src/collector/receive.ts:${(i % 40) + 1}: response accepted; bounded synthetic example\n`.repeat(
            i === 71 ? 550 : i % 9 === 0 ? 190 : ((i * 7) % 37) + 2,
          );
  if (i === 68)
    response =
      '<script>alert("Synthetic text only")</script>\n<button>This is response text, never a control.</button>\n' +
      response;
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: sessions[i % 3],
    model: i === 70 || i % 7 === 0 ? undefined : models[i % 2],
    tool_name: tool,
    tool_input: { command },
    tool_response: response,
  });
  return {
    type: "event",
    hook_type: "PostToolUse",
    session_id: sessions[i % 3],
    tool_name: tool,
    payload,
    payload_bytes: Buffer.byteLength(payload),
    received_at: new Date(Date.UTC(2026, 8, 15, 10, 24) + i * 7000).toISOString(),
  };
}

test("selected A reference comparison and live inspection walkthrough", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1400, 900),
    );
    await app.evaluate(() => globalThis.scopeHistory.clear(globalThis.scopeHistory.generation));
    await expect(page.locator("#count")).toHaveText("0");
    await append(
      app,
      Array.from({ length: 72 }, (_, i) => referenceCall(i)),
    );
    await expect(page.locator("#count")).toHaveText("72");
    await expect(page.locator("#response-unknown")).toHaveText("+ 7 unknown responses");
    await expect(page.locator("#response-denominator")).toHaveText("Across 65 measured calls");
    await capture(page, info, "implementation-table");
    await page.locator("#filter-open").click();
    await expect(page.getByRole("checkbox", { name: "orbit/main", exact: true })).toBeVisible();
    await capture(page, info, "implementation-picker");
    await page.locator("#filter-done").click();
    await page.locator("#entries tr").first().click();
    await expect(page.locator("#json")).toContainText("response accepted");
    await capture(page, info, "implementation-overlay");
    await page.locator("#payload").evaluate((n) => (n.scrollTop = 240));
    const offset = await page.locator("#payload").evaluate((n) => n.scrollTop);
    await append(app, [referenceCall(73)]);
    expect(await page.locator("#payload").evaluate((n) => n.scrollTop)).toBe(offset);
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "1");
    await page.locator('[data-tab="input"]').click();
    await capture(page, info, "implementation-input");
    await page.locator('[data-tab="json"]').click();
    await capture(page, info, "implementation-original");
    await page.keyboard.press("Escape");
    await page.locator("#live").click();
    await page.locator("#sort").selectOption("largest");
    await capture(page, info, "implementation-largest");
    await page.locator("#search").fill("Synthetic text only");
    await expect(page.locator("#entries tr")).toHaveCount(1);
    await page.locator("#entries tr").first().click();
    await expect(page.locator("#json script,#json button")).toHaveCount(0);
    await capture(page, info, "implementation-untrusted-text");
    await page.keyboard.press("Escape");
    await page.locator("#filter-reset").click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await capture(page, info, "implementation-narrow");
    await page.locator("#filter-open").click();
    await page.locator('[data-field="size"]').click();
    await capture(page, info, "implementation-narrow-size");
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("implementation-walkthrough.webm"));
  }
});
