import { _electron } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import recording from '../src/recording.cjs';

if (process.platform !== 'linux') throw new Error('This measurement uses Linux /proc.');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const pageBytes = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim());
const output = path.resolve('measurements');
await mkdir(output, { recursive: true });
const targetName = process.argv[2];
if (targetName && !['baseline', 'inspector', 'capacity'].includes(targetName)) throw new Error('Expected baseline, inspector or capacity.');

async function processes(root) {
  const all = (await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(async name => {
    try {
      const text = await readFile(`/proc/${name}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      return { pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]),
        ticks: Number(fields[11]) + Number(fields[12]), rssBytes: Number(fields[21]) * pageBytes };
    } catch { return null; }
  }))).filter(Boolean);
  const rootProcess = all.find(item => item.pid === root);
  if (!rootProcess) throw new Error('Electron exited during measurement.');
  const owned = new Set([root]);
  for (let pass = 0; pass < all.length; pass++) {
    const before = owned.size;
    for (const item of all) if (owned.has(item.parent) || (rootProcess.group === root && item.group === root)) owned.add(item.pid);
    if (before === owned.size) break;
  }
  const members = all.filter(item => owned.has(item.pid));
  for (const item of members) {
    try {
      const text = await readFile(`/proc/${item.pid}/smaps_rollup`, 'utf8');
      item.pssBytes = Number(text.match(/^Pss:\s+(\d+)/m)[1]) * 1024;
    } catch { item.pssBytes = null; }
    const args = (await readFile(`/proc/${item.pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
    item.role = args.join(' ').match(/--type=([^\s]+)/)?.[1] ?? (item.pid === root ? 'main' : 'sandbox helper');
  }
  return { at: performance.now(), members, rssBytes: members.reduce((sum, item) => sum + item.rssBytes, 0),
    pssBytes: members.every(item => item.pssBytes !== null) ? members.reduce((sum, item) => sum + item.pssBytes, 0) : null };
}
async function sample(app, duration, action = async () => wait(duration)) {
  const samples = [await processes(app.process().pid)];
  let finished = false;
  const workload = action().finally(() => { finished = true; });
  while (!finished) { await wait(250); samples.push(await processes(app.process().pid)); }
  await workload;
  const final = samples.at(-1);
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type })));
  for (const item of final.members) item.role = metrics.find(metric => metric.pid === item.pid)?.type ?? item.role;
  if (final.pssBytes === null) {
    // Read only aggregate counters when Linux hides sandboxed-process /proc data.
    try {
      const code = 'import json,pathlib,re,sys\nresult={}\nfor raw in sys.argv[1:]:\n p=int(raw)\n try:\n  text=pathlib.Path(f"/proc/{p}/smaps_rollup").read_text()\n  result[p]=int(re.search(r"^Pss:\\s+(\\d+)",text,re.M)[1])*1024\n except (OSError,TypeError): result[p]=None\nprint(json.dumps(result))';
      const memory = JSON.parse(execFileSync('sudo', ['-n', 'python3', '-c', code, ...final.members.map(item => String(item.pid))],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }));
      for (const item of final.members) item.pssBytes = memory[item.pid];
      final.pssBytes = final.members.every(item => item.pssBytes !== null) ? final.members.reduce((sum, item) => sum + item.pssBytes, 0) : null;
    } catch { /* RSS remains available without a privileged measurement reader. */ }
  }
  const cpu = [];
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    const delta = current.members.reduce((sum, item) => sum + Math.max(0, item.ticks - (previous.members.find(old => old.pid === item.pid)?.ticks ?? item.ticks)), 0);
    cpu.push(delta / ticksPerSecond / ((current.at - previous.at) / 1000) * 100);
  }
  return { durationMs: samples.at(-1).at - samples[0].at, samples: samples.length,
    meanCpuPercentOneCore: cpu.reduce((sum, value) => sum + value, 0) / cpu.length,
    peakSampleCpuPercentOneCore: Math.max(...cpu), peakRssBytes: Math.max(...samples.map(item => item.rssBytes)),
    finalRssBytes: samples.at(-1).rssBytes, finalPssBytes: samples.at(-1).pssBytes,
    finalProcesses: samples.at(-1).members.map(({ pid, parent, group, ticks, ...item }) => item) };
}
async function bytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    total += entry.isDirectory() ? await bytes(location) : (await stat(location)).size;
  }
  return total;
}
const report = { generatedAt: new Date().toISOString(), environment: { platform: os.platform(), release: os.release(),
  arch: os.arch(), cpus: os.cpus().map(cpu => cpu.model), totalMemoryBytes: os.totalmem(), hostNode: process.version,
  osRelease: await readFile('/etc/os-release', 'utf8') },
  method: 'Fresh Electron processes, OS filesystem caches left warm. Playwright debugger attached, no video or screenshots. /proc process group and descendants, 250 ms between samples. CPU 100% means one core. Summed RSS includes shared pages. Final PSS uses a read-only sudo /proc counter reader when sandboxed processes deny smaps access; null means unavailable. PSS is a final snapshot, not a sampled peak.',
  versions: {}, startup: {}, workloads: {} };
const capacity = await mkdtemp(path.join(os.tmpdir(), 'scope-capacity-measure-'));
try {
  await cp('dist/app', capacity, { recursive: true });
  const source = (await readFile('fixtures/journal.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
  const capacityMessages = [source[0], ...Array.from({ length: 16 }, (_, index) => ({ ...source[index < 4 ? 4 : 1], sequence: index + 1 }))];
  await writeFile(path.join(capacity, 'fixtures/journal.jsonl'), capacityMessages.map(JSON.stringify).join('\n') + '\n');
  const targets = { baseline: path.resolve('test/baseline/main.cjs'), inspector: path.resolve('dist/app'), capacity };
  for (const [name, target] of Object.entries(targets)) {
    if (targetName && name !== targetName) continue;
    report.startup[name] = [];
    for (let trial = 0; trial < 3; trial++) {
      const started = performance.now();
      const app = await _electron.launch({ args: [target], chromiumSandbox: true });
      try {
        const page = await app.firstWindow();
        await page.waitForSelector('html[data-ready="true"]');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        report.startup[name].push(performance.now() - started);
        if (trial === 0) {
          report.versions = await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 }));
          report.gpuFeatures = await app.evaluate(({ app }) => app.getGPUFeatureStatus());
        }
        if (trial !== 2) continue;
        report.workloads[`${name}Idle`] = await sample(app, 6000);
        console.log(`Measured ${name} idle.`);
        if (name === 'baseline') continue;
        await page.locator('button[data-event="4"]').click();
        await page.waitForFunction(() => document.querySelector('#payload').dataset.event === '4');
        report.workloads[`${name}MaximumPayload`] = await sample(app, 4000);
        console.log(`Measured ${name} maximum payload.`);
        const latencies = [];
        report.workloads[`${name}Interactions`] = await sample(app, 0, async () => {
          for (let index = 0; index < 60; index++) {
            const id = index % 2 ? 4 : 3;
            const start = performance.now();
            await page.evaluate(id => document.querySelector(`button[data-event="${id}"]`).click(), id);
            await page.waitForFunction(id => document.querySelector('#payload').dataset.event === String(id), id);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
            latencies.push(performance.now() - start);
            await page.locator('#scrollbar').press(index % 2 ? 'End' : 'Home');
          }
        });
        report.workloads[`${name}Interactions`].selectionLatencyMs = { max: Math.max(...latencies), p95: latencies.toSorted((a, b) => a - b)[Math.floor(latencies.length * .95)], mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length, operations: latencies.length };
        if (name === 'inspector') {
          report.clipboardLatencyMs = [];
          for (let index = 0; index < 20; index++) {
            const start = performance.now();
            const ok = await page.evaluate(() => window.scope.copyPayload(4));
            if (!ok) throw new Error('Clipboard measurement failed.');
            report.clipboardLatencyMs.push(performance.now() - start);
          }
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
          report.workloads.inspectorHidden = await sample(app, 6000);
        }
      } finally { await app.close(); }
      console.log(`Measured ${name}.`);
    }
  }
  report.appBytes = await bytes('dist/app');
  report.runtimeBytes = await bytes('node_modules/electron/dist');
  report.inventory = JSON.parse(execFileSync('npm', ['ls', '--all', '--json'], { encoding: 'utf8' }));
  const fixtureBytes = await readFile('fixtures/journal.jsonl');
  const capacityBytes = await readFile(path.join(capacity, 'fixtures/journal.jsonl'));
  report.recordings = {};
  for (const [name, buffer] of [['default', fixtureBytes], ['capacity', capacityBytes]]) {
    const times = [];
    for (let index = 0; index < 100; index++) {
      const start = performance.now();
      recording.parseRecording(buffer);
      times.push(performance.now() - start);
    }
    const data = recording.parseRecording(buffer);
    report.recordings[name] = { events: data.events.length, payloadBytes: data.payloadBytes, sourceBytes: buffer.length,
      parseMs: { max: Math.max(...times), p95: times.toSorted((a, b) => a - b)[95] } };
  }
  const filename = targetName ? `${targetName}.json` : 'linux.json';
  await writeFile(path.join(output, filename), JSON.stringify(report, null, 2) + '\n');
  console.log(`Wrote measurements/${filename}`);
} finally { await rm(capacity, { recursive: true, force: true }); }
