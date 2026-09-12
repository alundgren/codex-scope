import { _electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sample, bytes } from './process-metrics.mjs';
import { interactions } from './interaction-metrics.mjs';

const root = await mkdtemp('/tmp/scope-navigation-measure-');
await mkdir('measurements', { recursive: true });
const fixture = (await readFile('fixtures/journal.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
const started = performance.now();
const app = await _electron.launch({ args: [path.resolve('dist/app'), '--history-test', '--fixtures-only', `--scope-test-root=${root}`], chromiumSandbox: true });
const page = await app.firstWindow();
const report = { date: new Date().toISOString(), environment: { platform: os.platform(), release: os.release(), cpus: os.cpus().map(cpu => cpu.model), memory: os.totalmem() },
  method: 'Actual Electron/Xvfb without recording. All Electron process-group members and descendants sampled every 250 ms. Summed RSS duplicates shared pages; final PSS is one aggregate snapshot. CPU 100% is one core. Main includes synthetic input serialization. Search timings include 180 ms input debounce and driver/IPC costs; keyboard timings include driver/IPC, expected selected ID, completed journal update and the next animation frame. Per-query worker maximum excludes those costs.', workloads: {} };
const status = () => app.evaluate(() => globalThis.scopeHistory.snapshot());
async function feed(count, maximum = false) {
  await app.evaluate(async (_electron, { count, message, maximum }) => {
    const history = globalThis.scopeHistory;
    let sequence = globalThis.measureSequence ?? 100;
    for (let index = 0; index < count; index++) {
      let frame = message;
      if (!maximum) {
        const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: `session-${index % 40}`,
          message: 'population synthetic input', unknown_tail: `${'x'.repeat(60)} literal [a.*]%_ ${index % 2 ? 'odd' : 'even'}` });
        frame = { type: 'event', hook_type: 'PreToolUse', session_id: `session-${index % 40}`, tool_name: null,
          payload, payload_bytes: Buffer.byteLength(payload), received_at: '2026-09-11T18:00:00.000Z' };
      }
      history.append(history.generation, history.status.connectionId, JSON.stringify({ ...frame, connection_id: history.status.connectionId, sequence: sequence++ }));
      if (maximum || index % 8 === 7) await new Promise(resolve => setTimeout(resolve, maximum ? 65 : 45));
    }
    globalThis.measureSequence = sequence;
    const deadline = performance.now() + 5000;
    while (history.sending && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (history.sending) throw new Error('Input did not drain.');
  }, { count, message: fixture[4], maximum });
}
async function record(name, action) {
  report.workloads[name] = await sample(app, 0, action);
  report.workloads[name].history = await status();
  report.workloads[name].maximumMainDelayMs = await app.evaluate(() => { const value = globalThis.measureMainDelay; globalThis.measureMainDelay = 0; return value; });
  report.workloads[name].maximumRendererDelayMs = await page.evaluate(() => { const value = globalThis.measureRendererDelay; globalThis.measureRendererDelay = 0; return value; });
  console.log(`Measured ${name}.`);
}
try {
  await page.waitForSelector('html[data-ready="true"]');
  report.startupMs = performance.now() - started;
  report.versions = await app.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite, chrome: process.versions.chrome }));
  await app.evaluate(() => {
    globalThis.measureMainDelay = 0; let last = performance.now();
    globalThis.measureMainTimer = setInterval(() => { const now = performance.now(); globalThis.measureMainDelay = Math.max(globalThis.measureMainDelay, now - last - 20); last = now; }, 20);
  });
  await page.evaluate(() => {
    globalThis.measureRendererDelay = 0; let last = performance.now();
    globalThis.measureRendererTimer = setInterval(() => { const now = performance.now(); globalThis.measureRendererDelay = Math.max(globalThis.measureRendererDelay, now - last - 20); last = now; }, 20);
  });
  report.workloads.idle = await sample(app, 4000);
  await page.locator('button[data-event="4"]').click(); await page.locator('#scrollbar').press('PageDown');
  for (const [label, added] of [['1000', 1000], ['3000', 2000], ['10000', 7000], ['retentionRepeat', 10000]]) {
    await record(`capture${label}`, () => feed(added));
    let timings;
    await record(`navigate${label}`, async () => { timings = await interactions(page, status); });
    report.workloads[`navigate${label}`].timings = timings;
  }
  await record('maximumPayloadCapture', () => feed(240, true));
  let timings;
  await record('maximumPayloadNavigation', async () => { timings = await interactions(page, status); });
  report.workloads.maximumPayloadNavigation.timings = timings;
  await page.evaluate(() => clearInterval(globalThis.measureRendererTimer));
  await app.evaluate(() => clearInterval(globalThis.measureMainTimer));
  report.workloads.settledIdle = await sample(app, 6000);
  report.final = await app.evaluate(() => globalThis.scopeHistory.call('test', { faults: {} }));
  delete report.final.directory;
  report.appBytes = await bytes('dist/app');
  report.runtimeBytes = await bytes('node_modules/electron/dist');
} finally { await app.close(); }
await writeFile('measurements/navigation-linux.json', JSON.stringify(report, null, 2) + '\n');
console.log('Wrote measurements/navigation-linux.json');
