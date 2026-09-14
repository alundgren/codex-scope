import { _electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { sample, bytes } from "./process-metrics.ts";
import { fakeCollector, fixtureEvent, wait } from "../test/fake-collector.ts";

const root = await mkdtemp("/tmp/scope-capture-measure-");
const server = await fakeCollector();
await writeFile(root + "/token", "synthetic-test-token", { mode: 0o600 });
await writeFile(
  root + "/connection.json",
  JSON.stringify({ endpoint: server.endpoint, tokenFile: root + "/token" }),
  { mode: 0o600 },
);
const app = await _electron.launch({
  args: [path.resolve("dist/app"), "--history-test", `--scope-test-root=${root}`],
  chromiumSandbox: true,
});
const child = app.process();
try {
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  await wait(1000);
  const idle = await sample(app, 5000);
  const idleState = await page.evaluate(() => window.scope.status());
  assert.equal(idleState.total, 0);
  assert.equal(server.state.requestCount, 0);
  await page.locator("#capture").click();
  await page.waitForFunction(
    () => document.querySelector(".connection")?.textContent === "Connected",
  );
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="journal"]').click();
  const sustained = await sample(app, 0, async () => {
    for (let i = 0; i < 500; i++) {
      server.event(fixtureEvent);
      await wait(10);
    }
  });
  const burst = await sample(app, 0, async () => {
    for (let i = 0; i < 500; i++) server.event(fixtureEvent);
    await wait(1000);
  });
  const beforeStop = await page.evaluate(() => window.scope.status());
  const stopStarted = performance.now();
  await page.locator("#capture").click();
  await page.waitForFunction(
    () => document.querySelector(".connection")?.textContent === "Stopped",
  );
  const stopMs = performance.now() - stopStarted;
  const requests = server.state.requestCount;
  const stopped = await sample(app, 5000);
  const afterStop = await page.evaluate(() => window.scope.status());
  assert.equal(afterStop.total, beforeStop.total);
  assert.equal(server.state.requestCount, requests);
  const retainedDiskBytes = await bytes(root + "/recordings");
  const quitStarted = performance.now();
  await app.close();
  const quitMs = performance.now() - quitStarted;
  const remainingDiskBytes = await bytes(root + "/recordings");
  assert.equal(remainingDiskBytes, 0);
  await mkdir("measurements", { recursive: true });
  await writeFile(
    "measurements/capture.json",
    JSON.stringify(
      {
        environment:
          "Linux Xvfb, sandbox and GPU enabled; no video, screenshots or concurrent tests",
        method:
          "All app process-group members and descendants sampled with /proc at 250 ms; worker memory included in main; RSS sums shared pages, PSS endpoint only; CPU 100% equals one core",
        workload: "5s idle, 500 events at 100/s, 500-event burst, 5s stopped",
        idle,
        sustained,
        burst,
        stopped,
        idleState,
        afterStop,
        retainedDiskBytes,
        remainingDiskBytes,
        stopMs,
        quitMs,
      },
      null,
      2,
    ),
  );
} finally {
  if (child.exitCode === null) await app.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
