// Linux VM regression limits are calibrated in docs/electron-regression-validation.md.
export const thresholds = Object.freeze({
  startupMs: 4000, peakRssBytes: 900 * 1024 * 1024, steadyRssBytes: 830 * 1024 * 1024,
  finalPssBytes: 480 * 1024 * 1024, idleCpuPercent: 8, activeCpuPercent: 120,
  searchMs: 800, keyboardMs: 400, mainDelayMs: 350, rendererDelayMs: 350,
  plateauRssGrowthBytes: 80 * 1024 * 1024, plateauPssGrowthBytes: 64 * 1024 * 1024,
  diskBytes: 33 * 1024 * 1024, retainedBytes: 8 * 1024 * 1024,
  queueCount: 32, queueBytes: 1024 * 1024, requests: 4, processCount: 12,
  appBytes: 200 * 1024, runtimeBytes: 310 * 1024 * 1024,
});

export const requiredWorkloads = ['connectedIdle', 'heldCapture', 'capture1000', 'navigate1000', 'captureToRowLimit',
  'navigateRowLimit', 'captureAndRapidInput', 'maximumCycle1', 'maximumCycle2', 'maximumCycle3', 'navigateMaximum',
  'hiddenCapture', 'minimizedCapture', 'delayedStorage', 'burst', 'stalledStorage', 'readOnly', 'diskHeadroom',
  'sqliteFull', 'recoveredCapture', 'settledIdle', 'cleanupFailure', 'restartRecovery'];

export function evaluateReport(report, limits = thresholds) {
  const failures = [], values = {};
  function check(name, value, ceiling) {
    (values[name] ??= []).push(value);
    if (!Number.isFinite(value) || value > ceiling) failures.push({ metric: name, value: value ?? null, limit: ceiling });
  }
  if (!report.completed || !report.trials?.length || report.trials.some(trial => !trial.complete)) failures.push({ metric: 'completion', value: false });
  check('appBytes', report.appBytes, limits.appBytes);
  check('runtimeBytes', report.runtimeBytes, limits.runtimeBytes);
  for (const trial of report.trials ?? []) {
    for (const name of requiredWorkloads) if (!trial.workloads[name]) failures.push({ metric: `trial${trial.index}.${name}`, value: 'missing' });
    check('baselineStartupMs', trial.baseline.startupMs, limits.startupMs);
    check('appStartupMs', trial.startupMs, limits.startupMs);
    for (const [name, workload] of Object.entries({ baselineIdle: trial.baseline.idle, ...trial.workloads })) {
      if (!workload) { failures.push({ metric: name, value: 'missing' }); continue; }
      const prefix = `trial${trial.index}.${name}`;
      check(`${prefix}.peakRssBytes`, workload.peakRssBytes, limits.peakRssBytes);
      check(`${prefix}.steadyRssBytes`, workload.steadyRssBytes, limits.steadyRssBytes);
      check(`${prefix}.finalPssBytes`, workload.finalPssBytes, limits.finalPssBytes);
      check(`${prefix}.processCount`, workload.peakProcesses, limits.processCount);
      check(`${prefix}.cpuPercent`, workload.meanCpuPercentOneCore, /idle/i.test(name) ? limits.idleCpuPercent : limits.activeCpuPercent);
      const active = !['baselineIdle', 'connectedIdle', 'hiddenCapture', 'minimizedCapture', 'settledIdle', 'cleanupFailure', 'restartRecovery'].includes(name);
      if (active) check(`${prefix}.mainDelayMs`, workload.maximumMainDelayMs, limits.mainDelayMs);
      if (active) check(`${prefix}.rendererDelayMs`, workload.maximumRendererDelayMs, limits.rendererDelayMs);
      if (name !== 'baselineIdle') {
        if (!workload.history) { failures.push({ metric: `${prefix}.history`, value: 'missing' }); continue; }
        check(`${prefix}.diskBytes`, workload.history.maximumDiskBytes, limits.diskBytes);
        check(`${prefix}.retainedBytes`, workload.history.retainedBytes ?? (workload.history.total === 0 ? 0 : undefined), limits.retainedBytes);
        check(`${prefix}.queueCount`, workload.history.peakQueueCount, limits.queueCount);
        check(`${prefix}.queueBytes`, workload.history.peakQueueBytes, limits.queueBytes);
        check(`${prefix}.requests`, workload.history.peakPending, limits.requests);
      }
      if (['navigate1000', 'navigateRowLimit', 'navigateMaximum'].includes(name)) {
        check(`${prefix}.searchMs`, workload.workload?.searchMs?.maximum, limits.searchMs);
        check(`${prefix}.keyboardMs`, workload.workload?.keyboardMs?.maximum, limits.keyboardMs);
      }
    }
    const first = trial.workloads.maximumCycle1, last = trial.workloads.maximumCycle3;
    if (first && last) {
      check(`trial${trial.index}.plateauRssGrowthBytes`, last.steadyRssBytes - first.steadyRssBytes, limits.plateauRssGrowthBytes);
      check(`trial${trial.index}.plateauPssGrowthBytes`, last.finalPssBytes - first.finalPssBytes, limits.plateauPssGrowthBytes);
    } else failures.push({ metric: 'evictionCycles', value: false });
  }
  const starts = report.trials?.map(trial => trial.startupMs).filter(Number.isFinite) ?? [];
  return { pass: failures.length === 0, checkedValues: Object.values(values).reduce((count, entries) => count + entries.length, 0),
    limits, startupRangeMs: starts.length ? [Math.min(...starts), Math.max(...starts)] : null, failures };
}
