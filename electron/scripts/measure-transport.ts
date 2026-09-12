import type { MeasurementReport } from "./measurement-types.ts";
import { electronDirectory } from "./tools.ts";
import { _electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { sample, bytes } from "./process-metrics.ts";
import { fakeCollector, wait } from "../test/fake-collector.ts";
await mkdir("measurements", { recursive: true });
const root = await mkdtemp("/tmp/scope-transport-measure-");
const server = await fakeCollector();
const fixture = (await readFile("fixtures/journal.jsonl", "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
await writeFile(root + "/token", "synthetic-test-token", { mode: 0o600 });
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
});
const page = await app.firstWindow();
const report: MeasurementReport = {
  date: new Date().toISOString(),
  environment: {
    platform: os.platform(),
    release: os.release(),
    cpus: os.cpus().map((cpu) => cpu.model),
  },
  method:
    "Actual Electron/Xvfb, no recording or concurrent tests. All Electron process-group members and descendants sampled at 250 ms. SQLite/transport worker is included within main RSS. Summed RSS double-counts shared pages; final PSS is an aggregate endpoint snapshot. CPU 100% is one core. Fake collector, driver, sampler are excluded.",
  workloads: {},
};
const state = () => app.evaluate(() => globalThis.scopeHistory.snapshot());
const fault = (faults: import("../src/types.ts").Faults) =>
  app.evaluate((_electron, faults) => globalThis.scopeHistory.call("test", { faults }), faults);
async function feed(count: number, interval: number, frame = fixture[1]) {
  for (let index = 0; index < count; index++) {
    server.event(frame);
    if (interval) await wait(interval);
  }
}
async function record(name: string, action: () => Promise<unknown>) {
  report.workloads[name] = await sample(app, 0, action);
  report.workloads[name].history = await state();
  report.workloads[name].maximumMainDelayMs = await app.evaluate(() => {
    const value = globalThis.transportMainDelay;
    globalThis.transportMainDelay = 0;
    return value;
  });
  report.workloads[name].maximumRendererDelayMs = await page.evaluate(() => {
    const value = globalThis.transportRendererDelay;
    globalThis.transportRendererDelay = 0;
    return value;
  });
  await writeFile("measurements/transport.partial.json", JSON.stringify(report, null, 2) + "\n");
  console.log(`Measured ${name}.`);
}
try {
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>(".connection")!.textContent === "Connected",
  );
  report.versions = await app.evaluate(() => ({
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: process.versions.sqlite,
  }));
  await app.evaluate(() => {
    globalThis.transportMainDelay = 0;
    let last = performance.now();
    globalThis.transportMainTimer = setInterval(() => {
      const now = performance.now();
      globalThis.transportMainDelay = Math.max(globalThis.transportMainDelay, now - last - 20);
      last = now;
    }, 20);
  });
  await page.evaluate(() => {
    globalThis.transportRendererDelay = 0;
    let last = performance.now();
    globalThis.transportRendererTimer = setInterval(() => {
      const now = performance.now();
      globalThis.transportRendererDelay = Math.max(
        globalThis.transportRendererDelay,
        now - last - 20,
      );
      last = now;
    }, 20);
  });
  await record("connectedIdle", () => wait(4000));
  await record("sustained1800", () => feed(1800, 6));
  await record("maximumPayload240", () => feed(240, 65, fixture[4]));
  await page.locator("#scrubber").press("ArrowUp");
  await page.locator("#scrollbar").press("PageDown");
  const selected = await page.locator("#payload").getAttribute("data-event"),
    offset = await page.locator("#payload").evaluate((node) => node.scrollTop);
  await fault({ transportDelay: 100 });
  await record("delayedStorage", async () => {
    await feed(250, 8);
    await wait(2100);
    await fault({ transportDelay: 0 });
    await wait(1000);
  });
  assert.equal(await page.locator("#payload").getAttribute("data-event"), selected);
  assert.equal(await page.locator("#payload").evaluate((node) => node.scrollTop), offset);
  await record("burst2000", async () => {
    await feed(2000, 0);
    await wait(3000);
  });
  await fault({ transportDelay: 6500 });
  await record("stalledStorage", async () => {
    server.event();
    await wait(4500);
    const beats = server.state.heartbeats;
    await wait(1500);
    assert.equal(server.state.heartbeats, beats);
    await fault({ transportDelay: 0 });
    await wait(2500);
  });
  await record("recoveredCapture", () => feed(600, 6));
  await page.evaluate(() => clearInterval(globalThis.transportRendererTimer));
  await app.evaluate(() => clearInterval(globalThis.transportMainTimer));
  report.workloads.settledIdle = await sample(app, 5000);
  console.log("Measured settled idle.");
  report.final = await app.evaluate(async () => {
    const result = await globalThis.scopeHistory.call("test", { faults: {} });
    if (!("ok" in result) || !result.ok) throw new Error("Worker diagnostics unavailable.");
    return result;
  });
  delete report.final!.directory;
  report.server = {
    offered: 1800 + 240 + 250 + 2000 + 1 + 600,
    bytesWritten: server.state.written,
    refused: server.state.refused,
    requests: server.state.requestCount,
    heartbeats: server.state.heartbeats,
    peakSockets: server.state.peakSockets,
  };
  report.appBytes = await bytes("dist/app");
  report.runtimeBytes = await bytes(electronDirectory);
  assert(report.final!.retainedBytes! <= 8 * 1024 * 1024);
  assert(report.final!.transport!.metrics!.peakFrameBytes <= 393216);
} finally {
  console.log("Closing measurement app.");
  await app.close();
  await server.close();
  console.log("Measurement app closed.");
}
await mkdir("measurements", { recursive: true });
await writeFile("measurements/transport-linux.json", JSON.stringify(report, null, 2) + "\n");
console.log("Wrote measurements/transport-linux.json");
