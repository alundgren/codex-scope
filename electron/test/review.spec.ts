import { test, expect, _electron, type Page } from "@playwright/test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
async function openMenu(page: Page, id: string, text: string) {
  await page.locator(id).click();
  await page.getByRole("menuitem", { name: text, exact: true }).click();
}
test("notebook walkthrough preserves pinned source and supplied evidence across navigation and pane controls", async ({}, info) => {
  const root = await mkdtemp("/tmp/scope-review-ui-");
  const app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      `--scope-test-root=${root}`,
      `--review-test-gh=${path.resolve("test/fixtures/review-gh.cjs")}`,
    ],
    chromiumSandbox: true,
    recordVideo: { dir: info.outputPath("video"), size: { width: 1280, height: 800 } },
  });
  const page = await app.firstWindow();
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) });
  try {
    await page.waitForSelector('html[data-ready="true"]');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
    await page.locator("#functions summary").click();
    await page.getByRole("button", { name: "PR review", exact: true }).click();
    await shot("01-open");
    await page.locator("#review-address").fill("invalid");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator("#review-status")).toContainText("Use a github.com");
    await shot("02-input-error");
    await page.locator("#review-address").fill("https://github.com/example/shop/pull/148");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await shot("03-full-review");
    await page.getByRole("button", { name: "head line 3", exact: true }).click();
    await page.locator("#review-content").evaluate((n) => (n.scrollTop = 650));
    const scroll = await page.locator("#review-content").evaluate((n) => n.scrollTop);
    await page.locator("#review-chat-toggle").click();
    await expect(page.locator("#review-chat")).toBeVisible();
    await shot("04-split");
    const divider = page.getByRole("separator", { name: "Resize review and conversation" });
    await divider.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(divider).toHaveAttribute("aria-valuenow", "58");
    await page.keyboard.press("Home");
    await expect(divider).toHaveAttribute("aria-valuenow", "20");
    await page.keyboard.press("End");
    await expect(divider).toHaveAttribute("aria-valuenow", "80");
    await divider.dblclick();
    await expect(divider).toHaveAttribute("aria-valuenow", "60");
    const rect = (await divider.boundingBox())!;
    await page.mouse.move(rect.x + 3, rect.y + 100);
    await page.mouse.down();
    await page.mouse.move(650, rect.y + 100);
    await page.mouse.up();
    await shot("05-drag-divider");
    await page.locator("#review-expand").click();
    await expect(page.locator("#review-chat")).toBeHidden();
    await page.locator("#review-expand").click();
    await page.locator("#review-chat-expand").click();
    await expect(page.locator("#review-pane")).toBeHidden();
    await page.locator("#review-chat-expand").click();
    await expect(page.locator("#review-content")).toHaveJSProperty("scrollTop", scroll);
    await page.locator("#review-lens").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(page.locator("#review-lens")).toHaveText("Architecture ⌄");
    await page.locator("#review-lens").click();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.locator("#review-lens")).toHaveText("Security ⌄");
    await page.locator("#review-lens").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#review-lens")).toBeFocused();
    await page.locator("#review-more").click();
    await shot("06-more-menu");
    const bounds = (await page.getByRole("menu").boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
    await page.locator("#review-title").click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.locator("#functions summary").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator("#functions summary").click();
    await page.getByRole("button", { name: "PR review", exact: true }).click();
    await expect(page.locator("#review-selection")).toContainText("head line 3");
    await expect(page.locator("#review-content")).toHaveJSProperty("scrollTop", scroll);
    await page.locator("#functions summary").click();
    await page.getByRole("button", { name: "Analyze session", exact: true }).click();
    await page.locator("#functions summary").click();
    await page.getByRole("button", { name: "PR review", exact: true }).click();
    await expect(page.locator("#review-selection")).toContainText("head line 3");
    await page.locator("#review-next").click();
    await expect(page.getByRole("button", { name: "head line 200", exact: true })).toBeVisible();
    await shot("07-next-source-page");
    await openMenu(page, "#review-view", "Visual evidence");
    await shot("08-empty-evidence");
    const supplied = path.join(root, "supplied.png");
    await page.screenshot({ path: supplied });
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, supplied);
    await page.getByRole("button", { name: "Add screenshot", exact: true }).click();
    await page.getByRole("button", { name: "supplied.png", exact: true }).click();
    await expect(page.locator("#review-content img")).toBeVisible();
    await shot("09-supplied-evidence");
    await page.getByRole("button", { name: "Remove screenshot", exact: true }).click();
    await expect(page.locator("#review-content img")).toHaveCount(0);
    const oversized = path.join(root, "oversized.png");
    await writeFile(oversized, Buffer.alloc(4 * 1024 * 1024 + 1));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, oversized);
    await page.getByRole("button", { name: "Add screenshot", exact: true }).click();
    await expect(page.locator("#review-status")).toContainText("4 MiB");
    await shot("10-oversize-error");
    await openMenu(page, "#review-view", "Changes");
    await openMenu(page, "#review-more", "Open another PR");
    await shot("11-leave-confirmation");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("#review-selection")).toContainText("head line 3");
    await writeFile(path.join(root, "review-control.json"), JSON.stringify({ stale: true }));
    await openMenu(page, "#review-more", "Refresh PR");
    await expect(page.locator("#review-dialog")).toContainText("The PR changed");
    await shot("12-stale");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("#review-revision")).toHaveText("Revision bbbbbbb");
    await openMenu(page, "#review-more", "Refresh PR");
    await page.getByRole("button", { name: "Replace review", exact: true }).click();
    await expect(page.locator("#review-revision")).toHaveText("Revision ddddddd");
    await expect(page.locator("#review-selection")).toHaveText("Select a source line");
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await expect(page.locator("#review-cancel")).toBeHidden();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(390, 760),
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(390);
    await shot("13-narrow-review");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await openMenu(page, "#review-more", "Show conversation");
    await expect(page.locator("#review-chat")).toBeVisible();
    await shot("14-narrow-chat");
    await page.locator("#review-chat-toggle").click();
    await page.locator("#review-more").click();
    await shot("15-narrow-menu");
    await page.keyboard.press("Escape");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1500, 900),
    );
    await page.locator("#review-chat-toggle").click();
    await shot("16-desktop");
    await openMenu(page, "#review-more", "Open another PR");
    await page.getByRole("button", { name: "Leave review", exact: true }).click();
    await page.locator("#review-address").fill("example/shop #149");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator("#review-title")).toContainText("#149");
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await expect(page.locator("#review-cancel")).toBeHidden();
    await shot("17-replacement");
  } finally {
    await app.close();
    await info.attach("walkthrough", {
      path: await page.video()!.path(),
      contentType: "video/webm",
    });
    await rm(root, { recursive: true, force: true });
  }
});
test("notebook GitHub errors, cancellation and unsupported source recover", async ({}, info) => {
  const root = await mkdtemp("/tmp/scope-review-ui-");
  const control = (mode: string) =>
    writeFile(path.join(root, "review-control.json"), JSON.stringify({ mode }));
  await control("auth");
  const app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      `--scope-test-root=${root}`,
      `--review-test-gh=${path.resolve("test/fixtures/review-gh.cjs")}`,
    ],
    chromiumSandbox: true,
    recordVideo: { dir: info.outputPath("video"), size: { width: 1280, height: 800 } },
  });
  const page = await app.firstWindow();
  try {
    await page.waitForSelector('html[data-ready="true"]');
    await page.locator("#functions summary").click();
    await page.getByRole("button", { name: "PR review", exact: true }).click();
    await page.locator("#review-address").fill("example/shop #148");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator("#review-status")).toContainText("authentication");
    await page.screenshot({ path: info.outputPath("auth-error.png") });
    await control("hang");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await page.locator("#review-cancel").click();
    await expect(page.locator("#review-status")).toContainText("cancelled");
    await page.screenshot({ path: info.outputPath("cancelled.png") });
    await control("");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await page.locator("#review-files").click();
    await page.getByRole("menuitem", { name: /asset.bin/ }).click();
    await expect(page.locator("#review-content")).toContainText("no patch");
    await openMenu(page, "#review-side", "Head source");
    await expect(page.locator("#review-status")).toContainText("Binary");
    await page.screenshot({ path: info.outputPath("binary.png") });
    for (const name of ["link.ts", "dependency"]) {
      await page.locator("#review-files").click();
      await page.getByRole("menuitem").filter({ hasText: name }).click();
      await openMenu(page, "#review-side", "Head source");
      await expect(page.locator("#review-status")).toContainText("Symlink and submodule");
      await page.screenshot({ path: info.outputPath(`${name}-unsupported.png`) });
    }
    await page.locator("#review-files").click();
    await page.getByRole("menuitem", { name: /src\/renamed.ts/ }).click();
    await expect(page.getByRole("button", { name: "base line 2", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "base line 2", exact: true }).click();
    await page.screenshot({ path: info.outputPath("rename-recovery.png") });
    const calls = (await readFile(path.join(root, "review-requests.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(calls.length).toBeLessThan(20);
  } finally {
    await app.close();
    await info.attach("walkthrough", {
      path: await page.video()!.path(),
      contentType: "video/webm",
    });
    await rm(root, { recursive: true, force: true });
  }
});
