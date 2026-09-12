import { test, expect, _electron } from '@playwright/test';
import { mkdtemp, readFile, readdir, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { once } from 'node:events';
import electron from 'electron';

const source = (await readFile('fixtures/journal.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
const appPath = path.resolve('dist/app');
const capture = async (page, info, name) => { await page.mouse.move(1, 1); await page.waitForTimeout(350); await page.screenshot({ path: info.outputPath(`${name}.png`) }); };
async function launch(info, { root, continuous = false } = {}) {
  root ??= await mkdtemp('/tmp/scope-history-test-');
  const app = await _electron.launch({ args: [appPath, '--history-test', `--scope-test-root=${root}`, ...continuous ? [] : ['--fixtures-only']], chromiumSandbox: true,
    recordVideo: { dir: info.outputPath('video'), size: { width: 1180, height: 820 } } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.documentElement.dataset.ready || document.querySelector('#notice').textContent);
  return { app, page, root, video: page.video() };
}
const state = app => app.evaluate(() => globalThis.scopeHistory.snapshot());
const fault = (app, faults) => app.evaluate((_electron, faults) => globalThis.scopeHistory.call('test', { faults }), faults);
async function append(app, count, template = 1, { burst = false, oversized = false, receivedStart = null } = {}) {
  await app.evaluate(async (_electron, { message, count, burst, oversized, receivedStart }) => {
    const history = globalThis.scopeHistory;
    let next = globalThis.syntheticSequence ?? history.status.accepted + 100;
    for (let index = 0; index < count; index++) {
      const frame = { ...message, connection_id: history.status.connectionId, sequence: next++, received_at: '2026-09-11T14:00:00.000Z' };
      if (receivedStart !== null) frame.received_at = new Date(receivedStart + index * 1000).toISOString();
      if (oversized) { frame.payload += ' '; frame.payload_bytes++; }
      history.append(history.generation, history.status.connectionId, JSON.stringify(frame));
      if (!burst && index % 4 === 3) {
        const deadline = performance.now() + 5000;
        while (history.sending && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setTimeout(resolve, 140));
      }
    }
    globalThis.syntheticSequence = next;
    const deadline = performance.now() + 10000;
    while (history.sending && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (history.sending) throw new Error('Intake did not settle.');
  }, { message: source[template], count, burst, oversized, receivedStart });
}
async function expectAlignedPin(page) {
  const distance = await page.evaluate(() => {
    const pin = document.querySelector('#pin').getBoundingClientRect();
    const row = document.querySelector('.event[aria-pressed="true"]').getBoundingClientRect();
    return Math.abs(pin.top + pin.height / 2 - row.top - row.height / 2);
  });
  expect(distance).toBeLessThanOrEqual(1);
}
async function clear(page) {
  await page.locator('#clear').click();
  await page.locator('#clear').click();
  await expect(page.locator('#json')).toBeEmpty();
  await expect(page.locator('#clear')).toBeDisabled();
}

test('recorded history: arrivals hold rows and offset, boundaries, pressure recovery, eviction, and Clear', async ({}, info) => {
  const { app, page, video } = await launch(info);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.locator('#mode')).toHaveText('Live');
    await page.locator('[data-event="3"]').click();
    await capture(page, info, 'history-desktop');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(440, 820));
    await capture(page, info, 'history-narrow');
    await expectAlignedPin(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 760));
    await page.locator('[data-event="4"]').click();
    await page.locator('#scrollbar').press('PageDown');
    const before = await page.locator('#payload').evaluate(node => node.scrollTop);
    expect(before).toBeGreaterThan(0);
    const rows = await page.locator('#entries').innerText();
    await append(app, 12);
    await expect(page.locator('#count')).toContainText('12 new');
    expect(await page.locator('#entries').innerText()).toBe(rows);
    expect(await page.locator('#payload').evaluate(node => node.scrollTop)).toBe(before);
    expect(await page.locator('#json').textContent()).toBe(source[4].payload);
    await capture(page, info, 'held-arrivals');
    const inspection = await app.evaluate(() => globalThis.scopeHistory.inspect(1, 4, 5));
    expect(inspection.rows.length).toBeLessThanOrEqual(5);
    expect(inspection.selected).toMatchObject({ generation: 1, sequence: 4, text: source[4].payload, bytes: 61440 });
    expect(inspection.selected.localReceivedAt).toMatch(/Z$/);
    expect(inspection.selected.connectionId).toBe((await state(app)).connectionId);
    await append(app, 1, 4, { oversized: true });
    await expect(page.locator('#notice')).toContainText('1 oversized');
    await fault(app, { queryOnly: true });
    await append(app, 1);
    await expect(page.locator('#notice')).toContainText('Storage pressure');
    await page.locator('[data-event="3"]').click();
    await expect(page.locator('#json')).toHaveText(source[3].payload);
    await capture(page, info, 'write-pressure');
    await fault(app, { queryOnly: false, disk: true });
    await append(app, 1);
    await expect(page.locator('#notice')).toContainText('2 storage');
    await capture(page, info, 'disk-pressure');
    await fault(app, { disk: false, diskFull: true });
    await append(app, 1, 4);
    await expect(page.locator('#notice')).toContainText('3 storage');
    await capture(page, info, 'sqlite-full');
    await fault(app, { diskFull: false });
    await append(app, 1);
    await expect(page.locator('#notice')).not.toContainText('Storage pressure');
    await capture(page, info, 'pressure-recovered');
    await page.locator('[data-event="4"]').click();
    await append(app, 160, 4);
    await expect(page.locator('#notice')).toContainText('selected event was evicted');
    const evicted = await state(app);
    expect(evicted.first.id).toBeGreaterThan(4);
    await expect(page.locator('#payload')).toHaveAttribute('data-event', String(evicted.first.id));
    expect(evicted.retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(evicted.maximumDiskBytes).toBeLessThanOrEqual(33 * 1024 * 1024);
    await capture(page, info, 'eviction');
    await expectAlignedPin(page);
    await page.locator('#live').click();
    await expect(page.locator('#mode')).toHaveText('Live');
    await expect(page.locator('#payload')).toHaveAttribute('data-event', String(evicted.last.id));
    await page.locator('#clear').click();
    await expect(page.locator('#clear')).toHaveAccessibleName('Confirm Clear history');
    await capture(page, info, 'clear-unlocked');
    await page.waitForTimeout(3050);
    await expect(page.locator('#clear')).toHaveAccessibleName('Unlock Clear history');
    expect((await state(app)).total).toBe(evicted.total);
    await page.locator('#clear').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#clear')).toHaveAccessibleName('Unlock Clear history');
    await capture(page, info, 'clear-cancelled');
    await page.locator('#clear').focus();
    await page.keyboard.down('Enter');
    for (let repeat = 0; repeat < 3; repeat++) await page.keyboard.down('Enter');
    await page.waitForTimeout(350);
    expect((await state(app)).total).toBe(evicted.total);
    await capture(page, info, 'held-key');
    await page.keyboard.up('Enter');
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#clear').click();
    await page.waitForTimeout(3050);
    await expect(page.locator('#clear')).toHaveAccessibleName('Unlock Clear history');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await clear(page);
    await expect(page.locator('#clear')).toBeDisabled();
    await capture(page, info, 'clear-empty');
    const clean = await state(app);
    expect(clean.generation).toBe(2);
    expect(clean.connectionId).not.toBe(evicted.connectionId);
    await append(app, 1, 3);
    await expect(page.locator('#count')).toHaveText('1 retained');
    await expect(page.locator('#json')).toHaveText(source[3].payload);
    await capture(page, info, 'clear-recovered');
    await expectAlignedPin(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(440, 820));
    await capture(page, info, 'clear-narrow');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await app.close(); await video.saveAs(info.outputPath('history-walkthrough.webm')); }
});

test('retained bounds advance while the selected event and reading position survive eviction', async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await append(app, 130, 4, { receivedStart: Date.parse('2026-09-11T15:00:00.000Z') });
    const before = await state(app);
    const id = before.last.id;
    await page.locator(`button[data-event="${id}"]`).click();
    await page.locator('#scrollbar').press('PageDown');
    const offset = await page.locator('#payload').evaluate(node => node.scrollTop);
    expect(offset).toBeGreaterThan(0);
    const rows = await page.locator('#entries').textContent();
    const text = await page.locator('#json').textContent();
    await capture(page, info, 'retained-bound-before');
    await append(app, 12, 4, { receivedStart: Date.parse('2026-09-11T15:03:00.000Z') });
    const after = await state(app);
    expect(after.first.id).toBeGreaterThan(before.first.id);
    expect(after.first.id).toBeLessThan(id);
    expect(after.first.receivedAt).not.toBe(before.first.receivedAt);
    await expect(page.locator('#oldest')).toHaveText(after.first.receivedAt.slice(11, 19));
    await expect(page.locator('#payload')).toHaveAttribute('data-event', String(id));
    expect(await page.locator('#entries').textContent()).toBe(rows);
    expect(await page.locator('#json').textContent()).toBe(text);
    expect(await page.locator('#payload').evaluate(node => node.scrollTop)).toBe(offset);
    await expectAlignedPin(page);
    await capture(page, info, 'retained-bound-after');
  } finally { await app.close(); await video.saveAs(info.outputPath('retained-bound.webm')); }
});

test('Clear rejects delayed input and query results; intake queue is bounded', async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await fault(app, { delay: 800 });
    await app.evaluate((_electron, message) => {
      const history = globalThis.scopeHistory;
      globalThis.oldConnection = history.status.connectionId;
      globalThis.delayedInspection = history.inspect(1, 3, 5);
      for (let index = 0; index < 100; index++) history.append(1, history.status.connectionId,
        JSON.stringify({ ...message, sequence: index + 10, connection_id: history.status.connectionId }));
    }, source[4]);
    const queued = await state(app);
    expect(queued.peakQueueCount).toBeLessThanOrEqual(32);
    expect(queued.peakQueueBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(queued.localDrops + queued.rateDrops).toBeGreaterThan(0);
    await capture(page, info, 'intake-drops');
    await app.evaluate(async () => { while (globalThis.scopeHistory.sending) await new Promise(resolve => setTimeout(resolve, 10)); });
    await app.evaluate((_electron, message) => {
      const history = globalThis.scopeHistory;
      globalThis.delayedInspection = history.inspect(1, 3, 5);
      history.append(1, history.status.connectionId, JSON.stringify({ ...message, sequence: 1000, connection_id: history.status.connectionId }));
      globalThis.clearResult = history.clear(1);
    }, source[2]);
    await app.evaluate(() => globalThis.clearResult);
    await expect(page.locator('#entries')).toContainText('No synthetic events');
    await page.waitForTimeout(2000);
    expect(await app.evaluate(() => globalThis.delayedInspection)).toEqual({ stale: true });
    expect(await app.evaluate((_electron, message) => globalThis.scopeHistory.append(1, globalThis.oldConnection, JSON.stringify(message)), source[1])).toBe(false);
    await expect(page.locator('#count')).toHaveText('0 retained');
    await expect(page.locator('#json')).toBeEmpty();
    await capture(page, info, 'late-work-rejected');
    await fault(app, { delay: 0 });
    await append(app, 1, 2);
    await expect(page.locator('#count')).toHaveText('1 retained');
    await capture(page, info, 'late-work-recovered');
  } finally { await app.close(); await video.saveAs(info.outputPath('late-work.webm')); }
});

test('cleanup failure isolates old history and exits within its deadline', async ({}, info) => {
  const { app, page, root, video } = await launch(info);
  const old = await fault(app, { cleanup: true });
  try {
    await clear(page);
    await expect(page.locator('#notice')).toContainText('Temporary recording files remain');
    await expect(page.locator('#json')).toBeEmpty();
    expect((await readdir(old.directory)).includes('history.sqlite')).toBe(true);
    await capture(page, info, 'cleanup-failed');
  } finally {
    const started = performance.now();
    await app.close();
    expect(performance.now() - started).toBeLessThan(6000);
    await video.saveAs(info.outputPath('cleanup-failure.webm'));
  }
  const recovered = await launch(info, { root });
  try {
    expect(await stat(old.directory).then(() => true, () => false)).toBe(false);
    await expect(recovered.page.locator('#count')).toHaveText('5 retained');
    await capture(recovered.page, info, 'cleanup-recovered');
  } finally { await recovered.app.close(); await recovered.video.saveAs(info.outputPath('cleanup-recovery.webm')); }
});

test('single owner, private files, hidden capture, crash cleanup and normal-close deletion', async ({}, info) => {
  const { app, page, root, video } = await launch(info, { continuous: true });
  let killed = false;
  try {
    const details = await fault(app, {});
    expect((await stat(path.join(root, 'recordings'))).mode & 0o777).toBe(0o700);
    expect((await stat(details.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(details.directory, 'history.sqlite'))).mode & 0o777).toBe(0o600);
    const child = spawn(electron, [appPath, '--history-test', `--scope-test-root=${root}`], { stdio: 'ignore' });
    expect((await once(child, 'exit'))[0]).toBe(0);
    expect(await stat(details.directory).then(() => true, () => false)).toBe(true);
    await page.locator('#clear').click();
    const before = (await state(app)).accepted;
    const hiddenCount = await page.locator('#count').textContent();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await page.waitForTimeout(2200);
    expect((await state(app)).accepted).toBeGreaterThan(before);
    expect(await page.locator('#count').textContent()).toBe(hiddenCount);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await expect(page.locator('#clear')).toHaveAccessibleName('Unlock Clear history');
    await capture(page, info, 'hidden-resumed');
    const observed = (await state(app)).accepted;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await page.waitForTimeout(1500);
    expect((await state(app)).accepted).toBeGreaterThan(observed);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await capture(page, info, 'minimized-resumed');
    await writeFile(path.join(root, 'settings-sentinel'), 'unrelated settings');
    await mkdir(path.join(root, 'recordings', 'unrelated'));
    await writeFile(path.join(root, 'recordings', 'unrelated', 'keep'), 'unrelated file');
    await symlink(path.join(root, 'recordings', 'unrelated'), path.join(root, 'recordings', 'recording-00000000-0000-0000-0000-000000000000'));
    const process = app.process();
    const exited = once(process, 'exit');
    process.kill('SIGKILL');
    await exited;
    killed = true;
    await video.saveAs(info.outputPath('lifecycle.webm'));
    expect(await stat(details.directory).then(() => true, () => false)).toBe(true);
    const next = await launch(info, { root });
    try {
      expect(await stat(details.directory).then(() => true, () => false)).toBe(false);
      expect(await readFile(path.join(root, 'settings-sentinel'), 'utf8')).toBe('unrelated settings');
      expect(await readFile(path.join(root, 'recordings', 'unrelated', 'keep'), 'utf8')).toBe('unrelated file');
      await capture(next.page, info, 'crash-recovered');
    } finally { await next.app.close(); await next.video.saveAs(info.outputPath('crash-recovery.webm')); }
    const retained = await readdir(path.join(root, 'recordings'));
    expect(retained.sort()).toEqual(['recording-00000000-0000-0000-0000-000000000000', 'unrelated']);
  } finally { if (!killed) { await app.close(); await video.saveAs(info.outputPath('lifecycle.webm')); } }
});

test('a timed-out intake keeps uncertain outcomes separate from known drops', async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await page.locator('[data-event="3"]').click();
    await fault(app, { delay: 3500 });
    await app.evaluate((_electron, message) => {
      const history = globalThis.scopeHistory;
      history.append(1, history.status.connectionId, JSON.stringify({ ...message, sequence: 100, connection_id: history.status.connectionId }));
    }, source[1]);
    await expect(page.locator('#notice')).toContainText('missing events is unknown');
    expect((await state(app)).localDrops).toBe(0);
    await capture(page, info, 'intake-timeout');
    await page.waitForTimeout(1500);
    expect((await state(app)).accepted).toBe(6);
    expect((await state(app)).localDrops).toBe(0);
    await expect(page.locator('#payload')).toHaveAttribute('data-event', '3');
    await capture(page, info, 'intake-timeout-settled');
    const metadata = await page.locator('#metadata').textContent();
    const rows = await page.locator('#entries').textContent();
    const original = await page.locator('#json').textContent();
    await page.locator('[data-event="2"]').click();
    await expect(page.locator('#notice')).toContainText('History operation timed out');
    expect(await page.locator('#metadata').textContent()).toBe(metadata);
    expect(await page.locator('#entries').textContent()).toBe(rows);
    expect(await page.locator('#json').textContent()).toBe(original);
    await capture(page, info, 'query-timeout');
    await fault(app, { delay: 0 });
    await page.locator('[data-event="2"]').click();
    await expect(page.locator('#payload')).toHaveAttribute('data-event', '2');
    await capture(page, info, 'query-recovered');
  } finally { await app.close(); await video.saveAs(info.outputPath('intake-timeout.webm')); }
});
