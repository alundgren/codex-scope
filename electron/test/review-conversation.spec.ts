import { test, expect, _electron, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
async function tool(page: Page, name: string) {
  await page.locator("#functions summary").click();
  await page.getByRole("button", { name, exact: true }).click();
}
test("review conversation walkthrough streams, stops, survives navigation and preserves failure copy", async ({}, info) => {
  const root = await mkdtemp("/tmp/scope-conversation-ui-");
  await mkdir(root + "/auth");
  await writeFile(root + "/auth/auth.json", "{}", { mode: 0o600 });
  const app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      `--scope-test-root=${root}`,
      `--review-test-gh=${path.resolve("test/fixtures/review-gh.cjs")}`,
      `--review-test-cli=${path.resolve("test/fixtures/review-cli.cjs")}`,
      `--catalog-test-cli=${path.resolve("test/fixtures/catalog-cli.cjs")}`,
    ],
    env: { ...process.env, CODEX_HOME: root + "/auth" },
    chromiumSandbox: true,
    recordVideo: { dir: info.outputPath("video"), size: { width: 1280, height: 800 } },
  });
  const page = await app.firstWindow();
  const shot = (name: string) => page.screenshot({ path: info.outputPath(name + ".png") });
  try {
    await page.waitForSelector('html[data-ready="true"]');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
    await page.evaluate(() =>
      window.scope.saveSettings({
        endpoint: "",
        token: "",
        diagnosis: { model: "test-success", effort: "low" },
        review: { model: "test-success", effort: "low" },
      }),
    );
    await tool(page, "PR review");
    await page.locator("#review-address").fill("example/shop #148");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await page.locator("#review-chat-toggle").click();
    await shot("01-empty");
    await page.locator("#conversation-input").fill("Explain this change");
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-state")).toContainText("ready");
    await expect(page.locator("#conversation-entries")).toContainText("Pinned source reviewed");
    await shot("02-first-turn");
    await page.locator("#review-lens").click();
    await page.getByRole("menuitem", { name: "Security", exact: true }).click();
    await page.locator("#conversation-input").fill("slow security review");
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-entries")).toContainText("Working through");
    await shot("03-streaming");
    await tool(page, "Settings");
    await shot("04-settings");
    await tool(page, "Analyze session");
    await shot("05-analysis");
    await tool(page, "PR review");
    await expect(page.locator("#conversation-state")).toContainText("running");
    await page.locator("#conversation-stop").click();
    await expect(page.locator("#conversation-state")).toContainText("ready");
    await shot("06-stopped");
    await page.locator("#conversation-input").fill("exit-fixture");
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-state")).toContainText("Codex exited");
    await shot("07-failure-before-copy");
    await page.locator("#conversation-copy").click();
    await expect(page.locator("#conversation-state")).toContainText("Codex exited");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain("exit-fixture");
    await shot("07-failure-copy");
    await page.locator("#review-more").click();
    await page.getByRole("menuitem", { name: "End review", exact: true }).click();
    await shot("08-end-confirm");
    await page
      .locator("#review-dialog")
      .getByRole("button", { name: "End review", exact: true })
      .click();
    await expect(page.locator("#review-open")).toBeVisible();
    await page.locator("#review-address").fill("example/shop #148");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await page.locator("#review-chat-toggle").click();
    await page.locator("#conversation-input").fill("Recovered review");
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-state")).toContainText("ready");
    await expect(page.locator("#conversation-entries")).not.toContainText("exit-fixture");
    await shot("09-recovered");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(600, 700),
    );
    await page.locator("#review-chat-toggle").click();
    await shot("10-narrow");
    await app.close();
    expect(await readdir(root + "/review-session")).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
