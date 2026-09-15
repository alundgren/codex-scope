import type { Page } from "@playwright/test";
import type { ResourceWorkload } from "../scripts/resource-thresholds.ts";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { evaluateReport, requiredWorkloads, thresholds } from "../scripts/resource-thresholds.ts";
import { completed } from "../scripts/interaction-metrics.ts";

test("interaction completion requires a committed table page and requested first row", async () => {
  const originalDocument = globalThis.document;
  try {
    for (const [busy, id, position, expected, ready] of [
      ["true", "7", 2, null, false],
      ["false", "7", 2, null, true],
      ["false", "7", 2, { id: 7, position: 2 }, true],
      ["false", "8", 2, { id: 7, position: 2 }, false],
      ["false", "7", 1, { id: 7, position: 2 }, false],
    ] as [string, string, number, { id: number; position: number } | null, boolean][]) {
      const elements: Record<string, unknown> = {
        "#entries": { getAttribute: () => busy, dataset: { position: String(position) } },
        "#entries [data-event]": { dataset: { event: id } },
      };
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: { querySelector: (selector: string) => elements[selector] },
      });
      const page = {
        waitForFunction: async (fn: (arg: typeof expected) => boolean, arg: typeof expected) => {
          if (!fn(arg)) throw new Error("Pending result");
        },
        locator: () => ({ textContent: async () => "" }),
        evaluate: async () => {},
      };
      if (ready) await completed(page as unknown as Page, expected);
      else await assert.rejects(completed(page as unknown as Page, expected), /Pending result/);
    }
  } finally {
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else globalThis.document = originalDocument;
  }
});

function passing() {
  const workload = (): ResourceWorkload => ({
    peakRssBytes: 600e6,
    steadyRssBytes: 550e6,
    finalPssBytes: 300e6,
    peakProcesses: 7,
    meanCpuPercentOneCore: 1,
    maximumMainDelayMs: 5,
    maximumRendererDelayMs: 5,
    history: {
      maximumDiskBytes: 100000,
      total: 3,
      retainedBytes: 10000,
      peakQueueCount: 1,
      peakQueueBytes: 10000,
      peakPending: 1,
    },
    workload: { searchMs: { maximum: 300 }, keyboardMs: { maximum: 50 } },
  });
  return {
    completed: true,
    appBytes: 180000,
    runtimeBytes: 295827900,
    trials: [
      {
        index: 1,
        complete: true,
        startupMs: 1500,
        baseline: { startupMs: 1200, idle: workload() },
        workloads: Object.fromEntries(requiredWorkloads.map((name) => [name, workload()])),
      },
    ],
  };
}

test("resource limits reject regression, missing measurement and incomplete workloads", () => {
  assert.equal(evaluateReport(passing()).pass, true);
  for (const mutate of [
    (value: ReturnType<typeof passing>) => {
      value.trials[0].workloads.settledIdle.peakRssBytes = thresholds.peakRssBytes + 1;
    },
    (value: ReturnType<typeof passing>) => {
      value.trials[0].workloads.maximumCycle3.steadyRssBytes! +=
        thresholds.plateauRssGrowthBytes + 1;
    },
    (value: ReturnType<typeof passing>) => {
      value.trials[0].workloads.hiddenCapture.finalPssBytes = null;
    },
    (value: ReturnType<typeof passing>) => {
      value.trials[0].workloads.navigateMaximum.workload = {
        searchMs: { maximum: thresholds.searchMs + 1 },
        keyboardMs: { maximum: 10 },
      };
    },
    (value: ReturnType<typeof passing>) => {
      delete value.trials[0].workloads.stalledStorage;
    },
    (value: ReturnType<typeof passing>) => {
      delete value.trials[0].workloads.navigateMaximum.workload;
    },
    (value: ReturnType<typeof passing>) => {
      delete value.trials[0].workloads.maximumCycle1.history;
    },
    (value: ReturnType<typeof passing>) => {
      delete value.trials[0].workloads.maximumCycle1.history!.retainedBytes;
    },
    (value: ReturnType<typeof passing>) => {
      delete value.trials[0].workloads.capture1000.maximumRendererDelayMs;
    },
    (value: ReturnType<typeof passing>) => {
      value.completed = false;
    },
  ]) {
    const report = passing();
    mutate(report);
    assert.equal(evaluateReport(report).pass, false);
  }
});
