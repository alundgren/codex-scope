import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
test("feedback mid-review editing copy cancellation failed manual and export before switch", async ({}, info) => {
  test.setTimeout(120000);
  const root = await mkdtemp("/tmp/scope-feedback-ui-");
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
    env: { ...process.env, CODEX_HOME: root + "/auth" } as Record<string, string>,
    chromiumSandbox: true,
    recordVideo: { dir: info.outputPath("video"), size: { width: 1280, height: 800 } },
  });
  try {
    const page = await app.firstWindow();
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
    await page.locator("#functions summary").click();
    await page.locator('[data-tool="review"]').click();
    await page.locator("#review-address").fill("example/shop #148");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await page.locator("#review-chat-toggle").click();
    await page.locator("#conversation-input").fill("guide diagram");
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-state")).toContainText("ready");
    await page.locator("#conversation-input").fill("slow");
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-state")).toContainText("running");
    await page.locator("#review-feedback").click();
    const popup = page.locator("#feedback-dialog");
    await popup.getByRole("button", { name: "Generate feedback", exact: true }).click();
    await expect(popup.getByRole("button", { name: "Wait for current turn" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("01-active-turn.png") });
    await popup.getByRole("button", { name: "Stop turn first" }).click();
    await expect(page.locator("#feedback-author")).toHaveValue(
      "- security-high: Verify access before returning the invoice.",
    );
    await expect(page.locator("#feedback-agent")).toHaveValue(
      /Reader -> Service: Request evidence/,
    );
    await expect(page.locator("#feedback-agent")).toHaveValue(
      /deleted.ts head lines 2-4, revision/,
    );
    await page.locator("#feedback-agent").focus();
    const guide = await app.evaluate(async () =>
      Reflect.get(globalThis, "scopeReviewSession").tools.call(
        "scope_guide",
        { action: "view", data: { lens: "Security", view: "Changes" } },
        new AbortController().signal,
      ),
    );
    expect(JSON.stringify(guide)).toContain("Retained");
    await expect(page.locator("#review-lens")).toContainText("Overview");
    await page
      .locator("#feedback-author")
      .fill("- security-high: Check ownership before returning an invoice.");
    await page
      .locator("#feedback-agent")
      .fill("Independently check invoice.ts head line 12. Route middleware remains unknown.");
    await popup.getByRole("button", { name: "Copy both", exact: true }).click();
    await expect(popup).toContainText("Both handoffs copied with revision.");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
      "Feedback revision",
    );
    await expect(page.locator(".review-pr-number")).toHaveText("#148");
    const numberBox = await page.locator(".review-pr-number").boundingBox();
    expect(numberBox!.x + numberBox!.width).toBeLessThan(1280);
    await page.screenshot({ path: info.outputPath("02-edited-copy.png") });
    await popup.getByRole("button", { name: "Generate feedback", exact: true }).click();
    await popup.getByRole("button", { name: "Keep edits" }).click();
    await expect(page.locator("#feedback-author")).toHaveValue(
      "- security-high: Check ownership before returning an invoice.",
    );
    await popup.getByRole("button", { name: "Generate feedback", exact: true }).click();
    await popup.getByRole("button", { name: "Replace edited text" }).click();
    await expect(page.locator("#feedback-author")).toBeDisabled();
    await expect(popup.getByLabel("One-sentence description", { exact: true })).toBeDisabled();
    await expect(
      popup.getByRole("button", { name: "Apply selected findings to handoffs" }),
    ).toBeDisabled();
    await popup.getByRole("button", { name: "Cancel generation" }).click();
    await expect(page.locator("#feedback-agent")).toHaveValue(
      "Independently check invoice.ts head line 12. Route middleware remains unknown.",
    );
    await page.screenshot({ path: info.outputPath("03-cancelled.png") });
    await popup.locator("summary").click();
    await popup
      .getByLabel("One-sentence description", { exact: true })
      .fill("A corrected finding remains pending.");
    await popup.getByRole("button", { name: "Generate feedback", exact: true }).click();
    await expect(popup.getByRole("button", { name: "Replace edited text" })).toBeVisible();
    await popup.getByRole("button", { name: "Keep edits" }).click();
    await expect(popup.getByLabel("One-sentence description", { exact: true })).toHaveValue(
      "A corrected finding remains pending.",
    );
    await popup.locator("summary").click();

    await app.evaluate(({ clipboard }) => {
      const original = clipboard.writeText.bind(clipboard);
      clipboard.writeText = () => {
        clipboard.writeText = original;
        throw Error("Synthetic clipboard failure.");
      };
    });
    await popup.getByRole("button", { name: "Copy both", exact: true }).click();
    await expect(popup).toContainText("Synthetic clipboard failure");
    await popup.getByRole("button", { name: "Copy both", exact: true }).click();
    await expect(popup).toContainText("Both handoffs copied");
    const clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText());
    await page.locator("#feedback-author").fill("before\0after");
    await expect(popup).toContainText("Draft edited. Copy again");
    await popup.getByRole("button", { name: "Copy author", exact: true }).click();
    await expect(popup).toContainText("unsupported control characters");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(clipboardBefore);
    await page
      .locator("#feedback-author")
      .fill("- security-high: Check ownership before returning an invoice.");
    await app.evaluate(({ clipboard }) => {
      const original = clipboard.writeText.bind(clipboard);
      clipboard.writeText = async (text) => {
        Reflect.set(globalThis, "feedbackCopyStarted", true);
        await new Promise((resolve) => setTimeout(resolve, 500));
        clipboard.writeText = original;
        return original(text);
      };
    });
    await popup.getByRole("button", { name: "Copy agent", exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, "feedbackCopyStarted")))
      .toBe(true);
    await page.locator("#feedback-agent").fill("New draft during copy.");
    await expect(popup).toContainText("Earlier editor snapshot copied");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).not.toContain(
      "New draft during copy",
    );
    await page
      .locator("#feedback-agent")
      .fill("Independently check invoice.ts head line 12. Route middleware remains unknown.");
    await popup.getByRole("button", { name: "Close feedback" }).click();
    await page.locator("#functions summary").click();
    await page.locator('[data-tool="settings"]').click();
    await page.locator("#functions summary").click();
    await page.locator('[data-tool="review"]').click();
    await page.locator("#review-feedback").click();
    await expect(page.locator("#feedback-agent")).toHaveValue(
      "Independently check invoice.ts head line 12. Route middleware remains unknown.",
    );
    await popup.getByRole("button", { name: "Close feedback" }).click();
    await writeFile(path.join(root, "review-control.json"), JSON.stringify({ stale: true }));
    await page.locator("#review-more").click();
    await page.getByRole("menuitem", { name: "Refresh PR", exact: true }).click();
    await expect(popup).toContainText("Stale feedback");
    await popup.getByRole("button", { name: "Copy both", exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain("b".repeat(40));
    await page.screenshot({ path: info.outputPath("06-stale.png") });
    await popup.getByRole("button", { name: "Cancel ending" }).click();
    await expect(page.locator("#conversation-send")).toBeEnabled();
    await page.locator("#conversation-input").fill("exit-fixture");
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-state")).toContainText("failed");
    await page.locator("#review-feedback").click();
    await expect(popup).toContainText("No live agent");
    await page.locator("#feedback-agent").fill("Manual retained evidence handoff.");
    await popup.getByRole("button", { name: "Copy agent", exact: true }).click();
    await expect(popup).toContainText("Agent handoff copied");
    await page.screenshot({ path: info.outputPath("04-failed-manual.png") });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(600, 700),
    );
    await page.locator("#feedback-agent").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("07-narrow-agent.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(600);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );

    await popup.getByRole("button", { name: "Close feedback" }).click();
    await page.locator("#review-more").click();
    await page.getByRole("menuitem", { name: "Open another PR", exact: true }).click();
    await expect(popup.getByRole("button", { name: "Cancel ending" })).toBeVisible();
    await popup.getByRole("button", { name: "Cancel ending" }).click();
    await expect(page.locator("#review-title")).toContainText("example/shop");
    await page.locator("#review-more").click();
    await page.getByRole("menuitem", { name: "Open another PR", exact: true }).click();
    await popup.getByRole("button", { name: "Copy both", exact: true }).click();
    await page.screenshot({ path: info.outputPath("05-export-before-switch.png") });
    await popup.getByRole("button", { name: "End without copy" }).click();
    await expect(page.locator("#review-address")).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
