import { _electron, expect } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
export const source = (await readFile('fixtures/journal.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
export const state = app => app.evaluate(() => globalThis.scopeHistory.snapshot());
export const fault = (app, faults) => app.evaluate((_electron, faults) => globalThis.scopeHistory.call('test', { faults }), faults);
export async function launch(info) {
  const root = await mkdtemp('/tmp/scope-navigation-test-');
  const app = await _electron.launch({ args: [path.resolve('dist/app'), '--history-test', '--fixtures-only', `--scope-test-root=${root}`], chromiumSandbox: true,
    ...info ? { recordVideo: { dir: info.outputPath('video'), size: { width: 1180, height: 820 } } } : {} });
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.locator('#count')).toHaveText('5 retained');
  return { app, page, video: page.video(), root };
}
export const capture = async (page, info, name) => {
  await page.mouse.move(1, 1); await page.waitForTimeout(250);
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
};
export function frame({ hook = 'PreToolUse', session = 'navigation-session', message = 'Synthetic event', tail = '', index = 0 } = {}) {
  const payload = JSON.stringify({ hook_event_name: hook, session_id: session, message, unknown_tail: tail, synthetic_index: index }, null, 2);
  return { type: 'event', hook_type: hook, session_id: session, tool_name: null, received_at: new Date(Date.UTC(2026, 8, 11, 16, 0, 0) - index * 1000).toISOString(), payload, payload_bytes: Buffer.byteLength(payload) };
}
export async function append(app, frames, delay = 20) {
  await app.evaluate(async (_electron, { frames, delay }) => {
    const history = globalThis.scopeHistory;
    let sequence = globalThis.navigationSequence ?? history.status.accepted + 100;
    for (const message of frames) {
      if (!history.append(history.generation, history.status.connectionId,
        JSON.stringify({ ...message, connection_id: history.status.connectionId, sequence: sequence++ }))) throw new Error('Synthetic test input was not admitted.');
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    globalThis.navigationSequence = sequence;
    const deadline = performance.now() + 8000;
    while (history.sending && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (history.sending) throw new Error('Synthetic intake did not settle.');
  }, { frames, delay });
}
export const selected = page => page.locator('#payload').getAttribute('data-event');
export const expectSelected = (page, id) => expect(page.locator('#payload')).toHaveAttribute('data-event', String(id));
export async function search(page, text) {
  await page.locator('#search').fill(text);
  await expect(page.locator('#notice')).not.toContainText('Searching…');
}
export async function touchDrag(page, x, from, to) {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
  for (let step = 1; step <= 8; step++) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * step / 8 }] });
    await page.waitForTimeout(25);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await client.detach();
}
