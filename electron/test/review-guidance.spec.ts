import { test, expect, _electron, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
const live = process.env.SCOPE_GUIDANCE_LIVE === "1";
async function tool(page: Page, name: string) {
  await page.locator("#functions summary").click();
  await page.getByRole("button", { name, exact: true }).click();
}
test("guided evidence walkthrough preserves pause, focus and drafts; renders and removes bounded marks", async ({}, info) => {
  test.setTimeout(live ? 480000 : 120000);
  const root = await mkdtemp("/tmp/scope-guidance-ui-");
  if (!live) {
    await mkdir(root + "/auth");
    await writeFile(root + "/auth/auth.json", "{}", { mode: 0o600 });
  }
  const app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      `--scope-test-root=${root}`,
      `--review-test-gh=${path.resolve("test/fixtures/review-gh.cjs")}`,
      ...(live
        ? []
        : [
            `--review-test-cli=${path.resolve("test/fixtures/review-cli.cjs")}`,
            `--catalog-test-cli=${path.resolve("test/fixtures/catalog-cli.cjs")}`,
          ]),
    ],
    env: Object.fromEntries(
      Object.entries(live ? process.env : { ...process.env, CODEX_HOME: root + "/auth" }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
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
    await page.evaluate(
      (model) =>
        window.scope.saveSettings({
          endpoint: "",
          token: "",
          diagnosis: { model, effort: "low" },
          review: { model, effort: "low" },
        }),
      live ? "gpt-6-astra" : "test-success",
    );
    await tool(page, "PR review");
    await page.locator("#review-address").fill("example/shop #148");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await page.locator("#review-chat-toggle").click();
    let requested = "";
    const send = async (text: string) => {
      requested = text;
      if (!(await page.locator("#conversation-input").isVisible()))
        await page.locator("#review-chat-toggle").click();
      await page.locator("#conversation-input").fill(text);
      await page.locator("#conversation-send").click();
    };
    const ready = async () => {
      await expect(page.locator(".conversation-message.user pre").last()).toHaveText(requested, {
        timeout: live ? 150000 : 12000,
      });
      await page.waitForFunction(
        () =>
          document.querySelector("#conversation-state")?.textContent?.includes("ready") &&
          document
            .querySelector("#conversation-entries")
            ?.lastElementChild?.classList.contains("assistant"),
        undefined,
        { timeout: live ? 150000 : 12000 },
      );
    };
    await send(
      live
        ? "Use scope_evidence list root, choose deleted.ts, then scope_guide source to highlight head lines 2 through 4. Use the issued ID and revision, path and side. Do this tool action, then stop with a short acknowledgment."
        : "guide source",
    );
    await page.locator("#conversation-input").fill("Keep this next draft");
    await ready();
    await expect(page.locator("#conversation-input")).toHaveValue("Keep this next draft");
    await expect(page.locator("#review-latest-target")).toBeVisible();
    await page.locator("#review-latest-target").click();
    await expect(page.locator(".agent-highlight")).toHaveCount(3);
    await shot("01-source-highlight");
    if (!live) {
      await app.evaluate(({ ipcMain }) => {
        const handler = Reflect.get(ipcMain, "_invokeHandlers").get("scope:guidance");
        ipcMain.removeHandler("scope:guidance");
        ipcMain.handle("scope:guidance", async (event, request) => {
          if (request.action === "read") {
            ipcMain.removeHandler("scope:guidance");
            ipcMain.handle("scope:guidance", handler);
            Reflect.set(globalThis, "guideReadDelayed", true);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          return handler(event, request);
        });
      });
      await send("guide source queued");
      await expect
        .poll(() => app.evaluate(() => Reflect.get(globalThis, "guideReadDelayed")))
        .toBe(true);
      await page.locator("#review-follow").click();
      await page.getByRole("button", { name: "head line 20", exact: true }).click();
      await page.locator("#review-follow").click();
      await ready();
      await expect(page.locator("#review-selection")).toContainText("line 20");
      await expect(page.locator("#review-latest-target")).toBeVisible();
      await shot("01-queued-pause-resume");
      await page.locator("#review-latest-target").click();
      await expect(page.locator("#review-selection")).toContainText("line 2");
    }

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1000, 700),
    );
    await expect(page.locator(".agent-highlight")).toHaveCount(3);
    await shot("02-source-resized");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
    await page.locator("#review-view").click();
    await page.getByRole("menuitem", { name: "Visual evidence", exact: true }).click();
    const png = await app.evaluate(({ nativeImage }) => {
      const bytes = Buffer.alloc(300 * 200 * 4, 210);
      for (let i = 3; i < bytes.length; i += 4) bytes[i] = 255;
      return nativeImage
        .createFromBitmap(bytes, { width: 300, height: 200 })
        .toPNG()
        .toString("base64");
    });
    await writeFile(root + "/supplied.png", Buffer.from(png, "base64"));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, root + "/supplied.png");
    await page.getByRole("button", { name: "Add screenshot", exact: true }).click();
    await expect(page.getByRole("button", { name: "supplied.png", exact: true })).toBeVisible();
    await send(
      live
        ? "Use scope_evidence images, then scope_guide image on the first supplied image with its pinned head revision. Add an arrow from [20,20] to [180,100], a stroke [[30,130],[180,140],[230,120]], and text Check this control at [50,60]. Each mark has kind, points and text, use empty text for arrow/stroke. Do the action and stop."
        : "guide image",
    );
    await ready();
    await expect(page.locator(".review-drawing")).toBeVisible();
    await shot("03-image-marks");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(600, 700),
    );
    await expect(page.locator(".review-drawing")).toBeVisible();
    const alignment = await page.locator(".review-image-marked").evaluate((wrap) => {
      const i = wrap.querySelector("img")!.getBoundingClientRect(),
        s = wrap.querySelector("svg")!.getBoundingClientRect();
      return Math.max(
        Math.abs(i.width - s.width),
        Math.abs(i.height - s.height),
        Math.abs(i.x - s.x),
        Math.abs(i.y - s.y),
      );
    });
    expect(alignment).toBeLessThan(1);
    await shot("04-image-narrow");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
    await send(
      live
        ? "Use scope_evidence list root for deleted.ts. Use scope_guide diagram with nodes Reader, Service, Store, messages from 0 to 1 Request evidence, from 1 to 2 Read pinned source, from 2 to 0 Return evidence. Include sources with issued deleted.ts ID, revision, path, head side, line 2, endLine 4. Create this local diagram and stop."
        : "guide diagram",
    );
    await ready();
    await expect(page.locator(".review-sequence")).toBeVisible();
    await shot("05-sequence");
    await page.getByRole("button", { name: /deleted.ts · head lines/ }).click();
    await expect(page.locator(".agent-highlight")).toHaveCount(3);
    if (!live) {
      await send("guide burst");
      await expect(page.locator("#review-lens")).toContainText("Security");
      await page.locator("#review-follow").click();
      const held = await page.locator("#review-lens").innerText();
      await page.locator("#review-lens").click();
      await page.getByRole("menuitem", { name: "Architecture", exact: true }).click();
      await ready();
      await expect(page.locator("#review-lens")).toContainText("Architecture");
      expect(held).toBeTruthy();
      await shot("06-paused-burst-manual");
      await page.locator("#review-follow").click();
      await expect(page.locator("#review-lens")).toContainText("Architecture");
      await page.waitForTimeout(300);
      await expect(page.locator("#review-lens")).toContainText("Architecture");
      await shot("07-resume-no-replay");
      await send("guide source");
      await page.locator("#review-lens").click();
      await ready();
      await expect(page.getByRole("menu", { name: /Architecture/ })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Architecture", exact: true })).toBeFocused();
      await shot("08-dropdown-focus");
      await page.keyboard.press("Escape");
      await send("guide source");
      await tool(page, "Settings");
      await expect(page.locator("#settings")).toBeVisible();
      await page.waitForTimeout(1500);
      await expect(page.locator("#settings")).toBeVisible();
      await shot("09-settings-retained");
      await expect(page.locator("#review-return")).toBeVisible();
      await page.locator("#review-return").click();
      await expect(page.locator("#review-entry")).toBeVisible();
    }
    await page.locator("#review-view").click();
    await page.getByRole("menuitem", { name: "Visual evidence", exact: true }).click();
    await page.getByRole("button", { name: "supplied.png", exact: true }).click();
    await page.getByRole("button", { name: "Remove screenshot", exact: true }).click();
    await page.locator("#review-artifacts").click();
    await expect(page.locator("#review-dialog")).toContainText("evidence removed or stale");
    await expect(page.locator("#review-dialog")).toContainText("supplied.png · 3 marks");
    await shot("10-removed-evidence");
    await page.getByRole("button", { name: "Clear marks and diagrams", exact: true }).click();
    await expect(page.locator(".review-drawing,.review-sequence,.agent-highlight")).toHaveCount(0);
    await shot("11-cleared");
    if (!live) {
      if ((await page.locator("#review-follow").innerText()) === "Pause follow")
        await page.locator("#review-follow").click();
      await send("guide source removal");
      await ready();
      await page.locator("#review-latest-target").click();
      await expect(page.locator(".agent-highlight")).toHaveCount(3);
      await expect(page.locator("#review-selection")).toContainText("line 2");
      if ((await page.locator("#review-follow").innerText()) === "Pause follow")
        await page.locator("#review-follow").click();
      await send("guide source later");
      await ready();
      await page.locator("#review-artifacts").click();
      const first = page.locator(".review-artifact").filter({ hasText: "head lines 2–4" });
      const later = page.locator(".review-artifact").filter({ hasText: "head lines 202–204" });
      await expect(first).toContainText("deleted.ts");
      await expect(later).toContainText("deleted.ts");
      await shot("12-identifiable-source-targets");
      await later.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(later).toHaveCount(0);
      await expect(page.locator("#review-selection")).toContainText("line 2");
      await first.getByRole("button", { name: "Remove", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(page.locator(".agent-highlight")).toHaveCount(0);
      await expect(page.locator("#review-selection")).toContainText("line 2");
      await page.locator("#review-next").click();
      await expect(page.getByRole("button", { name: "head line 201", exact: true })).toBeVisible();
      await shot("13-removed-source-next-page");
      await page.locator("#review-previous").click();
      await expect(page.getByRole("button", { name: "head line 1", exact: true })).toBeVisible();
      await send("guide diagram removal");
      await ready();
      await page.locator("#review-latest-target").click();
      await page.getByRole("button", { name: /deleted.ts · head lines/ }).click();
      await page.locator("#review-next").click();
      await expect(page.getByRole("button", { name: "head line 201", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "head line 220", exact: true }).click();
      await page.locator("#review-artifacts").click();
      await expect(page.locator(".review-artifact")).toContainText(
        "Diagram · Reader → Service → Store",
      );
      await page.getByRole("button", { name: "Clear marks and diagrams", exact: true }).click();
      await expect(page.getByRole("button", { name: "head line 220", exact: true })).toBeVisible();
      await expect(page.locator("#review-selection")).toContainText("line 220");
      await shot("14-cleared-diagram-source-position");
      await page.locator("#review-previous").click();
      await expect(page.getByRole("button", { name: "head line 1", exact: true })).toBeVisible();
      await page.locator("#review-next").click();
      await expect(page.getByRole("button", { name: "head line 201", exact: true })).toBeVisible();
      await shot("15-cleared-diagram-source-next-page");
    }
  } finally {
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
