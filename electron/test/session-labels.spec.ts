import { test, expect } from "@playwright/test";
import { launch, append, frame, capture } from "./navigation-helpers.ts";
const session = "11111111-2222-4333-8444-000000000001";
function event(
  branch?: string | null,
  id = session,
  cwd: unknown = "/workspace/.t3/worktrees/codex-scope/worktree-a1b2",
) {
  const value = frame({
    session: id,
    message: "Synthetic session label check",
    tail: "text\n".repeat(500),
  });
  const payload = JSON.stringify({ ...JSON.parse(value.payload), cwd });
  return {
    ...value,
    payload,
    payload_bytes: Buffer.byteLength(payload),
    ...(branch !== undefined
      ? { git: { repo: "codex-scope", branch, observed_at: "2026-09-12T12:00:00Z" } }
      : {}),
  };
}
test("session picker keeps exact identities and refreshes labels without moving held calls", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await append(app, [event()]);
    await page.locator("#filter-open").click();
    const choice = page.locator(".filter-option").filter({ hasText: "00000001" });
    await expect(choice).toHaveText("codex-scope / worktree-a1b2 · …00000001");
    await choice.getByRole("checkbox").check();
    await page.locator("#filter-done").click();
    await expect(page.locator("#count")).toHaveText("1");
    await page.locator("#entries tr").first().click();
    await page.locator('[data-tab="json"]').click();
    await expect(page.locator("#metadata")).toContainText(session);
    await page.locator("#payload").evaluate((n) => (n.scrollTop = 200));
    const offset = await page.locator("#payload").evaluate((n) => n.scrollTop);
    const held = await page.locator("#payload").getAttribute("data-event");
    await append(app, [
      event("identify-sessions"),
      event("identify-sessions", "11111111-2222-4333-8444-000000000002"),
    ]);
    expect(await page.locator("#payload").evaluate((n) => n.scrollTop)).toBe(offset);
    await page.locator("#detail-close").click();
    await page.locator("#filter-open").click();
    await expect(choice).toHaveText("codex-scope · identify-sessions · …00000001");
    await expect(choice.getByRole("checkbox")).toBeChecked();
    await expect(page.locator("#filter-chips")).toContainText("identify-sessions");
    await expect(page.locator("#payload")).toHaveAttribute("data-event", held!);
    await capture(page, info, "renamed-session-held");
    await page.locator("#filter-done").click();
    await append(app, [
      event(null),
      event(undefined, "missing-metadata", null),
      event("very-long-branch/".repeat(20), "long-branch"),
    ]);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await page.locator("#filter-open").click();
    await expect(choice).toContainText("branch unavailable");
    await capture(page, info, "narrow-session-choices");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("session-labels.webm"));
  }
});
