import { gzipSync, gunzipSync } from "node:zlib";
import type { MeasurementReport } from "./measurement-types.ts";
import { electronDirectory, dependencyVersions } from "./tools.ts";
import { _electron } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as recording from "../src/recording.ts";
import { sample, bytes } from "./process-metrics.ts";

if (process.platform !== "linux") throw new Error("This measurement uses Linux /proc.");
const output = path.resolve("measurements");
await mkdir(output, { recursive: true });
const targetName = process.argv[2];
if (targetName && !["baseline", "inspector", "capacity"].includes(targetName))
  throw new Error("Expected baseline, inspector or capacity.");

const report: MeasurementReport = {
  generatedAt: new Date().toISOString(),
  environment: {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: os.cpus().map((cpu) => cpu.model),
    totalMemoryBytes: os.totalmem(),
    hostNode: process.version,
    osRelease: await readFile("/etc/os-release", "utf8"),
  },
  method:
    "Fresh Electron processes, OS filesystem caches left warm. Playwright debugger attached, no video or screenshots. /proc process group and descendants, 250 ms between samples. CPU 100% means one core. Summed RSS includes shared pages. Final PSS uses a read-only sudo /proc counter reader when sandboxed processes deny smaps access; null means unavailable. PSS is a final snapshot, not a sampled peak.",
  versions: {},
  startup: {},
  workloads: {},
};
const capacity = await mkdtemp(path.join(os.tmpdir(), "scope-capacity-measure-"));
try {
  await cp("dist/app", capacity, { recursive: true });
  const source = (await readFile("fixtures/journal.jsonl", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const capacityMessages = [
    source[0],
    ...Array.from({ length: 16 }, (_, index) => ({
      ...source[index < 4 ? 4 : 1],
      sequence: index + 1,
    })),
  ];
  await writeFile(
    path.join(capacity, "fixtures/journal.jsonl.gz"),
    gzipSync(capacityMessages.map((value) => JSON.stringify(value)).join("\n") + "\n"),
  );
  const targets = {
    baseline: path.resolve("dist/baseline/main.mjs"),
    inspector: path.resolve("dist/app"),
    capacity,
  };
  for (const [name, target] of Object.entries(targets)) {
    if (targetName && name !== targetName) continue;
    report.startup![name] = [];
    for (let trial = 0; trial < 3; trial++) {
      const started = performance.now();
      const app = await _electron.launch({
        args: [target, "--fixtures-only"],
        chromiumSandbox: true,
      });
      try {
        const page = await app.firstWindow();
        await page.waitForSelector('html[data-ready="true"]');
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        report.startup![name].push(performance.now() - started);
        if (trial === 0) {
          report.versions = await app.evaluate(() => ({
            electron: process.versions.electron,
            chromium: process.versions.chrome,
            node: process.versions.node,
            v8: process.versions.v8,
          }));
          report.gpuFeatures = await app.evaluate(({ app }) => app.getGPUFeatureStatus());
        }
        if (trial !== 2) continue;
        report.workloads[`${name}Idle`] = await sample(app, 6000);
        console.log(`Measured ${name} idle.`);
        if (name === "baseline") continue;
        await page.locator('tr[data-event="4"]').click();
        await page.locator('[data-tab="json"]').click();
        await page.waitForFunction(
          () => document.querySelector<HTMLElement>("#payload")!.dataset.event === "4",
        );
        report.workloads[`${name}MaximumPayload`] = await sample(app, 4000);
        console.log(`Measured ${name} maximum payload.`);
        const latencies: number[] = [];
        report.workloads[`${name}Interactions`] = await sample(app, 0, async () => {
          for (let index = 0; index < 60; index++) {
            const start = performance.now();
            await page.locator("#detail-close").click();
            await page.locator('tr[data-event="4"]').click();
            await page.locator('[data-tab="json"]').click();
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
            latencies.push(performance.now() - start);
            await page.locator("#scrollbar").press(index % 2 ? "End" : "Home");
          }
        });
        report.workloads[`${name}Interactions`].selectionLatencyMs = {
          max: Math.max(...latencies),
          p95: latencies.toSorted((a, b) => a - b)[Math.floor(latencies.length * 0.95)],
          mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
          operations: latencies.length,
        };
        if (name === "inspector") {
          report.clipboardLatencyMs = [];
          for (let index = 0; index < 20; index++) {
            const start = performance.now();
            const ok = await page.evaluate(() => window.scope.copyPayload(1, 4));
            if (!ok) throw new Error("Clipboard measurement failed.");
            report.clipboardLatencyMs!.push(performance.now() - start);
          }
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
          report.workloads.inspectorHidden = await sample(app, 6000);
        }
      } finally {
        await app.close();
      }
      console.log(`Measured ${name}.`);
    }
  }
  report.appBytes = await bytes("dist/app");
  report.runtimeBytes = await bytes(electronDirectory);
  report.inventory = dependencyVersions();
  const fixtureBytes = await readFile("fixtures/journal.jsonl");
  const capacityBytes = gunzipSync(
    await readFile(path.join(capacity, "fixtures/journal.jsonl.gz")),
  );
  report.recordings = {};
  for (const [name, buffer] of [
    ["default", fixtureBytes],
    ["capacity", capacityBytes],
  ] as const) {
    const times = [];
    for (let index = 0; index < 100; index++) {
      const start = performance.now();
      recording.parseRecording(buffer);
      times.push(performance.now() - start);
    }
    const data = recording.parseRecording(buffer);
    report.recordings![name] = {
      events: data.events.length,
      payloadBytes: data.payloadBytes,
      sourceBytes: buffer.length,
      parseMs: { max: Math.max(...times), p95: times.toSorted((a, b) => a - b)[95] },
    };
  }
  const filename = targetName ? `${targetName}.json` : "linux.json";
  await writeFile(path.join(output, filename), JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote measurements/${filename}`);
} finally {
  await rm(capacity, { recursive: true, force: true });
}
