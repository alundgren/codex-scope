import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReport, requiredWorkloads, thresholds } from '../scripts/resource-thresholds.mjs';

function passing() {
  const workload = () => ({ peakRssBytes: 600e6, steadyRssBytes: 550e6, finalPssBytes: 300e6,
    peakProcesses: 7, meanCpuPercentOneCore: 1 });
  return { completed: true, appBytes: 180000, runtimeBytes: 295827900,
    trials: [{ index: 1, complete: true, startupMs: 1500, baseline: { startupMs: 1200, idle: workload() },
      workloads: Object.fromEntries(requiredWorkloads.map(name => [name, workload()])) }] };
}

test('resource limits reject regression, missing measurement and incomplete workloads', () => {
  assert.equal(evaluateReport(passing()).pass, true);
  for (const mutate of [
    value => { value.trials[0].workloads.settledIdle.peakRssBytes = thresholds.peakRssBytes + 1; },
    value => { value.trials[0].workloads.maximumCycle3.steadyRssBytes += thresholds.plateauRssGrowthBytes + 1; },
    value => { value.trials[0].workloads.hiddenCapture.finalPssBytes = null; },
    value => { value.trials[0].workloads.navigateMaximum.workload = { searchMs: { maximum: thresholds.searchMs + 1 }, keyboardMs: { maximum: 10 } }; },
    value => { delete value.trials[0].workloads.stalledStorage; },
    value => { value.completed = false; },
  ]) {
    const report = passing(); mutate(report);
    assert.equal(evaluateReport(report).pass, false);
  }
});
