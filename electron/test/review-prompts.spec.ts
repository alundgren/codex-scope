import { test, expect, _electron, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
async function tool(page: Page, name: string) {
  await page.locator("#functions summary").click();
  await page.getByRole("button", { name, exact: true }).click();
}
test("prompt editor keeps drafts, failures and active-turn versions through save cancel and independent revert", async ({}, info) => {
  const root = await mkdtemp("/tmp/scope-prompt-ui-");
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
  const choose = async (label: string) => {
    await page.locator("#prompt-select").click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  };
  try {
    await page.waitForSelector('html[data-ready="true"]');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
    await tool(page, "Settings");
    await page.locator("#model-refresh").click();
    await page.locator("#review-model").selectOption("test-success");
    await page.locator("#review-effort").selectOption("low");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-status")).toHaveText("Settings saved.");
    const connectionBefore = await readFile(root + "/preferences.json");
    await page.locator("#settings-prompts").click();
    await page.locator("#prompt-system summary").click();
    await shot("01-default-editor");
    await page.locator("#prompt-text").fill("BASE CUSTOM: Explain concrete examples.");
    await page.locator("#prompt-save").click();
    await expect(page.locator("#prompt-modified")).toHaveText("Modified");
    const baseVersion = (await page.evaluate(() => window.scope.settings())).prompts.base!.version;
    await choose("Feedback generation");
    await page.locator("#prompt-text").fill("Draft feedback wording");
    await page.locator("#prompt-cancel").click();
    await expect(page.locator("#prompt-text")).not.toHaveValue("Draft feedback wording");
    await choose("Security lens");
    const systemSecurity = await page.locator("#prompt-text").inputValue();
    await page.locator("#prompt-text").fill("SECURITY FIRST: Inspect authorization.");
    await page.locator("#prompt-save").click();
    await expect(page.locator("#prompt-modified")).toHaveText("Modified");
    await tool(page, "PR review");
    await page.locator("#review-address").fill("example/shop #148");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await page.locator("#review-chat-toggle").click();
    await page.locator("#review-lens").click();
    await page.getByRole("menuitem", { name: "Security", exact: true }).click();
    await page.locator("#conversation-input").fill("slow review");
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-entries")).toContainText("Working through");
    const before = await app.evaluate(() => Reflect.get(globalThis, "scopeReviewSession").read(0));
    const thread = await app.evaluate(() => Reflect.get(globalThis, "scopeReviewSession").thread);
    await shot("02-active-turn");
    await tool(page, "Settings");
    await page.locator("#prompt-text").fill("SECURITY NEXT: Explain failure and recovery.");
    await tool(page, "Analyze session");
    await tool(page, "Settings");
    await expect(page.locator("#prompt-text")).toHaveValue(
      "SECURITY NEXT: Explain failure and recovery.",
    );
    await shot("03-streaming-edit");
    await page.locator("#prompt-save").click();
    await expect(page.locator("#prompt-status")).toContainText("next turn");
    const during = await app.evaluate(() => Reflect.get(globalThis, "scopeReviewSession").read(0));
    expect(during.status).toBe("running");
    expect(during.prompts).toEqual(before.prompts);
    await shot("04-saved-next-turn");
    await tool(page, "PR review");
    await expect(page.locator("#conversation-state")).toContainText("pending for next turn");
    await shot("05-pending-in-chat");
    await page.locator("#conversation-stop").click();
    await expect(page.locator("#conversation-state")).toContainText("ready");
    await page.locator("#conversation-input").fill("echo-prompts next");
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-entries")).toContainText("SECURITY NEXT");
    await expect(page.locator("#conversation-entries")).toContainText("BASE CUSTOM");
    expect(await app.evaluate(() => Reflect.get(globalThis, "scopeReviewSession").thread)).toBe(
      thread,
    );
    const after = await app.evaluate(() => Reflect.get(globalThis, "scopeReviewSession").read(0));
    expect(after.entries[0].prompts).toEqual(before.entries[0].prompts);
    expect(after.prompts.lens).not.toBe(before.prompts.lens);
    await shot("06-next-turn-applied");
    await tool(page, "Settings");
    await page.locator("#prompt-revert").click();
    await expect(page.locator("#prompt-text")).toHaveValue(systemSecurity);
    await shot("07-revert-staged");
    await page.locator("#prompt-cancel").click();
    await expect(page.locator("#prompt-text")).toHaveValue(
      "SECURITY NEXT: Explain failure and recovery.",
    );
    await page.locator("#prompt-revert").click();
    await page.locator("#prompt-save").click();
    await expect(page.locator("#prompt-modified")).toHaveText("System default");
    expect((await page.evaluate(() => window.scope.settings())).prompts.base!.version).toBe(
      baseVersion,
    );
    await shot("08-independent-revert");
    await choose("UX lens");
    await page.locator("#prompt-text").fill("é".repeat(4097));
    await page.locator("#prompt-save").click();
    await expect(page.locator("#prompt-status")).toContainText("8 KiB");
    await shot("09-byte-error");
    await page.locator("#prompt-text").fill("RECOVERY DRAFT: Check the complete task.");
    await mkdir(root + "/.prompt-preferences.tmp");
    await page.locator("#prompt-save").click();
    await expect(page.locator("#prompt-status")).toContainText("not saved");
    await expect(page.locator("#prompt-text")).toHaveValue(
      "RECOVERY DRAFT: Check the complete task.",
    );
    expect((await page.evaluate(() => window.scope.settings())).prompts.UX).toBeUndefined();
    await shot("10-save-failure-draft");
    await rm(root + "/.prompt-preferences.tmp", { recursive: true });
    await page.locator("#prompt-save").click();
    await expect(page.locator("#prompt-modified")).toHaveText("Modified");
    await shot("11-save-recovered");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(600, 700),
    );
    await shot("12-narrow-editor");
    await page.locator("#prompt-select").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(page.locator("#prompt-select")).toContainText("Feedback generation");
    await page.locator("#prompt-text").fill("Persistent feedback override.");
    await app.evaluate(() =>
      globalThis.scopeHistory.call("test", { faults: { settingsDelay: 4500 } }),
    );
    await page.locator("#prompt-save").click();
    await expect(page.locator("#prompt-status")).toContainText("Still saving prompt");
    await expect(page.locator("#prompt-save")).toBeDisabled();
    await shot("13a-pending-save");
    await tool(page, "PR review");
    await tool(page, "Settings");
    await expect(page.locator("#prompt-text")).toHaveValue("Persistent feedback override.");
    await expect(page.locator("#prompt-modified")).toHaveText("Modified");
    await shot("13-feedback-editor");
    await app.evaluate(() =>
      globalThis.scopeHistory.call("test", { faults: { settingsDelay: 0 } }),
    );
    expect(await readFile(root + "/preferences.json")).toEqual(connectionBefore);
    const persisted = JSON.parse(await readFile(root + "/review-prompts.json", "utf8"));
    expect(Object.keys(persisted.overrides).sort()).toEqual(["UX", "base", "feedback"]);
    await app.close();
    expect(await readdir(root + "/review-session")).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
