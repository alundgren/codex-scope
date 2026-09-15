import assert from "node:assert/strict";
import type { Faults } from "../src/types.ts";
import type { Page, ElectronApplication, TestInfo } from "@playwright/test";
import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fakeCollector, wait, until } from "./fake-collector.ts";
const source = (await readFile("fixtures/journal.jsonl", "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .map((event) => {
    if (event.type !== "event" || event.hook_type === "PostToolUse") return event;
    const payload = JSON.stringify({
      ...JSON.parse(event.payload),
      hook_event_name: "PostToolUse",
    });
    return {
      ...event,
      hook_type: "PostToolUse",
      payload,
      payload_bytes: Buffer.byteLength(payload),
    };
  });
const status = (app: ElectronApplication) => app.evaluate(() => globalThis.scopeHistory.snapshot());
const fault = (app: ElectronApplication, faults: Faults) =>
  app.evaluate(async (_electron, faults) => {
    const result = await globalThis.scopeHistory.call("test", { faults });
    if (!("ok" in result) || !result.ok) throw new Error("Worker diagnostics unavailable.");
    return result;
  }, faults);
async function launch(
  info: TestInfo,
  server: { endpoint: string },
  token = "synthetic-test-token",
  root?: string,
) {
  root ??= await mkdtemp("/tmp/scope-transport-test-");
  await writeFile(root + "/token", token, { mode: 0o600 });
  await writeFile(
    root + "/connection.json",
    JSON.stringify({ endpoint: server.endpoint, tokenFile: root + "/token" }),
    { mode: 0o600 },
  );
  const app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      `--scope-test-root=${root}`,
      `--connection-config=${root}/connection.json`,
    ],
    chromiumSandbox: true,
    recordVideo: { dir: info.outputPath("video"), size: { width: 1180, height: 820 } },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  await page.locator("#capture").click();
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="journal"]').click();
  return { app, page, root, video: page.video()! };
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}
async function seed(server: Awaited<ReturnType<typeof fakeCollector>>) {
  for (const event of source.slice(1)) {
    server.event(event);
    await wait(30);
  }
}

test("recorded transport: connection, held reconnect, totals, local drops, Clear and hidden capture", async ({}, info) => {
  const server = await fakeCollector(),
    { app, page, video } = await launch(info, server);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await expect(page.locator(".connection")).toHaveText("Connected");
    await expect(page.locator("#notice")).toContainText("Coverage before connection");
    await expect(page.locator("#empty-results")).toHaveText("No tool calls have arrived.");
    await capture(page, info, "connected-empty");
    await seed(server);
    await expect(page.locator("#count")).toHaveText("5");

    await capture(page, info, "transport-desktop");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await capture(page, info, "transport-narrow");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1180, 760),
    );
    await page.locator('tr[data-event="4"]').click();
    await page.locator('[data-tab="json"]').click();
    await page.locator("#scrollbar").press("PageDown");
    const offset = await page.locator("#payload").evaluate((node) => node.scrollTop),
      rows = await page.locator("#entries").innerText();
    expect(offset).toBeGreaterThan(0);
    const initial = await app.evaluate(() => globalThis.scopeHistory.inspect(1, 4, 5));
    assert("selected" in initial && initial.selected);
    expect(initial.selected!.text).toBe(source[4].payload);
    expect(initial.selected!.bytes).toBe(61440);
    const oldConnection = (await status(app)).connectionId;
    server.state.status = 503;
    server.disconnect();
    await expect(page.locator(".connection")).toHaveText("Disconnected");
    await expect(page.locator("#notice")).toContainText("Collector is busy");
    await capture(page, info, "disconnected-held");
    expect(await page.locator("#entries").innerText()).toBe(rows);
    expect(await page.locator("#payload").evaluate((node) => node.scrollTop)).toBe(offset);
    server.state.status = 200;
    await expect(page.locator(".connection")).toHaveText("Connected");
    expect((await status(app)).connectionId).not.toBe(oldConnection);
    server.event(source[1]);
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "1");
    expect(await page.locator("#payload").getAttribute("data-event")).toBe("4");
    expect(await page.locator("#payload").evaluate((node) => node.scrollTop)).toBe(offset);
    await capture(page, info, "reconnected-held");
    server.state.knownDrops.queue = 9;
    server.state.knownDrops.no_viewer = 12;
    await expect(page.locator("#notice")).toContainText(
      "Collector lifetime drops: 12 no_viewer, 9 queue",
    );
    await fault(app, { disk: true });
    server.event(source[1]);
    await expect(page.locator("#notice")).toContainText("Known local drops: 1 storage");
    await capture(page, info, "collector-local-drops");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await capture(page, info, "drops-narrow");
    await page.locator("#notice").focus();
    await page.locator("#notice").press("End");
    await capture(page, info, "local-drops-narrow");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1180, 760),
    );
    await fault(app, { disk: false });
    server.event(source[1]);
    await expect(page.locator("#notice")).not.toContainText("Storage pressure");
    server.state.knownDrops = {
      no_viewer: 0,
      invalid: 0,
      oversized: 0,
      rate: 0,
      queue: 0,
      disconnect: 0,
    };
    server.disconnect();
    await expect.poll(async () => (await status(app)).transport?.collectorTotals?.queue).toBe(0);
    await expect(page.locator("#notice")).not.toContainText("Collector lifetime drops");
    await expect(page.locator("#notice")).toContainText("Known local drops: 1 storage");
    await capture(page, info, "counter-reset");
    await page.locator("#detail-close").click();
    await page.locator("#clear").click();
    await fault(app, { transportDelay: 1200, delay: 1200 });
    const connection = server.state.connectionId;
    server.event(source[2]);
    let inspectionSettled = false;
    const pending = app
      .evaluate(() => globalThis.scopeHistory.inspect(1, 4, 5))
      .then((result) => {
        inspectionSettled = true;
        return result;
      });
    await expect
      .poll(() =>
        app.evaluate(() =>
          [...globalThis.scopeHistory.pending.values()].some(
            (request) => request.operation === "inspect",
          ),
        ),
      )
      .toBe(true);
    expect(inspectionSettled).toBe(false);
    await page.locator("#clear").click();
    await expect(page.locator("#count")).toHaveText("0");
    await expect(page.locator("#json")).toBeEmpty();
    await expect.poll(async () => (await status(app)).generation).toBe(2);
    expect(await pending).toHaveProperty("stale", true);
    await until(() => server.state.connectionId !== connection);
    await wait(1300);
    expect((await status(app)).total).toBe(0);
    await capture(page, info, "clear-reconnected");
    await fault(app, { transportDelay: 0, delay: 0 });
    server.event(source[3]);
    await expect(page.locator("#count")).toHaveText("1");
    await page.locator("#entries tr").first().click();
    await page.locator('[data-tab="json"]').click();
    await expect(page.locator("#json")).toHaveText(source[3].payload);
    await page.locator("#detail-close").click();
    await capture(page, info, "clear-recovered");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    for (let index = 0; index < 8; index++) {
      server.event(source[1]);
      await wait(350);
    }
    expect((await status(app)).total).toBe(9);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await expect(page.locator("#count")).toHaveText("9");
    await capture(page, info, "hidden-recovered");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      )
      .toBe(true);
    const minimizedText = await page.locator("#count").textContent();
    for (let index = 0; index < 6; index++) {
      server.event(source[1]);
      await wait(350);
    }
    expect((await status(app)).total).toBe(15);
    expect(await page.locator("#count").textContent()).toBe(minimizedText);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].restore();
      BrowserWindow.getAllWindows()[0].show();
    });
    await expect(page.locator("#count")).toHaveText("15");
    await capture(page, info, "minimized-recovered");
    expect(errors).toEqual([]);
    expect(
      server.state.requests.every(
        (value) =>
          value.authorization && ["/v1/stream", "/v1/heartbeat"].includes(value.path ?? ""),
      ),
    ).toBe(true);
    await page.locator("#live").click();
    await page.locator("#entries tr").first().click();
    await page.locator('[data-tab="json"]').click();
    await page.locator("#copy").click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(source[1].payload);
    await page.locator("#detail-close").click();
    await fault(app, { cleanup: true });
    await page.locator("#clear").click();
    await page.locator("#clear").click();
    await expect(page.locator("#notice")).toContainText("Temporary recording files remain");
    await expect(page.locator(".connection")).toHaveText("Stopped");
    await expect(page.locator("#empty-results")).toHaveText("Temporary history is unavailable.");
    await expect(page.getByRole("button", { name: "Reset filters" })).toHaveCount(0);
    expect((await page.locator("#notice").innerText()).match(/Clear failed/g)).toHaveLength(1);
    await until(() => server.state.stream!.destroyed);
    await capture(page, info, "clear-cleanup-failed");
    await fault(app, { cleanup: false });
  } finally {
    await app.close();
    await server.close();
  }
  await video.saveAs(info.outputPath("transport-walkthrough.webm"));
});

test("recorded authentication and second-viewer failures recover on configuration restart or free lease", async ({}, info) => {
  const server = await fakeCollector();
  let run: Awaited<ReturnType<typeof launch>> | null = await launch(
    info,
    server,
    "wrong-synthetic-token",
  );
  try {
    await expect(run.page.locator("#notice")).toContainText("Authentication failed");
    await capture(run.page, info, "authentication-failed");
    const requests = server.state.requestCount;
    await wait(1500);
    expect(server.state.requestCount).toBe(requests);
    await run.app.close();
    await run.video.saveAs(info.outputPath("authentication-walkthrough.webm"));
    server.state.status = 409;
    run = await launch(info, server);
    await expect(run.page.locator("#notice")).toContainText("Another viewer is connected");
    await capture(run.page, info, "second-viewer");
    await run.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await capture(run.page, info, "second-viewer-narrow");
    server.state.status = 200;
    await expect(run.page.locator(".connection")).toHaveText("Connected");
    server.event(source[1]);
    await expect(run.page.locator("#count")).toHaveText("1");
    await capture(run.page, info, "second-viewer-recovered");
    server.state.status = 401;
    server.disconnect();
    await expect(run.page.locator("#notice")).toContainText("Authentication failed");
    const beforeClear = server.state.requestCount;
    await run.page.locator("#clear").click();
    await run.page.locator("#clear").click();
    await expect(run.page.locator("#count")).toHaveText("0");
    await expect(run.page.locator("#notice")).toContainText("Authentication failed");
    await wait(1200);
    expect(server.state.requestCount).toBe(beforeClear);
    await capture(run.page, info, "authentication-clear");
    await run.app.close();
    await run.video.saveAs(info.outputPath("conflict-walkthrough.webm"));
    run = null;
  } finally {
    if (run) await run.app.close();
    await server.close();
  }
});

test("recorded stalled storage releases lease and drops old transport work before recovery", async ({}, info) => {
  const server = await fakeCollector(),
    { app, page, video } = await launch(info, server);
  try {
    await expect(page.locator(".connection")).toHaveText("Connected");
    await seed(server);
    await expect(page.locator("#count")).toHaveText("5");
    await page.locator('tr[data-event="4"]').click();
    await page.locator('[data-tab="json"]').click();
    await page.locator("#scrollbar").press("PageDown");
    const offset = await page.locator("#payload").evaluate((node) => node.scrollTop);
    await fault(app, { transportDelay: 6500 });
    server.event(source[1]);
    await expect(page.locator("#notice")).toContainText("Intake stopped making progress");
    await capture(page, info, "stalled-storage");
    const requests = server.state.heartbeats;
    await wait(2100);
    expect(server.state.heartbeats).toBe(requests);
    await fault(app, { transportDelay: 0 });
    await expect(page.locator(".connection")).toHaveText("Connected");
    server.event(source[1]);
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "1");
    expect((await status(app)).total).toBe(6);
    expect(await page.locator("#payload").evaluate((node) => node.scrollTop)).toBe(offset);
    await capture(page, info, "stalled-recovered");
  } finally {
    await app.close();
    await server.close();
  }
  await video.saveAs(info.outputPath("stalled-walkthrough.webm"));
});

test("recorded worker exit disconnects capture and restart opens a fresh recording", async ({}, info) => {
  const server = await fakeCollector();
  let run: Awaited<ReturnType<typeof launch>> | null = await launch(info, server);
  const root = run.root;
  try {
    await expect(run.page.locator(".connection")).toHaveText("Connected");
    await seed(server);
    await expect(run.page.locator("#count")).toHaveText("5");
    await run.page.locator('tr[data-event="4"]').click();
    await run.page.locator('[data-tab="json"]').click();
    await expect(run.page.locator("#payload")).toHaveAttribute("data-event", "4");
    await run.page.locator("#scrollbar").press("PageDown");
    const offset = await run.page.locator("#payload").evaluate((node) => node.scrollTop);
    const rows = await run.page.locator("#entries").textContent();
    const rank = await run.page.locator("#page-position").textContent();
    expect(offset).toBeGreaterThan(0);
    await run.page.locator("#clear").evaluate((n: HTMLButtonElement) => n.click());
    await run.app.evaluate(() => globalThis.scopeHistory.worker.terminate());
    await expect(run.page.locator(".connection")).toHaveText("Disconnected");
    await expect(run.page.locator("#notice")).toContainText(
      "Temporary history is unavailable. Restart the app",
    );
    await expect(run.page.locator("#notice")).not.toContainText("Reconnecting");
    await expect(run.page.locator("#notice")).toContainText("across gaps is unknown");
    expect((await status(run.app)).transport).toMatchObject({
      state: "disconnected",
      requiresRestart: true,
      coverageUnknown: true,
      requests: 0,
      processing: 0,
      retryPending: false,
    });
    await until(() => server.state.stream!.destroyed);
    const requests = server.state.requestCount;
    await wait(2200);
    expect(server.state.requestCount).toBe(requests);
    await expect(run.page.locator("#json")).toHaveText(source[4].payload);
    await expect(run.page.locator("#entries")).toHaveAttribute("aria-busy", "false");
    for (const id of ["clear", "live", "copy", "search", "filter-open"])
      await expect(run.page.locator(`#${id}`)).toBeDisabled();
    await expect(run.page.locator("#filter-picker")).toBeHidden();
    await expect(run.page.locator("#clear")).toHaveAccessibleName("Unlock Clear history");
    for (const row of await run.page.locator(".event").all())
      await expect(row).toHaveAttribute("aria-disabled", "true");
    await run.page.locator("#filter-open").dispatchEvent("click");
    await run.page.locator("#search").dispatchEvent("input");
    expect(await run.page.locator("#page-position").textContent()).toBe(rank);
    expect(await run.page.locator("#entries").textContent()).toBe(rows);
    expect(await run.page.locator("#payload").evaluate((node) => node.scrollTop)).toBe(offset);
    await expect(run.page.locator("#count")).toHaveText("5");
    await expect(run.page.locator("#notice")).not.toContainText("Searching");
    await expect(run.page.locator("#filter-picker")).toBeHidden();
    const rejectedClear = await run.app.evaluate(() =>
      globalThis.scopeHistory.clear(globalThis.scopeHistory.generation),
    );
    expect(rejectedClear.error).toContain("Restart the app");
    expect(await status(run.app)).toMatchObject({ generation: 1, total: 5 });
    await run.page.locator("#payload").focus();
    await run.page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector<HTMLElement>("#json")!);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await run.page.keyboard.press("Control+c");
    // Native selection copy omits the final layout newline. Copy JSON has separate exact-byte checks.
    expect(await run.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      source[4].payload.replace(/\n$/, ""),
    );
    expect(await run.page.locator("#json").textContent()).toBe(source[4].payload);
    await run.page.evaluate(() => getSelection()!.removeAllRanges());
    await capture(run.page, info, "worker-exit");
    await run.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await capture(run.page, info, "worker-exit-narrow");
    await run.app.close();
    await run.video.saveAs(info.outputPath("worker-exit-walkthrough.webm"));
    run = await launch(info, server, "synthetic-test-token", root);
    await expect(run.page.locator(".connection")).toHaveText("Connected");
    await expect(run.page.locator("#count")).toHaveText("0");
    await expect(run.page.locator("#json")).toBeEmpty();
    server.event(source[1]);
    await run.page.locator("#entries tr").first().click();
    await run.page.locator('[data-tab="json"]').click();
    await expect(run.page.locator("#json")).toHaveText(source[1].payload);
    await expect(run.page.locator("#notice")).not.toContainText("unavailable");
    for (const id of ["clear", "live", "copy", "search", "filter-open"])
      await expect(run.page.locator(`#${id}`)).toBeEnabled();
    await capture(run.page, info, "worker-restart-recovered");
    await run.app.close();
    await run.video.saveAs(info.outputPath("worker-restart-walkthrough.webm"));
    run = null;
  } finally {
    if (run) await run.app.close();
    await server.close();
  }
});
