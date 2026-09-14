import { _electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { sample, bytes } from "./process-metrics.ts";
import { wait, fakeCollector, fixtureEvent } from "../test/fake-collector.ts";
const root = await mkdtemp("/tmp/scope-review-live-");
const server = await fakeCollector();
const app = await _electron.launch({
  args: [path.resolve("dist/app"), "--history-test", `--scope-test-root=${root}`],
  chromiumSandbox: true,
});
const result: Record<string, unknown> = {
  environment:
    "Linux Xvfb sandbox/GPU enabled, actual installed Codex CLI and gh, gpt-6-astra low, public pinned PR42, no video/screenshots.",
};
try {
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  await page.evaluate(
    (endpoint) =>
      window.scope.saveSettings({
        endpoint,
        token: "synthetic-test-token",
        diagnosis: { model: "gpt-6-astra", effort: "low" },
        review: { model: "gpt-6-astra", effort: "low" },
      }),
    server.endpoint,
  );
  result.idle = await sample(app, 5000);
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="review"]').click();
  await page.locator("#review-address").fill("alundgren/codex-scope #42");
  await page.getByRole("button", { name: "Open PR", exact: true }).click();
  await page.waitForSelector(".review-code-row");
  await page.locator("#review-chat-toggle").click();
  const ready = async () => {
    for (let i = 0; i < 2400; i++) {
      const state = await app.evaluate(() =>
        Reflect.get(globalThis, "scopeReviewSession")?.read(256),
      );
      if (state && !["idle", "starting", "running"].includes(state.status)) {
        assert.equal(state.status, "ready", state.error);
        return;
      }
      await wait(50);
    }
    throw Error("Live turn deadline");
  };
  result.firstTurn = await sample(app, 0, async () => {
    await page
      .locator("#conversation-input")
      .fill(
        "List root with scope_evidence, then read one small regular source file by ID. State one concrete fact from it in two sentences.",
      );
    await page.locator("#conversation-send").click();
    await ready();
  });
  result.openIdle = await sample(app, 5000);
  await page.evaluate(() => window.scope.capture(true));
  await wait(500);
  result.captureAndSecondTurn = await sample(app, 0, async () => {
    await page
      .locator("#conversation-input")
      .fill(
        "Security lens. Explain one uncertainty in the source you read, using only existing evidence.",
      );
    await page.locator("#conversation-send").click();
    for (let i = 0; i < 500; i++) {
      server.event(fixtureEvent);
      await wait(10);
    }
    await ready();
  });
  result.session = await app.evaluate(() => {
    const s = Reflect.get(globalThis, "scopeReviewSession");
    const r = s.read(256);
    return { selection: r.selection, status: r.status, entries: r.total, toolCalls: s.calls.size };
  });
  result.tempBytes = await bytes(root + "/review-session");
  const started = performance.now();
  await app.close();
  result.quitMs = performance.now() - started;
  result.remaining = await readdir(root + "/review-session");
  assert.deepEqual(result.remaining, []);
  await mkdir("measurements", { recursive: true });
  await writeFile("measurements/review-live.json", JSON.stringify(result, null, 2));
} finally {
  await app.close().catch(() => {});
  await server.close();
  await rm(root, { recursive: true, force: true });
}
