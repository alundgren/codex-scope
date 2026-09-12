import { _electron } from "@playwright/test";
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
  const idle = await sample(app, 3000);
  let result: unknown;
  let temporaryPeakBytes = 0;
  const directory = path.join(root, "catalog");
  let reading = false;
  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    void bytes(directory)
      .then(
        (value) => {
          temporaryPeakBytes = Math.max(temporaryPeakBytes, value);
        },
        () => {},
      )
      .finally(() => {
        reading = false;
      });
  }, 250);
  let maxFrameGapMs = 0;
  const responsiveness = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const start = performance.now();
          requestAnimationFrame(() => resolve(performance.now() - start));
        }),
    );
  const frames: number[] = [];
  let probing = false;
  const probe = setInterval(() => {
    if (!probing) {
      probing = true;
      void responsiveness()
        .then((value) => frames.push(value))
        .finally(() => {
          probing = false;
        });
    }
  }, 100);
  const started = performance.now();
  const discovery = await sample(app, 0, async () => {
    result = await page.evaluate(() => window.scope.models());
  });
  const discoveryMs = performance.now() - started;
  clearInterval(timer);
  clearInterval(probe);
  maxFrameGapMs = Math.max(0, ...frames);
  assert.equal((result as { complete: boolean }).complete, true);
  assert.deepEqual(await readdir(directory), []);
  const cases: Record<string, unknown> = {};
  if (real)
    cases.repeated = await sample(app, 0, async () => {
      for (let i = 0; i < 3; i++)
        assert.equal((await page.evaluate(() => window.scope.models())).complete, true);
    });
  if (!real) {
    for (const mode of ["maximum", "output", "pages"]) {
      await writeFile(control, mode);
      cases[mode] = await sample(app, 0, async () => {
        result = await page.evaluate(() => window.scope.models());
      });
      assert.equal((result as { complete: boolean }).complete, mode === "maximum");
    }
    await writeFile(control, "slow");
    const pending = page.evaluate(() => window.scope.models());
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const cancelStarted = performance.now();
    await page.evaluate(() => window.scope.cancelModels());
    assert.match((await pending).error ?? "", /cancelled/);
    cases.cancelMs = performance.now() - cancelStarted;
    await writeFile(control, "success");
    assert.equal((await page.evaluate(() => window.scope.models())).complete, true);
  }
  const settled = await sample(app, 3000);
  const beforeQuitBytes = await bytes(directory);
  const quitStarted = performance.now();
  await app.close();
  const quitMs = performance.now() - quitStarted;
  assert.equal(beforeQuitBytes, 0);
  await mkdir("measurements", { recursive: true });
  await writeFile(
    `measurements/catalog-${real ? "real" : "fixture"}.json`,
    JSON.stringify(
      {
        environment:
          "Linux Xvfb, sandbox and GPU enabled, no recording or concurrent tests; no threads or model turns",
        method:
          "All app process group members and descendants, 250ms /proc sampling; RSS sums shared pages, PSS endpoint; CPU100%=one core; frame callback delay sampled every100ms",
        idle,
        discovery,
        discoveryMs,
        maxFrameGapMs,
        temporaryPeakBytes,
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
