import { readFile } from 'node:fs/promises';
import { evaluateReport, thresholds } from './resource-thresholds.mjs';
const args = process.argv.slice(2);
const prove = args.includes('--prove-failure');
const file = args.find(value => !value.startsWith('--')) ?? 'measurements/regression/report.json';
const report = JSON.parse(await readFile(file, 'utf8'));
if (prove) report.trials[0].workloads.settledIdle.peakRssBytes = thresholds.peakRssBytes + 1;
const result = evaluateReport(report);
console.log(JSON.stringify(result, null, 2));
if (prove) {
  const rejected = result.failures.some(item => item.metric === 'trial1.settledIdle.peakRssBytes');
  console.log(rejected ? 'PASS: a deliberate one-byte regression was rejected.' : 'FAIL: regression was missed.');
  process.exitCode = rejected ? 0 : 1;
} else process.exitCode = result.pass ? 0 : 1;
