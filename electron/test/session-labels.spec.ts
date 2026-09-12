import { test, expect } from "@playwright/test";
import { launch, append, frame, capture, selected } from "./navigation-helpers.ts";

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
  const payload = JSON.stringify({ ...JSON.parse(value.payload), cwd }, null, 2);
  return {
    ...value,
    payload,
    payload_bytes: Buffer.byteLength(payload),
    ...(branch !== undefined
      ? { git: { repo: "codex-scope", branch, observed_at: "2026-09-12T12:00:00Z" } }
      : {}),
  };
}

test("recorded session labels: directory fallback, Git rename, exact identity, unavailable metadata and narrow window", async ({}, info) => {
  const { app, page, video } = await launch(info);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dropdown = page.locator("#session");
  const choice = dropdown.locator("option").filter({ hasText: "00000001" });
  try {
    await append(app, [event()]);
    await dropdown.focus();
    await expect(choice).toHaveText("codex-scope / worktree-a1b2 · …00000001");
    await dropdown.selectOption(JSON.stringify(session));
    await expect(page.locator("#metadata")).toContainText(session);
    await capture(page, info, "directory-fallback");
    await append(app, [event("temporary")]);
    await dropdown.dispatchEvent("pointerdown");
    await expect(choice).toHaveText("codex-scope · temporary · …00000001");
    await page.locator("button[data-event]").last().click();
    const held = await selected(page);
    await page.locator("#payload").evaluate((node) => {
      node.scrollTop = 200;
    });
    const offset = await page.locator("#payload").evaluate((node) => node.scrollTop);
    await capture(page, info, "git-before-rename");
    await append(app, [
      event("identify-sessions"),
      event("identify-sessions", "11111111-2222-4333-8444-000000000002"),
    ]);
    await dropdown.dispatchEvent("pointerdown");
    await expect(choice).toHaveText("codex-scope · identify-sessions · …00000001");
    await expect(dropdown).toHaveValue(JSON.stringify(session));
    expect(await selected(page)).toBe(held);
    expect(await page.locator("#payload").evaluate((node) => node.scrollTop)).toBe(offset);
    await capture(page, info, "git-after-rename-held");
    const original = event().payload;
    await page.locator("#copy").click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(original);
    await dropdown.click();
    await page.waitForTimeout(1000);
    await capture(page, info, "session-menu");
    await page.keyboard.press("Escape");
    await append(app, [
      event(null),
      event(undefined, "missing-metadata", null),
      event("very-long-branch/".repeat(20), "long-branch"),
    ]);
    await dropdown.dispatchEvent("pointerdown");
    await expect(choice).toContainText("branch unavailable");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await capture(page, info, "narrow-unavailable");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dropdown.selectOption(JSON.stringify("long-branch"));
    await capture(page, info, "narrow-long-branch");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dropdown.selectOption(JSON.stringify("missing-metadata"));
    await capture(page, info, "missing-metadata");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("session-labels-walkthrough.webm"));
  }
});
