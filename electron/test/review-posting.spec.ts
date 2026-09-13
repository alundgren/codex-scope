import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
test("comment preview exact copy post links failure uncertainty ambiguity stale and focus", async ({}, info) => {
  test.setTimeout(120000);
  const root = await mkdtemp("/tmp/scope-post-ui-");
  await mkdir(root + "/auth");
  await writeFile(root + "/auth/auth.json", "{}", { mode: 0o600 });
  const control = (value: unknown) =>
    writeFile(root + "/review-control.json", JSON.stringify(value));
  const app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      `--scope-test-root=${root}`,
      `--review-test-gh=${path.resolve("test/fixtures/review-gh.cjs")}`,
      `--review-test-cli=${path.resolve("test/fixtures/review-cli.cjs")}`,
      `--catalog-test-cli=${path.resolve("test/fixtures/catalog-cli.cjs")}`,
    ],
    env: { ...process.env, CODEX_HOME: root + "/auth" } as Record<string, string>,
    chromiumSandbox: true,
    recordVideo: { dir: info.outputPath("video"), size: { width: 1280, height: 800 } },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('html[data-ready="true"]');
    await app.evaluate(({ BrowserWindow, shell }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800);
      shell.openExternal = async (url) => {
        Reflect.set(globalThis, "openedComment", url);
      };
    });
    await page.evaluate(() =>
      window.scope.saveSettings({
        endpoint: "",
        token: "",
        diagnosis: { model: "test-success", effort: "low" },
        review: { model: "test-success", effort: "low" },
      }),
    );
    await page.locator("#functions summary").click();
    await page.locator('[data-tool="review"]').click();
    await page.locator("#review-address").fill("example/shop #148");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await page.locator("#review-chat-toggle").click();
    await page.locator("#conversation-input").fill("guide diagram");
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-state")).toContainText("ready");
    await page.locator("#review-feedback").click();
    const feedback = page.locator("#feedback-dialog");
    await feedback.getByRole("button", { name: "Generate feedback", exact: true }).click();
    await expect(page.locator("#feedback-agent")).toHaveValue(
      /Reader -> Service: Request evidence/,
    );
    await feedback.getByRole("button", { name: "Copy both", exact: true }).click();
    await expect(feedback).toContainText("Both handoffs copied");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
      "deleted.ts head lines 2-4",
    );
    await feedback.getByRole("button", { name: "Post comment…", exact: true }).click();
    const dialog = page.locator("#posting-dialog"),
      editor = page.locator("#posting-body");
    await expect(dialog.getByRole("button", { name: "Post comment", exact: true })).toBeEnabled();
    const original = await editor.inputValue();
    const body = "User-only combined edit.\n\n" + original;
    await editor.fill(body);
    await dialog.getByRole("button", { name: "Copy exact preview" }).click();
    await expect(dialog).toContainText("Exact preview copied.");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(body);
    await editor.focus();
    const guide = await app.evaluate(async () =>
      Reflect.get(globalThis, "scopeReviewSession").tools.call(
        "scope_guide",
        { action: "view", data: { lens: "Security", view: "Changes" } },
        new AbortController().signal,
      ),
    );
    expect(JSON.stringify(guide)).toContain("Retained");
    await expect(editor).toBeFocused();
    await expect(page.locator("#review-lens")).toContainText("Overview");
    await page.screenshot({ path: info.outputPath("01-exact-preview.png") });
    await dialog.getByRole("button", { name: "Post comment", exact: true }).dblclick();
    await expect(dialog.getByRole("link", { name: "View posted comment" })).toBeVisible();
    await dialog.getByRole("link", { name: "View posted comment" }).click();
    expect(await app.evaluate(() => Reflect.get(globalThis, "openedComment"))).toBe(
      "https://github.com/example/shop/pull/148#issuecomment-1000",
    );
    await dialog.getByText("Exact sent body", { exact: true }).click();
    await expect(dialog.locator("pre")).toHaveText(body);
    expect(JSON.parse(await readFile(root + "/posted-comments.json", "utf8"))).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("02-sent.png") });
    await editor.fill("Second edit\n" + body);
    await control({ postMode: "preflight-failed" });
    await dialog.getByRole("button", { name: "Post edited comment", exact: true }).click();
    await expect(dialog).toContainText("No comment was sent.");
    await expect(editor).toHaveValue("Second edit\n" + body);
    await page.screenshot({ path: info.outputPath("03-definitive-failure.png") });
    await control({ postMode: "uncertain" });
    await dialog.getByRole("button", { name: "Post comment", exact: true }).click();
    await expect(dialog).toContainText("Delivery is uncertain.");
    await dialog.getByRole("link", { name: "Inspect PR on GitHub" }).click();
    expect(await app.evaluate(() => Reflect.get(globalThis, "openedComment"))).toBe(
      "https://github.com/example/shop/pull/148",
    );
    await page.screenshot({ path: info.outputPath("04-uncertain.png") });
    await dialog.getByRole("button", { name: "Check GitHub for this comment" }).click();
    await expect(dialog).toContainText("Exact body, posting account and attempt time verified");
    expect(JSON.parse(await readFile(root + "/posted-comments.json", "utf8"))).toHaveLength(2);
    await editor.fill("Ambiguous edit\n" + body);
    await control({ postMode: "ambiguous" });
    await dialog.getByRole("button", { name: "Post edited comment", exact: true }).click();
    await expect(dialog).toContainText("Delivery is uncertain.");
    await dialog.getByRole("button", { name: "Check GitHub for this comment" }).click();
    await expect(dialog.getByRole("button", { name: "Use this comment" })).toHaveCount(2);
    await page.screenshot({ path: info.outputPath("05-ambiguous.png") });
    await dialog.getByRole("button", { name: "Use this comment" }).first().click();
    await expect(dialog).toContainText("You selected the matching GitHub comment.");
    await editor.fill("Stale edited draft\n" + body);
    await control({ stale: true });
    await dialog.getByRole("button", { name: "Post edited comment", exact: true }).click();
    await expect(dialog).toContainText("PR identity or revision changed.");
    await dialog.getByRole("button", { name: "Copy exact preview" }).click();
    await expect(dialog).toContainText("Exact preview copied.");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "Stale edited draft\n" + body,
    );
    await page.screenshot({ path: info.outputPath("06-stale-kept-copy.png") });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(600, 700),
    );
    await page.screenshot({ path: info.outputPath("07-narrow-preview.png") });
    await expect(dialog.getByRole("button", { name: "Back to refresh and review" })).toBeVisible();
    await dialog.getByRole("button", { name: "Back to refresh and review" }).click();
    await expect(feedback).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
