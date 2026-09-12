import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, writeFile, readFile, stat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fakeCollector, fixtureEvent } from "./fake-collector.ts";

test("idle, Functions, private pairing settings, stop restart and retained inspection", async ({}, info) => {
  const root = await mkdtemp("/tmp/scope-settings-");
  const server = await fakeCollector();
  const external = JSON.stringify({
    endpoint: server.endpoint,
    tokenFile: root + "/external-token",
  });
  await writeFile(root + "/external-token", "synthetic-test-token", { mode: 0o600 });
  await writeFile(root + "/external.json", external, { mode: 0o600 });
  const app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      `--scope-test-root=${root}`,
      `--connection-config=${root}/external.json`,
    ],
    chromiumSandbox: true,
    recordVideo: { dir: info.outputPath("video"), size: { width: 1180, height: 820 } },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const video = page.video()!;
  const tool = async (name: string) => {
    await page.locator("#functions summary").click();
    await page.locator(`[data-tool="${name}"]`).click();
  };
  const screenshot = async (name: string) => {
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
  };
  try {
    await page.waitForSelector('html[data-ready="true"]');
    await expect(page.locator("h1")).toHaveText("Codex Scope");
    await expect(page.locator(".connection")).toHaveText("Stopped");
    await page.waitForTimeout(2200);
    const idle = await app.evaluate(({ app }) => ({
      history: globalThis.scopeHistory.snapshot(),
      metrics: app.getAppMetrics(),
    }));
    expect(idle.history.total).toBe(0);
    expect(server.state.streamCount).toBe(0);
    await screenshot("01-idle");
    await page.locator("#functions summary").click();
    await page.locator("#function-search").fill("missing");
    await expect(page.locator("#function-empty")).toBeVisible();
    await page.locator("#function-search").fill("review");
    await screenshot("02-function-search");
    await page.locator("#function-search").press("Enter");
    await expect(page.locator("#review-entry")).toContainText("not available yet");
    await tool("settings");
    await expect(page.locator("#collector-token")).toHaveValue("");
    await expect(page.locator("#settings-override")).toBeVisible();
    const settings = await page.evaluate(() => window.scope.settings());
    expect(JSON.stringify(settings)).not.toContain("synthetic-test-token");
    expect(
      await page.evaluate(async () => {
        try {
          await Reflect.apply(window.scope.capture.bind(window.scope), null, ["yes"]);
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    expect(
      await page.evaluate(async () => {
        try {
          await window.scope.saveSettings({
            endpoint: "x".repeat(6000),
            token: "",
            model: "gpt-5.6-luna",
          });
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    await page.locator("#collector-url").fill(server.endpoint + "/bad-path");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-status")).toContainText("not saved");
    await screenshot("03-invalid-settings");
    await page.locator("#collector-url").evaluate((input, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, server.endpoint + "/?token=synthetic-test-token&token=other");
    await expect(page.locator("#settings-status")).toContainText("invalid");
    await page.locator("#collector-url").evaluate((input, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, server.endpoint + "/?token=synthetic-test-token");
    await expect(page.locator("#collector-url")).toHaveValue(server.endpoint + "/");
    await expect(page.locator("#collector-token")).toHaveValue("synthetic-test-token");
    await screenshot("04-pairing-import");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-status")).toContainText("Settings saved");
    expect((await stat(root + "/preferences.json")).mode & 0o777).toBe(0o600);
    expect(await readFile(root + "/external-token", "utf8")).toBe("synthetic-test-token");
    expect(await readFile(root + "/external.json", "utf8")).toBe(external);
    await page.locator("#capture").click();
    await expect(page.locator(".connection")).toHaveText("Connected");
    await tool("journal");
    server.event(fixtureEvent);
    await expect(page.locator("#count")).toHaveText("1 retained");
    await page.locator(".event").first().click();
    const held = await page.locator("#payload").getAttribute("data-event");
    await tool("settings");
    await page.locator("#collector-url").fill("http://non-loopback.invalid");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-status")).toContainText("not saved");
    await expect(page.locator(".connection")).toHaveText("Connected");
    expect((await page.evaluate(() => window.scope.settings())).endpoint).toBe(server.endpoint);
    await page.screenshot({ path: info.outputPath("04b-capturing-save-error.png") });
    await page.locator("#collector-url").fill(server.endpoint);
    await tool("journal");
    await app.evaluate(async () => {
      await globalThis.scopeHistory.call("test", { faults: { transportDelay: 450 } });
    });
    server.event(fixtureEvent);
    await page.waitForTimeout(50);
    const stop = performance.now();
    await page.locator("#capture").click();
    await expect(page.locator(".connection")).toHaveText("Stopped");
    const stopMs = performance.now() - stop;
    await page.waitForTimeout(550);
    expect((await page.evaluate(() => window.scope.status())).total).toBe(1);
    await expect(page.locator("#payload")).toHaveAttribute("data-event", held!);
    await screenshot("05-stopped-inspection");
    await page.locator("#capture").click();
    await expect(page.locator(".connection")).toHaveText("Connected");
    await app.evaluate(async () => {
      await globalThis.scopeHistory.call("test", { faults: { transportDelay: 0 } });
    });
    for (let i = 0; i < 30; i++) server.event(fixtureEvent);
    await expect
      .poll(async () => (await page.evaluate(() => window.scope.status())).total)
      .toBeGreaterThan(1);
    await expect(page.locator("#payload")).toHaveAttribute("data-event", held!);
    await tool("settings");
    await page.locator("#settings-save").click();
    await expect(page.locator(".connection")).toHaveText("Stopped");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await screenshot("06-narrow-settings");
    const end = await app.evaluate(({ app }) => ({
      history: globalThis.scopeHistory.snapshot(),
      metrics: app.getAppMetrics(),
    }));
    await writeFile(
      info.outputPath("resources.json"),
      JSON.stringify({ idle, end, stopMs }, null, 2),
    );
    expect(errors).toEqual([]);
  } finally {
    const quit = performance.now();
    await app.close();
    await writeFile(
      info.outputPath("quit.json"),
      JSON.stringify({ quitMs: performance.now() - quit }),
    );
    await video.saveAs(info.outputPath("walkthrough.webm"));
    await server.close();
  }
});

test("unavailable imported credentials and failed saves recover, saved launch stays stopped", async ({}, info) => {
  const root = await mkdtemp("/tmp/scope-settings-recovery-");
  const server = await fakeCollector();
  await writeFile(
    root + "/external.json",
    JSON.stringify({ endpoint: server.endpoint, tokenFile: root + "/missing" }),
    { mode: 0o600 },
  );
  const launch = (extra: string[] = []) =>
    _electron.launch({
      args: [path.resolve("dist/app"), "--history-test", `--scope-test-root=${root}`, ...extra],
      chromiumSandbox: true,
      recordVideo: { dir: info.outputPath("video") },
    });
  await writeFile(root + "/connection.json", await readFile(root + "/external.json"), {
    mode: 0o600,
  });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('html[data-ready="true"]');
    await page.locator("#capture").click();
    await expect(page.locator("h1")).toHaveText("Settings");
    await expect(page.locator("#settings-status")).toContainText("valid connection");
    await page.screenshot({ path: info.outputPath("01-missing-credentials.png") });
    await page.locator("#collector-url").fill(server.endpoint);
    await page.locator("#collector-token").fill("synthetic-test-token");
    await mkdir(root + "/preferences.json");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-status")).toContainText("not saved");
    expect((await page.evaluate(() => window.scope.settings())).hasToken).toBe(false);
    await page.screenshot({ path: info.outputPath("02-save-failure.png") });
    await rm(root + "/preferences.json", { recursive: true });
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-status")).toContainText("Settings saved");
    await page.locator("#capture").click();
    await expect(page.locator(".connection")).toHaveText("Connected");
    await page.screenshot({ path: info.outputPath("03-recovered.png") });
    const video = page.video()!;
    await app.close();
    await video.saveAs(info.outputPath("recovery.webm"));
    const streams = server.state.streamCount;
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.waitForSelector('html[data-ready="true"]');
    await reopened.waitForTimeout(1000);
    expect(server.state.streamCount).toBe(streams);
    expect((await reopened.evaluate(() => window.scope.settings())).hasToken).toBe(true);
    await expect(reopened.locator(".connection")).toHaveText("Stopped");
    await reopened.screenshot({ path: info.outputPath("04-reopened-idle.png") });
    await app.close();
    app = await launch(["--fixtures-only"]);
    const fixtures = await app.firstWindow();
    await fixtures.waitForSelector('html[data-ready="true"]');
    await expect(fixtures.locator(".connection")).toHaveText("Synthetic data");
    await expect(fixtures.locator("#count")).toHaveText("5 retained");
    expect(server.state.streamCount).toBe(streams);
  } finally {
    await app.close();
    await server.close();
  }
});
