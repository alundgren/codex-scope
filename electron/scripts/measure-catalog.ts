import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { sample, bytes } from "./process-metrics.ts";
const real = process.argv.includes("--real");
const root = await mkdtemp("/tmp/scope-catalog-measure-");
const control = path.join(root, "catalog-mode");
await writeFile(control, "success");
const app = await _electron.launch({
  args: [
    path.resolve("dist/app"),
    "--history-test",
    `--scope-test-root=${root}`,
    ...(real ? [] : [`--catalog-test-cli=${path.resolve("test/fixtures/catalog-cli.cjs")}`]),
  ],
  env: { ...process.env, SCOPE_CATALOG_FIXTURE_CONTROL: control },
  chromiumSandbox: true,
});
const child = app.process();
try {
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  const directory = path.join(root, "catalog");
  async function measure(action: () => Promise<unknown>) {
    let temporaryPeakBytes = 0,
      frameSamples = 0,
      maxFrameResponseMs = 0;
    let reading: Promise<void> | undefined, probing: Promise<void> | undefined, failure: unknown;
    const timer = setInterval(() => {
      if (reading) return;
      reading = bytes(directory)
        .then(
          (value) => {
            temporaryPeakBytes = Math.max(temporaryPeakBytes, value);
          },
          (error) => {
            if (error.code !== "ENOENT") failure = error;
          },
        )
        .finally(() => {
          reading = undefined;
        });
    }, 250);
    const probe = setInterval(() => {
      if (probing) return;
      const started = performance.now();
      probing = page
        .evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
        .then(
          () => {
            frameSamples++;
            maxFrameResponseMs = Math.max(maxFrameResponseMs, performance.now() - started);
          },
          (error) => {
            failure = error;
          },
        )
        .finally(() => {
          probing = undefined;
        });
    }, 100);
    let resources;
    try {
      resources = await sample(app, 0, action);
    } finally {
      clearInterval(timer);
      clearInterval(probe);
      await reading;
      await probing;
    }
    if (failure) throw failure;
    return { ...resources, temporaryPeakBytes, frameSamples, maxFrameResponseMs };
  }
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const refreshButton = page.locator("#model-refresh");
  const status = page.locator("#model-status");
  async function refresh(expected: string | RegExp = /\d+ models?\./) {
    await refreshButton.click();
    await expect(status).toContainText(expected);
    await expect(refreshButton).toBeEnabled();
  }
  async function choose(model: string, effort: string) {
    const started = performance.now();
    await page.locator("#analysis-model").selectOption(model);
    await expect(refreshButton).toBeEnabled();
    await page.locator("#analysis-effort").selectOption(effort);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    return performance.now() - started;
  }
  const idle = await sample(app, 3000);
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="settings"]').click();
  const started = performance.now();
  const discovery = await measure(() => refresh());
  const discoveryMs = performance.now() - started;
  assert.deepEqual(await readdir(directory), []);
  const cases: Record<string, unknown> = {};
  if (real)
    cases.repeated = await measure(async () => {
      for (let i = 0; i < 3; i++) await refresh();
    });
  else {
    await writeFile(control, "maximum");
    let desktopSelectionMs = 0,
      narrowSelectionMs = 0;
    cases.maximum = await measure(async () => {
      await refresh("256 models.");
      await expect(page.locator("#analysis-model option")).toHaveCount(257);
      desktopSelectionMs = await choose(`model-255-${"x".repeat(110)}`, "effort-31");
      await expect(page.locator("#analysis-effort option")).toHaveCount(33);
      await page.setViewportSize({ width: 390, height: 700 });
      narrowSelectionMs = await choose(`model-254-${"x".repeat(110)}`, "effort-30");
      await page.locator("#settings-save").scrollIntoViewIfNeeded();
      await pause(500);
    });
    cases.maximum = { ...(cases.maximum as object), desktopSelectionMs, narrowSelectionMs };
    for (const [mode, error] of [
      ["output", "output limit"],
      ["pages", "incomplete"],
      ["storage", "temporary storage limit"],
    ]) {
      await writeFile(control, mode);
      cases[mode] = await measure(() => refresh(error));
      assert.equal(await bytes(directory), 0);
    }
    await writeFile(control, "slow");
    let cancelMs = 0;
    cases.cancellation = await measure(async () => {
      await refreshButton.click();
      await expect(page.locator("#model-cancel")).toBeVisible();
      await pause(1000);
      const started = performance.now();
      await page.locator("#model-cancel").click();
      await expect(status).toContainText("cancelled");
      await expect(refreshButton).toBeEnabled();
      cancelMs = performance.now() - started;
    });
    cases.cancellation = { ...(cases.cancellation as object), cancelMs };
    await writeFile(control, "success");
    cases.recovery = await measure(async () => {
      await refresh("9 models.");
      await choose("gpt-5.6-luna", "low");
    });
  }
  const settled = await sample(app, 3000);
  const beforeQuitBytes = await bytes(directory);
  assert.equal(beforeQuitBytes, 0);
  const quitStarted = performance.now();
  await app.close();
  const quitMs = performance.now() - quitStarted;
  await mkdir("measurements", { recursive: true });
  await writeFile(
    `measurements/catalog-${real ? "real" : "fixture"}.json`,
    JSON.stringify(
      {
        environment:
          "Linux Xvfb, sandbox and GPU enabled, no recording or concurrent tests; no threads or model turns",
        method:
          "Actual Settings controls; all app process group members and descendants, 250ms /proc sampling; RSS sums shared pages, PSS endpoint; CPU100%=one core; per-case temp bytes sampled250ms; driver request to renderer animation-frame callback sampled100ms, including dispatch delay; idle and settled omit browser probing",
        idle,
        discovery,
        discoveryMs,
        cases,
        settled,
        beforeQuitBytes,
        quitMs,
      },
      null,
      2,
    ),
  );
} finally {
  if (child.exitCode === null) await app.close();
  await rm(root, { recursive: true, force: true });
}
