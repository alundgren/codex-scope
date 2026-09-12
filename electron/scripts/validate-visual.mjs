import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const output = path.resolve('validation/visual');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const report = { date: new Date().toISOString(), platform: os.platform(), release: os.release(),
  hostNode: process.version, mode: 'Actual Electron/Xvfb; synthetic fixtures and bounded fake collector; no resource measurements.',
  electron: (await readFile('node_modules/electron/dist/version', 'utf8')).trim(),
  playwright: JSON.parse(await readFile('node_modules/@playwright/test/package.json', 'utf8')).version,
  completed: false, files: [] };
try {
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  execFileSync('npm', ['run', 'test:unit'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/desktop.mjs', 'npx', 'playwright', 'test', '--reporter=list,json'], { stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(output, 'tests.json') } });
  execFileSync(process.execPath, ['scripts/reference.mjs'], { stdio: 'inherit' });
  const tests = JSON.parse(await readFile(path.join(output, 'tests.json'), 'utf8'));
  report.stats = tests.stats;
  report.completed = tests.stats.unexpected === 0 && tests.stats.skipped === 0;
  if (!report.completed) process.exitCode = 1;
} catch (error) {
  report.failure = { status: error.status, message: error.message };
  process.exitCode = 1;
} finally {
  async function collect(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      const source = path.join(directory, entry.name), name = path.join(relative, entry.name);
      if (entry.isDirectory() && entry.name !== 'video') await collect(source, name);
      else if (entry.isFile() && /\.(png|webm)$/.test(entry.name)) {
        const destination = path.join(output, 'artifacts', name);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(source, destination);
        report.files.push({ path: `artifacts/${name}`, bytes: (await stat(source)).size,
          sha256: createHash('sha256').update(await readFile(source)).digest('hex') });
      }
    }
  }
  await collect('test-results');
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Visual result: ${report.completed ? 'PASS' : 'FAIL'}; ${report.files.length} artifacts in validation/visual. Inspect the images and recordings before approving UX.`);
}
