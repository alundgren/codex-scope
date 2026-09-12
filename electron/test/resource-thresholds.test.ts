import type { Page } from "@playwright/test";
import type { ResourceWorkload } from "../scripts/resource-thresholds.ts";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { evaluateReport, requiredWorkloads, thresholds } from "../scripts/resource-thresholds.ts";
import { completed } from "../scripts/interaction-metrics.ts";

test("interaction completion requires a matching selected row or a cleared empty result", async () => {
  const originalDocument = globalThis.document;
  try {
    for (const [payload, selected, busy, expected, position, ready] of [
      ["null", "7", "false", null, 0, false],
      ["", "7", "false", null, 0, false],
      ["null", null, "false", null, 0, true],
      ["", null, "false", null, 0, true],
      ["7", null, "false", null, 0, false],
      ["7", "8", "false", null, 0, false],
      ["7", "7", "true", null, 0, false],
      ["7", "7", "false", { id: 7, position: 2 }, 1, false],
      ["7", "7", "false", { id: 7, position: 2 }, 2, true],
    ] as [
      string,
      string | null,
      string,
      { id: number; position: number } | null,
      number,
      boolean,
    ][]) {
      const elements: Record<
        string,
        { getAttribute?: () => string; dataset?: { event: string } } | null
      > = {
        "#entries": { getAttribute: () => busy },
        "#payload": { dataset: { event: payload } },
        '.event[aria-pressed="true"]': selected === null ? null : { dataset: { event: selected } },
        "#scrubber": { getAttribute: () => String(position) },
      };
      // This double supplies only the DOM reads made by the completion predicate.
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: { querySelector: (selector: string) => elements[selector] },
      });
      let frames = 0;
      const page = {
        waitForFunction: async (
          predicate: (argument: { id: number; position: number } | null) => boolean,
          argument: { id: number; position: number } | null,
        ) => {
          if (!predicate(argument)) throw new Error("Result is not complete");
        },
        locator: () => ({ textContent: async () => "" }),
        evaluate: async () => {
          frames++;
        },
      };
      if (ready) await completed(page as unknown as Page, expected);
      else
        await assert.rejects(
          completed(page as unknown as Page, expected),
          /Result is not complete/,
        );
      assert.equal(frames, Number(ready));
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
