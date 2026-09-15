import type { MeasurementReport } from "./measurement-types.ts";
import { electronDirectory } from "./tools.ts";
import { _electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sample, bytes } from "./process-metrics.ts";

const root = await mkdtemp("/tmp/scope-history-measure-");
await mkdir("measurements", { recursive: true });
const source = (await readFile("fixtures/journal.jsonl", "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const started = performance.now();
const app = await _electron.launch({
  args: [
    path.resolve("dist/app"),
    "--history-test",
    "--fixtures-only",
    `--scope-test-root=${root}`,
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
    memory: os.totalmem(),
  },
  method:
    "Actual Electron under Xvfb, no screenshots or recording. Sample all process-group members and descendants at 250 ms. Summed RSS includes shared pages; final PSS is a single aggregate snapshot. CPU 100% is one core. Workloads include test-driver serialization in main. Disk samples include the live rollback journal before commit.",
  workloads: {},
};
try {
  await page.waitForSelector('html[data-ready="true"]');
  report.startupMs = performance.now() - started;
  report.versions = await app.evaluate(() => ({
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: process.versions.sqlite,
    chrome: process.versions.chrome,
  }));
  await app.evaluate(() => {
    globalThis.measureSequence = 100;
    globalThis.mainDelay = 0;
    let last = performance.now();
    globalThis.delayTimer = setInterval(() => {
      const now = performance.now();
      globalThis.mainDelay = Math.max(globalThis.mainDelay, now - last - 20);
      last = now;
    }, 20);
  });
  const status = () => app.evaluate(() => globalThis.scopeHistory.snapshot());
  async function feed(count: number, template: number, batch: number, delay: number) {
    await app.evaluate(
      async (_electron, { count, message, batch, delay }) => {
        const history = globalThis.scopeHistory;
        for (let index = 0; index < count;) {
          for (let sent = 0; sent < batch && index < count; sent++, index++)
            history.append(
              history.generation,
              history.status.connectionId,
              JSON.stringify({
                ...message,
                connection_id: history.status.connectionId,
                sequence: globalThis.measureSequence++,
              }),
            );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const deadline = performance.now() + 5000;
        while (history.sending && performance.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
      },
      { count, message: source[template], batch, delay },
    );
  }
  async function workload(
    name: string,
    count: number,
    template: number,
    batch: number,
    delay: number,
  ) {
    report.workloads[name] = await sample(app, 0, () => feed(count, template, batch, delay));
    report.workloads[name].input = {
      count,
      payloadBytes: source[template].payload_bytes,
      batch,
      delayMs: delay,
    };
    report.workloads[name].history = await status();
    report.workloads[name].maximumMainTimerDelayMs = await app.evaluate(() => {
      const value = globalThis.mainDelay;
      globalThis.mainDelay = 0;
      return value;
    });
    console.log(`Measured ${name}.`);
  }
  report.workloads.idle = await sample(app, 4000);
  await page.locator('tr[data-event="4"]').click();
  await page.locator("#scrollbar").press("PageDown");
  await workload("sustainedSmall", 16000, 1, 16, 50);
  await workload("sustainedMaximum", 1200, 4, 4, 40);
  await workload("repeatedMaximum", 1200, 4, 4, 40);
  await workload("extendedMaximum", 2400, 4, 4, 40);
  await workload("longMaximum", 4800, 4, 4, 40);
  await workload("burstMaximum", 1000, 4, 100, 100);
  const times = [];
  for (let index = 0; index < 30; index++) {
    const value = await status();
    const start = performance.now();
    await page.evaluate(async ({ generation, id }) => window.scope.inspect(generation, id, 5), {
      generation: value.generation,
      id: value.first!.id + index,
    });
    times.push(performance.now() - start);
  }
  report.inspectionMs = {
    maximum: Math.max(...times),
    p95: times.toSorted((a, b) => a - b)[28],
    operations: times.length,
  };
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await workload("hiddenCapture", 400, 4, 4, 40);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  report.workloads.settledIdle = await sample(app, 8000);
  report.appBytes = await bytes("dist/app");
  report.runtimeBytes = await bytes(electronDirectory);
  report.final = await app.evaluate(async () => {
    const result = await globalThis.scopeHistory.call("test", { faults: {} });
    if (!("ok" in result) || !result.ok) throw new Error("Worker diagnostics unavailable.");
    return result;
  });
  delete report.final!.directory;
  await app.evaluate(() => clearInterval(globalThis.delayTimer));
} finally {
  await app.close();
}
await writeFile("measurements/history-linux.json", JSON.stringify(report, null, 2) + "\n");
console.log("Wrote measurements/history-linux.json");
