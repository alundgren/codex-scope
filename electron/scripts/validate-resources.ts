import type { RegressionReport, TrialReport } from "./measurement-types.ts";
import type { Faults } from "../src/types.ts";
import type { Page, ElectronApplication } from "@playwright/test";
import { electronDirectory, dependencyVersions } from "./tools.ts";
import { _electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { sample, bytes } from "./process-metrics.ts";
import { completed, interactions, rapidScrub } from "./interaction-metrics.ts";
import { fakeCollector, wait } from "../test/fake-collector.ts";
import { frame } from "../test/navigation-helpers.ts";
import { evaluateReport } from "./resource-thresholds.ts";

assert.equal(process.platform, "linux", "Resource validation requires Linux /proc.");
const arguments_ = process.argv.slice(2);
assert(
  arguments_.every((value) => /^--runs=\d+$/.test(value) || value === "--calibrate"),
  "Expected --runs=N or --calibrate.",
);
const runs = Number(arguments_.find((value) => value.startsWith("--runs="))?.slice(7) ?? 3);
assert(Number.isInteger(runs) && runs >= 1 && runs <= 10, "Use one to ten trials.");
const calibrate = arguments_.includes("--calibrate");
const output = path.resolve("measurements/regression");
await mkdir(output, { recursive: true });
const source = (await readFile("fixtures/journal.jsonl", "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const report: RegressionReport = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: calibrate ? "calibration" : "regression",
  completed: false,
  environment: {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    osRelease: await readFile("/etc/os-release", "utf8"),
    cpus: os.cpus().map((cpu) => cpu.model),
    totalMemoryBytes: os.totalmem(),
    availableMemory: await readFile("/proc/meminfo", "utf8").then(
      (text) => text.match(/^MemAvailable:.*$/m)?.[0],
    ),
    hostNode: process.version,
    bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
    display:
      "Xvfb 1600x1000x24 with isolated Openbox; 1180x760 content; software GPU enabled; warm filesystem caches",
    windowManager: execFileSync("openbox", ["--version"], { encoding: "utf8" }).split("\n")[0],
  },
  method: {
    intervalMs: 250,
    sampling: "250 ms waits plus reader overhead; elapsed sample times drive CPU calculations.",
    memory:
      "All Electron process-group members and descendants. Worker threads are included in their owner. RSS sums shared pages repeatedly; steady RSS is the median of the final third of samples. PSS apportions shared pages and is an endpoint snapshot, never a peak.",
    cpu: "User + system /proc ticks divided by elapsed monotonic time. 100% equals one core. Short-lived children between samples can be missed.",
    excluded:
      "Xvfb, Openbox, Node driver, fake collector and metric reader. No video, screenshots, tests or concurrent app workloads.",
    latency:
      "Monotonic driver input start through completed journal aria-busy=false, matching selected row/payload/slider, successful result, and following animation frame. Search includes 180 ms debounce. Startup includes launch, connection readiness and two animation frames.",
    disk: "Worker maximum of all recording files inside transactions includes rollback journal, sidecars and owner marker. SQLite temp_store=MEMORY; 8 MiB SQLite heap includes its temporary work. Independent endpoint scan verifies disk totals.",
    completion:
      "Phase completion queries current worker transport processing and response-buffer diagnostics; coalesced UI notifications are not a worker completion signal.",
    faults:
      "Debugger-only bounded delays and SQLite read-only/page-limit errors; simulated free-space/cleanup failure. No private configuration or collector process.",
  },
  trials: [],
};
const checkpoint = () =>
  writeFile(path.join(output, "report.partial.json"), JSON.stringify(report, null, 2) + "\n");
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    report.interruption = signal;
    writeFileSync(path.join(output, "report.partial.json"), JSON.stringify(report, null, 2) + "\n");
    process.exit(signal === "SIGTERM" ? 143 : 130);
  });

async function launch(root: string, baseline = false) {
  await mkdir(root, { recursive: true });
  const started = performance.now();
  const app = await _electron.launch({
    args: baseline
      ? [path.resolve("dist/baseline/main.mjs"), `--scope-test-root=${root}`]
      : [
          path.resolve("dist/app"),
          "--history-test",
          `--scope-test-root=${root}`,
          `--connection-config=${root}/connection.json`,
        ],
    chromiumSandbox: true,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('html[data-ready="true"]');
    if (!baseline)
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>(".connection")!.textContent === "Connected",
      );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    return { app, page, startupMs: performance.now() - started };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function trial(index: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scope-regression-"));
  const result: TrialReport = { index, baseline: {}, workloads: {}, assertions: [] };
  report.trials.push(result);
  let app: ElectronApplication | null = null;
  let page: Page;
  let server: Awaited<ReturnType<typeof fakeCollector>> | undefined;
  const state = () =>
    app!.evaluate(async () => {
      const history = globalThis.scopeHistory,
        main = history.snapshot();
      const current = await history.call("test", { faults: {} });
      if (!("ok" in current) || !current.ok)
        throw new Error("Current worker diagnostics are unavailable.");
      const { directory: _directory, limits: _limits, ok: _ok, ...diagnostics } = current;
      return { ...main, ...diagnostics };
    });
  const fault = (faults: Faults) =>
    app!.evaluate(async (_electron, faults) => {
      const result = await globalThis.scopeHistory.call("test", { faults });
      if (!("ok" in result) || !result.ok) throw new Error("Worker diagnostics unavailable.");
      return result;
    }, faults);
  const assertThat = (value: unknown, label: string) => {
    assert(value, label);
    result.assertions.push(label);
  };
  async function settle() {
    const deadline = performance.now() + 8000;
    while (true) {
      const current = await state();
      if (
        !current.queuedCount &&
        !current.pendingRequests &&
        !current.transport!.processing &&
        !current.transportBufferedBytes
      )
        return current;
      assert(performance.now() < deadline, "Pending input must drain within eight seconds.");
      await wait(25);
    }
  }
  async function feed(
    count: number,
    intervalMs: number,
    template: Record<string, unknown> | null = null,
  ) {
    const started = performance.now(),
      beforeBytes = server!.state.written,
      beforeRefused = server!.state.refused;
    for (let cursor = 0; cursor < count; cursor++) {
      server!.event(
        template ??
          frame({
            session: `session-${cursor % 40}`,
            message: "population synthetic input",
            tail: `${"x".repeat(60)} literal [a.*]%_ ${cursor % 2 ? "odd" : "even"}`,
            index: cursor,
          }),
      );
      if (intervalMs) await wait(intervalMs);
    }
    await wait(100);
    await settle();
    return {
      offered: count,
      intervalMs,
      durationMs: performance.now() - started,
      bytesWritten: server!.state.written - beforeBytes,
      serverRefused: server!.state.refused - beforeRefused,
      maximumPayloadBytes: template?.payload_bytes ?? null,
    };
  }
  async function record(name: string, action: () => Promise<unknown>, { timer = true } = {}) {
    result.activePhase = name;
    await checkpoint();
    if (timer) {
      await app!.evaluate(() => {
        globalThis.regressionDelay = 0;
        let at = performance.now();
        globalThis.regressionTimer = setInterval(() => {
          const now = performance.now();
          globalThis.regressionDelay = Math.max(globalThis.regressionDelay, now - at - 20);
          at = now;
        }, 20);
      });
      await page.evaluate(() => {
        globalThis.regressionDelay = 0;
        let at = performance.now();
        globalThis.regressionTimer = setInterval(() => {
          const now = performance.now();
          globalThis.regressionDelay = Math.max(globalThis.regressionDelay, now - at - 20);
          at = now;
        }, 20);
      });
    }
    let workload;
    try {
      result.workloads[name] = await sample(app!, 0, async () => {
        workload = await action();
      });
    } catch (error) {
      result.failedState = await state();
      result.failedView = await page.evaluate(() => ({
        busy: document.querySelector<HTMLElement>("#entries")!.getAttribute("aria-busy"),
        payloadId: document.querySelector<HTMLElement>("#payload")!.dataset.event,
        selectedRowId: document.querySelector<HTMLElement>('.event[aria-pressed="true"]')?.dataset
          .event,
        position: document.querySelector<HTMLElement>("#scrubber")!.getAttribute("aria-valuenow"),
        notice: document.querySelector<HTMLElement>("#notice")!.textContent,
      }));
      throw error;
    } finally {
      if (timer) {
        const main = await app!.evaluate(() => {
          clearInterval(globalThis.regressionTimer);
          return globalThis.regressionDelay;
        });
        const renderer = await page.evaluate(() => {
          clearInterval(globalThis.regressionTimer);
          return globalThis.regressionDelay;
        });
        if (result.workloads[name])
          Object.assign(result.workloads[name], {
            maximumMainDelayMs: main,
            maximumRendererDelayMs: renderer,
          });
      }
    }
    const history = await state();
    Object.assign(result.workloads[name], {
      history,
      workload,
      diskBytesAtEnd: await bytes(path.join(root, "recordings")),
    });
    assert(
      (history.retainedBytes ?? 0) <= 8 * 1024 * 1024 &&
        history.total <= 10000 &&
        Number(history.maximumDiskBytes) <= 33 * 1024 * 1024,
    );
    assert(
      history.peakQueueCount <= 32 &&
        history.peakQueueBytes <= 1024 * 1024 &&
        history.peakPending <= 4,
    );
    assert(
      (history.transport!.metrics?.peakProcessing ?? 0) <= 1 &&
        (history.transport!.metrics?.peakFrameBytes ?? 0) <= 393216,
    );
    await checkpoint();
    console.log(`Trial ${index}: ${name} complete.`);
    delete result.activePhase;
  }
  try {
    ({
      app,
      page,
      startupMs: result.baseline.startupMs,
    } = await launch(path.join(root, "baseline"), true));
    result.baseline.idle = await sample(app!, 4000);
    report.versions = await app!.evaluate(() => ({
      electron: process.versions.electron,
      node: process.versions.node,
      sqlite: process.versions.sqlite,
      chromium: process.versions.chrome,
      v8: process.versions.v8,
    }));
    report.gpuFeatures = await app!.evaluate(({ app }) => app.getGPUFeatureStatus());
    await app.close();
    app = null;
    await checkpoint();
    server = await fakeCollector();
    await writeFile(path.join(root, "token"), "synthetic-test-token", { mode: 0o600 });
    await writeFile(
      path.join(root, "connection.json"),
      JSON.stringify({ endpoint: server.endpoint, tokenFile: path.join(root, "token") }),
      { mode: 0o600 },
    );
    ({ app, page, startupMs: result.startupMs } = await launch(root));
    const configuration = await fault({});
    result.limits = configuration.limits;
    await record("connectedIdle", () => wait(4000), { timer: false });
    for (const message of source.slice(1)) {
      server!.event(message);
      await wait(65);
    }
    await settle();
    await page.locator('button[data-event="4"]').click();
    await page.locator("#scrollbar").press("PageDown");
    const held = await page.locator("#payload").evaluate((node) => ({
      id: node.dataset.event,
      offset: node.scrollTop,
      text: node.textContent,
    }));
    const rows = await page.locator("#entries").innerText();
    assertThat(held.offset > 0, "Held payload starts at a nonzero offset.");
    await record("heldCapture", () => feed(120, 8));
    assertThat(
      JSON.stringify(
        await page.locator("#payload").evaluate((node) => ({
          id: node.dataset.event,
          offset: node.scrollTop,
          text: node.textContent,
        })),
      ) === JSON.stringify(held) && (await page.locator("#entries").innerText()) === rows,
      "Arrivals preserve held selected payload, neighboring rows and nonzero offset.",
    );
    await record("capture1000", () => feed(1000, 6));
    await record("navigate1000", () => interactions(page, state));
    await record("captureToRowLimit", () => feed(9400, 6));
    assertThat(
      (await state()).total === 10000,
      "Small input reaches the retained row cap and evicts old rows.",
    );
    await record("navigateRowLimit", () => interactions(page, state));
    await record("captureAndRapidInput", async () => {
      const intake = feed(300, 10);
      for (const text of ["odd", "even", "literal", "missing", ""])
        await page.locator("#search").fill(text);
      await completed(page);
      await rapidScrub(page);
      return await intake;
    });
    for (let cycle = 1; cycle <= 3; cycle++)
      await record(`maximumCycle${cycle}`, () => feed(300, 65, source[4]));
    const cycles = [1, 2, 3].map((number) => result.workloads[`maximumCycle${number}`].history);
    assertThat(
      cycles.every((value) => value!.retainedBytes! > 7 * 1024 * 1024) &&
        cycles[2]!.evicted! > cycles[1]!.evicted! &&
        cycles[1]!.evicted! > cycles[0]!.evicted!,
      "Three maximum-payload cycles remain bounded while eviction continues.",
    );
    await record("navigateMaximum", () => interactions(page, state));
    await page.locator("#scrubber").press("End");
    await completed(page);
    for (const kind of ["hidden", "minimized"]) {
      await app!.evaluate(({ BrowserWindow }, kind) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (kind === "hidden") window.hide();
        else window.minimize();
      }, kind);
      await wait(300);
      const windowState = await app!.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { minimized: window.isMinimized(), visible: window.isVisible() };
      });
      assertThat(
        kind === "minimized" ? windowState.minimized : !windowState.visible,
        `${kind} state is real, with a window-manager acknowledgement.`,
      );
      const countText = await page.locator("#count").textContent(),
        before = (await state()).accepted;
      await page.evaluate(() => {
        globalThis.regressionMutations = 0;
        globalThis.regressionObserver = new MutationObserver((records) => {
          globalThis.regressionMutations += records.length;
        });
        globalThis.regressionObserver.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      });
      await record(`${kind}Capture`, () => feed(250, 12), { timer: false });
      const mutations = await page.evaluate(() => {
        globalThis.regressionObserver.disconnect();
        return globalThis.regressionMutations;
      });
      result.workloads[`${kind}Capture`].presentationMutations = mutations;
      result.workloads[`${kind}Capture`].windowState = windowState;
      result.workloads[`${kind}Capture`].documentVisibility = await page.evaluate(
        () => document.visibilityState,
      );
      assertThat(
        (await state()).accepted > before &&
          (await page.locator("#count").textContent()) === countText &&
          mutations === 0,
        `${kind} capture continues with zero presentation mutations.`,
      );
      await app!.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.restore();
        window.show();
      });
      await wait(400);
      await completed(page);
    }
    const beforeDelayed = (await state()).accepted;
    await fault({ transportDelay: 100 });
    await record("delayedStorage", async () => {
      const load = await feed(60, 8);
      await fault({ transportDelay: 0 });
      return load;
    });
    assertThat(
      (await state()).accepted === beforeDelayed + 60 &&
        result.workloads.delayedStorage.workload!.durationMs! >= 6000,
      "All sixty delayed events finish their storage work before measurement ends.",
    );
    await record("burst", async () => {
      const load = await feed(2000, 0);
      await wait(3500);
      return load;
    });
    assertThat(
      server!.state.refused > 0 || (await state()).transport!.metrics!.rateDisconnects > 0,
      "Over-limit burst drops input instead of accumulating a replay queue.",
    );
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>(".connection")!.textContent === "Connected",
    );
    await fault({ transportDelay: 6500 });
    await record("stalledStorage", async () => {
      server!.event();
      await wait(4500);
      const beats = server!.state.heartbeats;
      await wait(1500);
      assertThat(server!.state.heartbeats === beats, "Stalled processing stops heartbeat renewal.");
      await fault({ transportDelay: 0 });
      await wait(2500);
    });
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>(".connection")!.textContent === "Connected",
    );
    await app!.evaluate(() => globalThis.scopeHistory.clear(globalThis.scopeHistory.generation));
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>(".connection")!.textContent === "Connected",
    );
    await feed(1, 100, source[1]);
    for (const [name, enabled, disabled] of [
      ["readOnly", { queryOnly: true }, { queryOnly: false }],
      ["diskHeadroom", { disk: true }, { disk: false }],
      ["sqliteFull", { diskFull: true }, { diskFull: false }],
    ] as const) {
      const dropped = (await state()).drops.storage ?? 0;
      await fault(enabled);
      await record(name, async () => {
        const load = await feed(12, 65, source[4]);
        await wait(250);
        return load;
      });
      assertThat((await state()).drops.storage > dropped, `${name} failure counts storage drops.`);
      await fault(disabled);
    }
    await record("recoveredCapture", () => feed(200, 8));
    assertThat(!(await state()).pressure, "Storage recovery resumes accepted capture.");
    await record("settledIdle", () => wait(5000), { timer: false });
    await fault({ cleanup: true });
    await record(
      "cleanupFailure",
      async () => {
        const cleared = await app!.evaluate(() =>
          globalThis.scopeHistory.clear(globalThis.scopeHistory.generation),
        );
        assertThat(
          !!cleared.error,
          "Cleanup failure reports remaining files and isolates old history.",
        );
        await wait(500);
      },
      { timer: false },
    );
    await page.waitForFunction(() =>
      document
        .querySelector<HTMLElement>("#notice")!
        .textContent.includes("Temporary recording files remain"),
    );
    await app.close();
    app = null;
    assertThat(
      (await readdir(path.join(root, "recordings"))).length > 0,
      "Failed cleanup leaves an abandoned owned recording for restart.",
    );
    ({ app, page } = await launch(root));
    await record(
      "restartRecovery",
      async () => {
        await feed(20, 12);
        await wait(500);
      },
      { timer: false },
    );
    assertThat(
      (await state()).total === 20,
      "Restart removes abandoned history and accepts only fresh events.",
    );
    const final = await settle();
    assertThat(
      final.queuedCount === 0 &&
        final.pendingRequests === 0 &&
        final.transport!.processing === 0 &&
        final.transportBufferedBytes === 0,
      "Final intake, transport buffer and request queues are empty.",
    );
    result.server = {
      writtenBytes: server!.state.written,
      refused: server!.state.refused,
      requests: server!.state.requestCount,
      heartbeats: server!.state.heartbeats,
      peakSockets: server!.state.peakSockets,
    };
    assertThat(
      server!.state.requests.every((value) =>
        ["/v1/stream", "/v1/heartbeat"].includes(value.path ?? ""),
      ),
      "No replay request is sent.",
    );
    await app.close();
    app = null;
    assertThat(
      (await readdir(path.join(root, "recordings"))).length === 0,
      "Normal close removes all owned recording files.",
    );
    result.complete = true;
  } finally {
    console.log(`Trial ${index}: closing owned app and fake collector.`);
    if (app) await app.close();
    if (server) await server.close();
    await checkpoint();
    await rm(root, { recursive: true, force: true });
    console.log(`Trial ${index}: owned temporary root removed.`);
  }
}

try {
  for (let index = 1; index <= runs; index++) await trial(index);
  report.appBytes = await bytes("dist/app");
  report.runtimeBytes = await bytes(electronDirectory);
  report.dependencies = dependencyVersions();
  report.completed = true;
  report.evaluation = evaluateReport(report);
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await checkpoint();
  console.log(JSON.stringify(report.evaluation, null, 2));
  if (!calibrate && !report.evaluation.pass) process.exitCode = 1;
} catch (error) {
  report.failure =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
  await checkpoint();
  console.error(error);
  process.exitCode = 1;
}
