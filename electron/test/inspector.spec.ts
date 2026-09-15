import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import type { Page, ElectronApplication, TestInfo } from "@playwright/test";
import { test, expect, _electron } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const appPath = path.resolve("dist/app");
const messages = (await readFile("fixtures/journal.jsonl", "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const original = (id: number) => messages[id].payload;
const offset = (page: Page) => page.locator("#payload").evaluate((node) => node.scrollTop);
const maximum = (page: Page) =>
  page.locator("#payload").evaluate((node) => node.scrollHeight - node.clientHeight);

async function launch(testInfo: TestInfo, target = appPath) {
  const owner = await mkdtemp(path.join(tmpdir(), "scope-inspector-owner-"));
  const app = await _electron.launch({
    args: [target, "--fixtures-only", "--history-test", `--scope-test-root=${owner}`],
    chromiumSandbox: true,
    recordVideo: { dir: testInfo.outputPath("video"), size: { width: 1180, height: 820 } },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.ready ||
      document.querySelector<HTMLElement>("#notice")!.textContent,
  );
  if (await page.locator('tr[data-event="4"]').count()) await select(page, 4);
  return { app, page, video: page.video()! };
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(350);
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}
async function select(page: Page, id: number) {
  if (await page.locator("#call-detail").isVisible()) await page.locator("#detail-close").click();
  await page.locator(`tr[data-event="${id}"]`).click();
  await page.locator('[data-tab="json"]').click();
  await expect(page.locator("#payload")).toHaveAttribute("data-event", String(id));
}
async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]),
    [width, height],
  );
}
async function touchDrag(page: Page, x: number, y: number, destination: number) {
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + ((destination - y) * step) / 8 }],
    });
    await page.waitForTimeout(40);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(250);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await client.detach();
}

test("recorded overlay preserves original bytes, scroll controls, copy failure recovery and narrow layout", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await expect(page.locator("#json")).toHaveText(original(4), { useInnerText: false });
    await page.locator("#copy").click();
    await expect(page.locator("#copy")).toHaveText("Copied");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(original(4));
    await app.evaluate(({ clipboard }) => {
      const write = clipboard.writeText.bind(clipboard);
      clipboard.writeText = () => {
        clipboard.writeText = write;
        return Promise.reject(new Error("Synthetic failure"));
      };
    });
    await page.locator("#copy").click();
    await expect(page.locator("#copy-status")).toContainText("Copy failed");
    await capture(page, info, "copy-failure");
    await page.locator("#copy").click();
    await expect(page.locator("#copy")).toHaveText("Copied");
    const track = page.getByRole("scrollbar", { name: "Scroll payload" });
    await expect(track).toBeVisible();
    await page.locator("#payload").hover();
    await page.mouse.wheel(0, 480);
    await expect.poll(() => offset(page)).toBeGreaterThan(100);
    await track.press("Home");
    await expect.poll(() => offset(page)).toBe(0);
    await track.press("ArrowDown");
    await expect.poll(() => offset(page)).toBe(40);
    await track.press("ArrowUp");
    await expect.poll(() => offset(page)).toBe(0);
    await track.press("PageDown");
    await expect.poll(() => offset(page)).toBeGreaterThan(100);
    await track.press("End");
    await expect.poll(() => offset(page)).toBe(await maximum(page));
    await track.press("Home");
    const bounds = await track.boundingBox();
    assert(bounds);
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.45);
    expect(await offset(page)).toBeGreaterThan(100);
    const thumb = await page.locator("#thumb").boundingBox();
    assert(thumb);
    await touchDrag(page, thumb.x + 5, thumb.y + 12, thumb.y + 95);
    await capture(page, info, "payload-scroll");
    await resize(app, 440, 820);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await capture(page, info, "narrow-overlay");
    await page.keyboard.press("Escape");
    await expect(page.locator("#call-detail")).not.toBeVisible();
    await expect(page.locator("#live")).toHaveText("Resume live");
    await page.locator('tr[data-event="4"]').press("Enter");
    await expect(page.locator("#call-detail")).toBeVisible();
    await page.locator('[data-tab="input"]').click();
    await capture(page, info, "input-tab");
    await page.locator('[data-tab="response"]').click();
    await capture(page, info, "response-tab");
    await resize(app, 360, 640);
    expect(await page.locator("#payload").evaluate((n) => n.clientHeight)).toBeGreaterThan(30);
    await capture(page, info, "minimum-overlay");
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("overlay-walkthrough.webm"));
  }
});

test("security boundaries deny Node, remote content, navigation, extra windows and invalid requests", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await page.waitForSelector('html[data-ready="true"]');
    const prefs = await app.evaluate(({ BrowserWindow }) =>
      (
        BrowserWindow.getAllWindows()[0].webContents as Electron.WebContents & {
          getLastWebPreferences(): Electron.WebPreferences;
        }
      ).getLastWebPreferences(),
    );
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
    });
    expect(app.process().spawnargs).not.toContain("--no-sandbox");
    expect(
      await page.evaluate(() => [typeof require, typeof process, Object.keys(window.scope).sort()]),
    ).toEqual([
      "undefined",
      "undefined",
      [
        "analysisCancel",
        "analysisDecide",
        "analysisExport",
        "analysisList",
        "analysisRun",
        "analysisStart",
        "cancel",
        "cancelModels",
        "capture",
        "choices",
        "clear",
        "copyPayload",
        "inspect",
        "models",
        "navigate",
        "onAnalysis",
        "onHidden",
        "onStatus",
        "saveSettings",
        "settings",
        "status",
      ],
    ]);
    expect(
      await page.evaluate(async () => {
        try {
          await Reflect.apply(
            (...args: unknown[]) =>
              Reflect.apply(window.scope.inspect.bind(window.scope), window.scope, args),
            null,
            [1, {}, 999],
          );
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    expect(await page.evaluate(() => window.scope.copyPayload(1, -1))).toBe(false);
    expect(
      await page.evaluate(async () => {
        const generation = (await window.scope.status()).generation;
        const results = await Promise.allSettled([
          window.scope.analysisStart(generation, "session", "bad;model", "low", null),
          window.scope.analysisRun(generation - 1, "old-run"),
          window.scope.analysisDecide(generation, "missing-run", "missing-finding", "kept"),
        ]);
        return results.every((result) => result.status === "rejected");
      }),
    ).toBe(true);
    const requests = await page.evaluate(() =>
      Promise.allSettled(Array.from({ length: 100 }, () => window.scope.inspect(1, 3, 5))).then(
        (results) => results.filter((item) => item.status === "fulfilled").length,
      ),
    );
    expect(requests).toBe(1);
    const foreignRequest = await app.evaluate(
      async ({ BrowserWindow, session }, preload) => {
        const other = new BrowserWindow({
          show: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            session: session.fromPartition("synthetic"),
            preload,
          },
        });
        try {
          await other.loadURL("scope://app/index.html");
          return await other.webContents.executeJavaScript(
            "new Promise(resolve => setTimeout(resolve, 100)).then(() => window.scope.inspect(1, 3, 5)).then(() => false, () => true)",
          );
        } finally {
          other.destroy();
        }
      },
      path.join(appPath, "preload.cjs"),
    );
    expect(foreignRequest).toBe(true);
    expect(
      await page.evaluate(async () => {
        try {
          await fetch("https://example.com");
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    expect(await page.evaluate(() => window.open("https://example.com"))).toBeNull();
    await page.evaluate(() => {
      location.href = "https://example.com";
    });
    await page.waitForTimeout(250);
    expect(page.url()).toBe("scope://app/index.html");
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await capture(page, info, "security-preserved");
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("security.webm"));
  }
});

test("a stalled native clipboard write times out with one pending operation and recovers", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await page.waitForSelector('html[data-ready="true"]');
    await app.evaluate(({ clipboard }) => {
      const original = clipboard.writeText.bind(clipboard);
      globalThis.clipboardCalls = 0;
      clipboard.writeText = () => {
        globalThis.clipboardCalls++;
        return new Promise<void>((resolve) => {
          globalThis.releaseClipboard = () => {
            clipboard.writeText = original;
            resolve();
          };
        });
      };
    });
    await page.locator("#copy").click();
    await expect(page.locator("#copy-status")).toContainText("Copy failed");
    await page.locator("#copy").click();
    await expect(page.locator("#copy-status")).toContainText("Copy failed");
    expect(await app.evaluate(() => globalThis.clipboardCalls)).toBe(1);
    await capture(page, info, "clipboard-timeout");
    await app.evaluate(() => {
      globalThis.releaseClipboard();
      Reflect.deleteProperty(globalThis, "releaseClipboard");
      Reflect.deleteProperty(globalThis, "clipboardCalls");
    });
    await page.locator("#copy").click();
    await expect(page.locator("#copy")).toHaveText("Copied");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(original(4));
    await capture(page, info, "clipboard-timeout-recovered");
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("clipboard-timeout.webm"));
  }
});

test("long session and tool labels leave the complete payload and byte count usable", async ({}, info) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "scope-metadata-test-"));
  await cp(appPath, temporary, { recursive: true });
  const session = "synthetic-session-".repeat(1000);
  const tool = "synthetic-tool-".repeat(1000);
  const raw = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: session,
    tool_name: tool,
    future_field: "complete",
  });
  const message = {
    ...messages[4],
    sequence: 1,
    session_id: session,
    tool_name: tool,
    payload: raw,
    payload_bytes: Buffer.byteLength(raw),
  };
  await writeFile(
    path.join(temporary, "fixtures/journal.jsonl.gz"),
    gzipSync([messages[0], message].map((value) => JSON.stringify(value)).join("\n")),
  );
  const { app, page, video } = await launch(info, temporary);
  try {
    await page.waitForSelector('html[data-ready="true"]');
    await resize(app, 360, 640);
    await select(page, 1);
    await expect(page.locator("#metadata")).toContainText(session);
    expect(await page.locator("#json").textContent()).toBe(raw);
    expect(await page.locator("#payload").evaluate((node) => node.clientHeight)).toBeGreaterThan(
      50,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator("#copy").click();
    await expect(page.locator("#copy")).toHaveText("Copied");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(raw);
    await capture(page, info, "long-metadata");
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("long-metadata.webm"));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a rejected oversized fixture remains absent while valid history stays usable", async ({}, info) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "scope-fixture-test-"));
  await cp(appPath, temporary, { recursive: true });
  const tooBig = { ...messages[4], sequence: 6, payload: original(4) + " ", payload_bytes: 61441 };
  await writeFile(
    path.join(temporary, "fixtures/journal.jsonl.gz"),
    gzipSync([...messages, tooBig].map((value) => JSON.stringify(value)).join("\n") + "\n"),
  );
  const { app, page, video } = await launch(info, temporary);
  try {
    await page.waitForSelector('html[data-ready="true"]');
    await expect(page.locator("#notice")).toContainText("1 oversized");
    await expect(page.locator("#count")).toHaveText("1");
    await select(page, 4);
    expect(await page.locator("#json").textContent()).toBe(original(4));
    await capture(page, info, "oversized-rejected");
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("oversized.webm"));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("empty and unreadable fixtures explain their state, with recovery after restart", async ({}, info) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "scope-empty-test-"));
  await cp(appPath, temporary, { recursive: true });
  try {
    for (const [name, text] of [
      ["empty", JSON.stringify(messages[0]) + "\n"],
      ["unreadable", "invalid"],
      ["recovered", messages.map((value) => JSON.stringify(value)).join("\n") + "\n"],
    ]) {
      await writeFile(path.join(temporary, "fixtures/journal.jsonl.gz"), gzipSync(text));
      const { app, page, video } = await launch(info, temporary);
      try {
        if (name === "unreadable")
          await expect(page.locator("#notice")).toContainText("could not be opened");
        else await page.waitForSelector('html[data-ready="true"]');
        if (name === "empty")
          await expect(page.locator("#empty-results")).toContainText("No tool calls");
        if (name === "recovered") await expect(page.locator("#json")).toHaveText(original(4));
        else await expect(page.locator("#copy")).toBeDisabled();
        await capture(page, info, name);
      } finally {
        await app.close();
        await video.saveAs(info.outputPath(`${name}.webm`));
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
