import { _electron, expect } from "@playwright/test";
import type { AnalysisRun } from "../src/analysis-types.ts";
import type { Workload } from "./measurement-types.ts";
import { ANALYSIS_LIMITS } from "../src/analysis-types.ts";
import { sample } from "./process-metrics.ts";
import { thresholds } from "./resource-thresholds.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

assert.equal(process.platform, "linux", "Analysis resource measurements require Linux /proc.");
assert(
  process.argv.slice(2).every((arg) => arg === "--real"),
  "Only --real is supported.",
);
const real = process.argv.includes("--real");
const session = "analysis-resource-synthetic";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const root = await mkdtemp(path.join(os.tmpdir(), "scope-analysis-measure-"));
const output = path.resolve("measurements/analysis");
await mkdir(output, { recursive: true });
const report: {
  completed: boolean;
  generatedAt: string;
  mode: string;
  environment: object;
  method: string;
  workloads: Record<string, Workload>;
  assertions: string[];
  snapshots: object[];
  failure?: string;
} = {
  completed: false,
  generatedAt: new Date().toISOString(),
  mode: real ? "native-codex" : "synthetic-cli",
  environment: {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    totalMemoryBytes: os.totalmem(),
    hostNode: process.version,
  },
  method:
    "Actual changed Electron app under the caller's desktop/Xvfb. No screenshots or recording. Existing process-metrics samples all Electron descendants, including the native/fake CLI, every 250 ms plus reader overhead. RSS counts shared pages repeatedly; PSS is an endpoint sample. CPU100% equals one core. Short-lived subprocesses can be missed. Main and renderer20ms timers measure event-loop delay; driver and fixture generation are excluded from memory totals. Synthetic events are created inside main, so its CPU includes serialization. Default trial has a110s watchdog; native trial has a160s watchdog and sends only one small synthetic session. No real captures or credentials are read by this script. Linux measurements do not establish macOS behavior.",
  workloads: {},
  assertions: [],
  snapshots: [],
};
const app = await _electron.launch({
  args: [
    path.resolve("dist/app"),
    "--history-test",
    "--fixtures-only",
    `--scope-test-root=${root}`,
    ...(real ? [] : [`--analysis-test-cli=${path.resolve("test/fixtures/analysis-view-cli.cjs")}`]),
  ],
  chromiumSandbox: true,
});
const watchdog = setTimeout(() => app.process().kill("SIGKILL"), real ? 160_000 : 110_000);
const page = await app.firstWindow();
page.setDefaultTimeout(8000);
const status = () => app.evaluate(() => globalThis.scopeHistory.snapshot());
const list = () =>
  page.evaluate(async () => window.scope.analysisList((await window.scope.status()).generation));
const verify = (condition: unknown, explanation: string) => {
  assert(condition, explanation);
  report.assertions.push(explanation);
};

async function feed(count: number, delayMs: number, maximum = false) {
  assert(count <= 600 && count > 0 && delayMs <= 50, "Synthetic input remains bounded.");
  return app.evaluate(
    async (_electron, { count, delayMs, maximum, session }) => {
      const history = globalThis.scopeHistory;
      let sequence = globalThis.measureSequence ?? 100;
      let admitted = 0;
      for (let index = 0; index < count; index++) {
        const event = {
          hook_event_name: "PostToolUse",
          session_id: session,
          tool_name: "exec_command",
          tool_input: {
            cmd: maximum
              ? `rg synthetic ${"x".repeat(1200)}`
              : `rg -n synthetic${sequence} src/network`,
          },
          agent_id: maximum ? "actor-" + "a".repeat(1024) : "synthetic-main",
          turn_id: maximum ? "turn-" + "t".repeat(1024) : `turn-${sequence}`,
          tool_use_id: maximum ? `${sequence}-` + "i".repeat(1024) : `tool-${sequence}`,
          model: "synthetic-reported-model",
          tool_response: "",
        };
        event.tool_response = "x".repeat(
          maximum ? 60 * 1024 - Buffer.byteLength(JSON.stringify(event)) : 96,
        );
        const payload = JSON.stringify(event);
        if (maximum && Buffer.byteLength(payload) !== 60 * 1024)
          throw new Error("Maximum fixture byte count changed.");
        const frame = JSON.stringify({
          type: "event",
          connection_id: history.status.connectionId,
          sequence: sequence++,
          hook_type: "PostToolUse",
          session_id: session,
          tool_name: "exec_command",
          received_at: "2026-09-12T14:00:00.000Z",
          payload,
          payload_bytes: Buffer.byteLength(payload),
        });
        if (history.append(history.generation, history.status.connectionId, frame)) admitted++;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      globalThis.measureSequence = sequence;
      const deadline = performance.now() + 8000;
      while (history.sending && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (history.sending) throw new Error("Synthetic input did not drain.");
      return {
        attempted: count,
        admitted,
        rejected: count - admitted,
        maximumPayloadBytes: maximum ? 60 * 1024 : null,
      };
    },
    { count, delayMs, maximum, session },
  );
}

async function record(name: string, action: () => Promise<unknown>) {
  await app.evaluate(() => {
    globalThis.measureMainDelay = 0;
  });
  await page.evaluate(() => {
    globalThis.measureRendererDelay = 0;
  });
  let actionFailure: unknown;
  const measured = await sample(app, 0, async () => {
    try {
      await action();
    } catch (error) {
      actionFailure = error;
    }
  });
  measured.maximumMainDelayMs = await app.evaluate(() => globalThis.measureMainDelay);
  measured.maximumRendererDelayMs = await page.evaluate(() => globalThis.measureRendererDelay);
  measured.history = await status();
  report.workloads[name] = measured;
  for (const [metric, value, ceiling] of [
    ["peak RSS", measured.peakRssBytes, thresholds.peakRssBytes],
    // The native CLI is transient. Its entire phase stays below the existing peak
    // budget; settled viewer phases still use the lower steady-state ceiling.
    [
      "steady RSS",
      measured.steadyRssBytes,
      name === "nativeLunaSmallSession" ? thresholds.peakRssBytes : thresholds.steadyRssBytes,
    ],
    ["processes", measured.peakProcesses, thresholds.processCount],
    [
      "CPU",
      measured.meanCpuPercentOneCore,
      /idle/i.test(name) ? thresholds.idleCpuPercent : thresholds.activeCpuPercent,
    ],
    ["main delay", measured.maximumMainDelayMs, thresholds.mainDelayMs],
    ["renderer delay", measured.maximumRendererDelayMs, thresholds.rendererDelayMs],
    ["queue count", measured.history.peakQueueCount, thresholds.queueCount],
    ["queue bytes", measured.history.peakQueueBytes, thresholds.queueBytes],
    ["pending requests", measured.history.peakPending, thresholds.requests],
    ["retained bytes", measured.history.retainedBytes, thresholds.retainedBytes],
    ["disk bytes", measured.history.maximumDiskBytes, thresholds.diskBytes],
  ] as const)
    verify(Number.isFinite(value) && Number(value) <= ceiling, `${name}: ${metric} <= ${ceiling}`);
  if (measured.finalPssBytes !== null)
    verify(
      measured.finalPssBytes <= thresholds.finalPssBytes,
      `${name}: final PSS <= ${thresholds.finalPssBytes}`,
    );
  if (actionFailure) throw actionFailure;
  console.log(`Measured ${name}.`);
}

async function start(model: string, source: string | null = null): Promise<string> {
  const next = await page.evaluate(
    async ({ session, model, source }) =>
      window.scope.analysisStart((await window.scope.status()).generation, session, model, source),
    { session, model, source },
  );
  assert(next.activeRunId, "Starting analysis returns an active run.");
  return next.activeRunId;
}

async function done(id: string, state = "completed"): Promise<AnalysisRun> {
  const deadline = performance.now() + (real ? 125_000 : 8000);
  while (performance.now() < deadline) {
    const current = await list();
    if (!current.activeRunId) {
      const run = await page.evaluate(
        async ({ generation, id }) => window.scope.analysisRun(generation, id),
        { generation: current.generation, id },
      );
      assert(run, "Completed analysis remains available.");
      assert.equal(run.state, state, run.error ?? "Unexpected analysis result state.");
      verify(
        current.runs.length <= ANALYSIS_LIMITS.runs,
        "Retained analysis runs stay within runtime cap.",
      );
      verify(
        run.snapshot.calls.length <= ANALYSIS_LIMITS.calls,
        "Snapshot calls stay within runtime cap.",
      );
      verify(
        run.snapshot.sampledEvents <= ANALYSIS_LIMITS.events,
        "Sampled events stay within runtime cap.",
      );
      verify(
        Buffer.byteLength(JSON.stringify(run.snapshot)) <= ANALYSIS_LIMITS.snapshotBytes + 4096,
        "Snapshot bytes including runtime metadata allowance stay within cap.",
      );
      verify(run.findings.length <= ANALYSIS_LIMITS.findings, "Findings stay within runtime cap.");
      report.snapshots.push({
        calls: run.snapshot.calls.length,
        sampledEvents: run.snapshot.sampledEvents,
        omittedEvents: run.snapshot.omittedEvents,
        omittedCalls: run.snapshot.omittedCalls,
        bytes: Buffer.byteLength(JSON.stringify(run.snapshot)),
        usage: run.usage,
        state: run.state,
      });
      return run;
    }
    await wait(50);
  }
  throw new Error("Analysis did not finish within the measurement deadline.");
}

async function open() {
  await page.locator("#functions summary").click();
  await page.locator("#open-analysis").click();
  await expect(page.locator("#analysis-session option").filter({ hasText: session })).toHaveCount(
    1,
  );
  await page.locator("#analysis-session").selectOption(JSON.stringify(session));
}

try {
  await page.waitForSelector('html[data-ready="true"]');
  await app.evaluate(() => {
    globalThis.measureMainDelay = 0;
    let last = performance.now();
    globalThis.measureMainTimer = setInterval(() => {
      const now = performance.now();
      globalThis.measureMainDelay = Math.max(globalThis.measureMainDelay, now - last - 20);
      last = now;
    }, 20);
  });
  await page.evaluate(() => {
    globalThis.measureRendererDelay = 0;
    let last = performance.now();
    globalThis.measureRendererTimer = setInterval(() => {
      const now = performance.now();
      globalThis.measureRendererDelay = Math.max(globalThis.measureRendererDelay, now - last - 20);
      last = now;
    }, 20);
  });
  await record("idleUnopened", () => wait(3000));
  await feed(3, 25);
  await open();
  let first!: AnalysisRun;
  await record(real ? "nativeLunaSmallSession" : "firstSnapshot", async () => {
    first = await done(await start(real ? "gpt-5.6-luna" : "test-success"));
  });
  if (real) {
    verify(first.usage !== null, "Native CLI returned usage; no fixture fallback was used.");
  } else {
    await record("clipboardHandoff", async () => {
      await page.evaluate(async (id) => {
        const status = await window.scope.status();
        const run = await window.scope.analysisRun(status.generation, id);
        await window.scope.analysisDecide(status.generation, id, run!.findings[0].id, "kept");
        if (!(await window.scope.analysisExport(status.generation, id)))
          throw new Error("Synthetic handoff did not copy.");
      }, first.id);
    });
    await expect(page.locator(".analysis-call")).toHaveCount(3);
    await page.locator(".analysis-call").first().click();
    const focused = await page
      .locator('.analysis-call[aria-pressed="true"]')
      .getAttribute("data-call");
    await record("captureWithFrozenAnalysis", async () => {
      await feed(160, 15);
    });
    verify(
      (await page.locator('.analysis-call[aria-pressed="true"]').getAttribute("data-call")) ===
        focused,
      "Selected call remains focused while160 new events arrive.",
    );
    verify(
      (await page.locator(".analysis-call").count()) === 3,
      "New arrivals do not change the selected snapshot.",
    );
    await record("largestPayloadsAndSnapshotCaps", async () => {
      const fed = await feed(40, 40, true);
      verify(
        fed.admitted === fed.attempted,
        "All forty maximum accepted payload fixtures were admitted at the sustained rate.",
      );
      const run = await done(await start("test-success"));
      verify(
        run.snapshot.omittedCalls > 0 && run.snapshot.omittedEvents > 0,
        "Snapshot reports calls and events excluded by limits.",
      );
      verify(
        run.snapshot.calls.some((call) => call.excerptOmitted && call.argumentsOmitted),
        "Maximum payload snapshot marks shortened excerpts and arguments.",
      );
    });
    await record("runEvictionAndViewSwitching", async () => {
      for (let index = 0; index < 6; index++) {
        const run = await done(await start("test-success"));
        await expect(page.locator(`#analysis-run option[value="${run.id}"]`)).toHaveCount(1);
        await page.locator("#analysis-run").selectOption(run.id);
        for (const view of ["results", "trail", "routing", "recommendations"]) {
          await page.locator(`[data-analysis-view="${view}"]`).click();
          await page
            .locator("#analysis-search")
            .fill(index % 2 ? "synthetic" : "missing-synthetic-result");
        }
      }
      const current = await list();
      verify(
        current.runs.length === ANALYSIS_LIMITS.runs &&
          !current.runs.some((run) => run.id === first.id),
        "Repeated snapshots evict the oldest run at the four-run limit.",
      );
    });
    await record("burstWithDelayedStorage", async () => {
      await app.evaluate(async () => {
        await globalThis.scopeHistory.call("test", { faults: { delay: 350 } });
      });
      const fed = await feed(600, 0);
      verify(
        fed.rejected > 0,
        "A six-hundred-event burst drops excess input with delayed storage.",
      );
      await app.evaluate(async () => {
        await globalThis.scopeHistory.call("test", { faults: { delay: 0 } });
      });
    });
    await record("pressureAndRecovery", async () => {
      const before = await status();
      await app.evaluate(async () => {
        await globalThis.scopeHistory.call("test", { faults: { disk: true } });
      });
      await feed(24, 20);
      const pressure = await status();
      verify(
        pressure.accepted === before.accepted ||
          Object.values(pressure.drops).some((value) => value > 0),
        "Storage pressure declines incoming events through ordinary capture handling.",
      );
      await app.evaluate(async () => {
        await globalThis.scopeHistory.call("test", { faults: { disk: false } });
      });
      await wait(300);
      const recovering = await status();
      await feed(12, 25);
      verify(
        (await status()).accepted > recovering.accepted,
        "Capture accepts new events after storage pressure clears.",
      );
    });
    await record("slowChildCancellation", async () => {
      const id = await start("test-slow");
      await wait(800);
      await page.evaluate(async () =>
        window.scope.analysisCancel((await window.scope.status()).generation),
      );
      await done(id, "cancelled");
      await done(await start("test-success"));
    });
  }
  await record("settledIdle", () => wait(3000));
  report.completed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : "Analysis measurement failed.";
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await app.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
  const destination = path.join(output, real ? "native.json" : "synthetic.json");
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(`Analysis measurements ${report.completed ? "passed" : "failed"}: ${destination}`);
}
