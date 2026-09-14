import { PROMPT_IDS, REVIEW_PROMPTS } from "../src/review-prompts.ts";
import { _electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { sample, bytes } from "./process-metrics.ts";
import { fakeCollector, fixtureEvent, wait } from "../test/fake-collector.ts";
const root = await mkdtemp("/tmp/scope-review-measure-");
const server = await fakeCollector();
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
});
const results: Record<string, unknown> = {
  environment:
    "Linux Xvfb, sandbox and GPU enabled, no video/screenshots; synthetic CLI and gh fixtures. Samples include all Electron descendants and review child.",
};
try {
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  await page.evaluate(
    (endpoint) =>
      window.scope.saveSettings({
        endpoint,
        token: "synthetic-test-token",
        diagnosis: { model: "test-success", effort: "low" },
        review: { model: "test-success", effort: "low" },
      }),
    server.endpoint,
  );
  await page.evaluate(() => {
    const value = { count: 0, maxMs: 0, totalMs: 0 };
    new PerformanceObserver((list) => {
      for (const item of list.getEntries()) {
        value.count++;
        value.maxMs = Math.max(value.maxMs, item.duration);
        value.totalMs += item.duration;
      }
    }).observe({ type: "longtask", buffered: false });
    Reflect.set(window, "scopeMeasureLongTasks", value);
  });
  await app.evaluate(() => {
    const d = {
      last: performance.now(),
      count: 0,
      maxDelayMs: 0,
      totalDelayMs: 0,
      timer: undefined as ReturnType<typeof setInterval> | undefined,
    };
    d.timer = setInterval(() => {
      const now = performance.now();
      const delay = Math.max(0, now - d.last - 20);
      d.last = now;
      d.count++;
      d.maxDelayMs = Math.max(d.maxDelayMs, delay);
      d.totalDelayMs += delay;
    }, 20);
    Reflect.set(globalThis, "scopeMeasureDelay", d);
  });
  results.idle = await sample(app, 5000);
  let id = "";
  const open = async () => {
    await page.locator("#functions summary").click();
    await page.locator('[data-tool="review"]').click();
    await page.locator("#review-address").fill("example/shop #148");
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await page.waitForSelector(".review-code-row");
    await page.locator("#review-chat-toggle").click();
    id = "";
  };
  const send = async (text: string) => {
    if (id) {
      await page.evaluate(
        ({ id, text }) =>
          window.scope.conversation({ action: "send", review: id, text, lens: "Overview" }),
        { id, text },
      );
      return;
    }
    await page.locator("#conversation-input").fill(text);
    await page.locator("#conversation-send").click();
    for (let i = 0; i < 300; i++) {
      id = await app.evaluate(() => Reflect.get(globalThis, "scopeReviewSession")?.reviewId ?? "");
      if (id) break;
      await wait(10);
    }
  };
  const ready = async () => {
    for (let i = 0; i < 300; i++) {
      const r = await page.evaluate(
        (id) => window.scope.conversation({ action: "read", review: id, offset: 256 }),
        id,
      );
      if (!["idle", "starting", "running"].includes(r!.status)) return r;
      await wait(10);
    }
    throw Error("Fixture turn timed out.");
  };
  const end = async () => {
    await page.locator("#review-more").click();
    await page.getByRole("menuitem", { name: "End review", exact: true }).click();
    await page
      .locator("#review-dialog")
      .getByRole("button", { name: "End review", exact: true })
      .click();
    await page.waitForSelector("#review-address", { state: "visible" });
  };
  await open();
  await send("slow prompt editing");
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="settings"]').click();
  await page.locator("#settings-prompts").click();
  await page.evaluate(() => window.scope.capture(true));
  let maxEditMs = 0;
  results.promptEditing = await sample(app, 0, async () => {
    for (const promptId of PROMPT_IDS) {
      await page.locator("#prompt-select").click();
      await page
        .getByRole("menuitem", { name: REVIEW_PROMPTS[promptId].label, exact: true })
        .click();
      const start = performance.now();
      await page.locator("#prompt-text").fill("é".repeat(4096));
      await page.locator("#prompt-save").click();
      await page.waitForFunction(
        () => document.querySelector("#prompt-modified")?.textContent === "Modified",
      );
      maxEditMs = Math.max(maxEditMs, performance.now() - start);
      await page.locator("#prompt-text").fill("界".repeat(8192));
      server.event(fixtureEvent);
    }
    for (let i = 0; i < 40; i++) {
      await page.locator("#prompt-text").fill("a" + "\t".repeat(8191));
      await page.locator("#prompt-cancel").click();
      server.event(fixtureEvent);
    }
  });
  results.promptIdleWithReview = await sample(app, 5000);
  results.promptBounds = {
    maxEditSaveMs: maxEditMs,
    fileBytes: (await stat(root + "/review-prompts.json")).size,
    overrides: 7,
    bytesPerPrompt: 8192,
    maxDraftBytes: 24576,
  };
  await page.evaluate((id) => window.scope.conversation({ action: "stop", review: id }), id);
  await ready();
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="review"]').click();
  results.longConversation = await sample(app, 0, async () => {
    for (let i = 0; i < 110; i++) {
      await send(`Review question ${i}`);
      assert.equal((await ready())!.status, "ready");
    }
  });
  results.longState = await page
    .evaluate((id) => window.scope.conversation({ action: "read", review: id, offset: 0 }), id)
    .then((r) => ({ total: r!.total, visible: r!.entries.length, status: r!.status }));
  await page.evaluate(() => window.scope.capture(true));
  await wait(500);
  await send("slow");
  results.captureAndReview = await sample(app, 0, async () => {
    for (let i = 0; i < 500; i++) {
      server.event(fixtureEvent);
      await wait(10);
    }
  });
  results.diagnosisBusy = await page.evaluate(async () => {
    const s = await window.scope.status();
    try {
      await window.scope.analysisStart(s.generation, "session-a", "test-success", "low", null);
      return await window.scope.analysisList(s.generation);
    } catch (error) {
      return { error: String(error) };
    }
  });
  assert.match(JSON.stringify(results.diagnosisBusy), /End review/);
  const stopStart = performance.now();
  await page.evaluate((id) => window.scope.conversation({ action: "stop", review: id }), id);
  await ready();
  results.stopMs = performance.now() - stopStart;
  results.sessionDiskBytes = await bytes(root + "/review-session");
  await end();
  await writeFile(root + "/review-control.json", JSON.stringify({ mode: "bounded-source" }));
  await open();
  results.largeTool = await sample(app, 0, async () => {
    await send("large-source");
    assert.equal((await ready())!.status, "ready");
  });
  results.toolState = await page
    .evaluate((id) => window.scope.conversation({ action: "read", review: id, offset: 256 }), id)
    .then((r) => ({
      total: r!.total,
      bytes: r!.entries.reduce((n, e) => n + e.text.length, 0),
      omissions: r!.entries.some((e) => e.text.includes("omitted")),
    }));
  await end();
  await open();
  results.burstCapacity = await sample(app, 0, async () => {
    await send("capacity");
    assert.equal((await ready())!.status, "capacity");
  });
  results.capacity = await page
    .evaluate((id) => window.scope.conversation({ action: "read", review: id, offset: 256 }), id)
    .then((r) => ({
      status: r!.status,
      bytes: r!.entries.reduce((n, e) => n + e.text.length, 0),
      error: r!.error,
    }));
  results.rendererLongTasks = await page.evaluate(() =>
    Reflect.get(window, "scopeMeasureLongTasks"),
  );
  results.mainEventLoopTimerDelay = await app.evaluate(() => {
    const d = Reflect.get(globalThis, "scopeMeasureDelay");
    clearInterval(d.timer);
    return { count: d.count, maxDelayMs: d.maxDelayMs, meanDelayMs: d.totalDelayMs / d.count };
  });
  const quit = performance.now();
  await app.close();
  results.quitMs = performance.now() - quit;
  results.remaining = await readdir(root + "/review-session");
  assert.deepEqual(results.remaining, []);
  await mkdir("measurements", { recursive: true });
  await writeFile("measurements/review-session.json", JSON.stringify(results, null, 2));
} finally {
  await app.close().catch(() => {});
  await server.close();
  await rm(root, { recursive: true, force: true });
}
