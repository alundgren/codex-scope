import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const pageBytes = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim());
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

export { sample, bytes };
