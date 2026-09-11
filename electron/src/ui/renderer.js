import { attachScrollbar } from './scrollbar.js';

const entries = document.querySelector('#entries');
const payload = document.querySelector('#payload');
const json = document.querySelector('#json');
const copy = document.querySelector('#copy');
const status = document.querySelector('#copy-status');
const updateScroll = attachScrollbar(payload, document.querySelector('#scrollbar'), document.querySelector('#thumb'));
let selectedId = null;
let wanted = null;
let loading = false;
let copyPending = false;
let lastRows = 0;
let generation = 1;
let latest = { total: 0, accepted: 0, drops: {} };
let live = true;
let heldAt = 0;
let clearPending = false;
let clearDeadline = 0;
let clearTimer;
let activationKey = null;
let evictionNotice = '';
const clear = document.querySelector('#clear');
const liveButton = document.querySelector('#live');
const lock = document.querySelector('.clear svg path');
const clearLabel = document.querySelector('#clear-label');
function relock() {
  clearDeadline = 0;
  clearTimeout(clearTimer);
  clear.classList.remove('unlocked');
  clearLabel.textContent = 'Clear';
  clear.setAttribute('aria-label', 'Unlock Clear history');
  lock.setAttribute('d', 'M6 9V6a4 4 0 0 1 8 0v3');
}
function summary(value) {
  latest = value;
  const parts = [];
  if (value.error) parts.push(value.error);
  if (value.pressure) parts.push('Storage pressure. Incoming events are being dropped. Available history remains readable.');
  if (evictionNotice) parts.push(evictionNotice);
  if (value.unknownGap) parts.push('Intake timed out. The number of missing events is unknown.');
  const reasons = Object.entries(value.drops ?? {}).filter(([, count]) => count).map(([reason, count]) => `${count} ${reason}`);
  if (value.localDrops) reasons.push(`${value.localDrops} intake capacity`);
  if (value.rateDrops) reasons.push(`${value.rateDrops} intake rate`);
  if (reasons.length) parts.push(`Known local drops: ${reasons.join(', ')}.`);
  document.querySelector('#notice').textContent = parts.join(' ');
  document.querySelector('#mode').textContent = live ? 'Live' : 'History · position held';
  liveButton.setAttribute('aria-pressed', String(live));
  const arrivals = live ? 0 : Math.max(0, value.accepted - heldAt);
  document.querySelector('#count').textContent = `${value.total} retained${arrivals ? ` · ${arrivals} new` : ''}`;
  clear.disabled = !value.total || clearPending || !!value.clearing;
  liveButton.disabled = !!value.clearing;
}
function empty() {
  selectedId = null;
  wanted = null;
  json.textContent = '';
  payload.scrollTop = 0;
  payload.dataset.event = 'null';
  entries.replaceChildren(element('p', 'empty', 'No synthetic events have arrived.'));
  document.querySelector('#metadata').textContent = 'No payload selected';
  document.querySelector('#pin').hidden = true;
  document.querySelector('#ticks').replaceChildren();
  document.querySelector('#oldest').textContent = '';
  status.textContent = '';
  copy.disabled = true;
  copy.textContent = 'Copy JSON';
  updateScroll();
}
function receive(value) {
  if (value.generation < generation) return;
  if (value.generation !== generation) {
    generation = value.generation;
    live = true;
    heldAt = 0;
    evictionNotice = '';
    relock();
    empty();
  }
  const changed = value.accepted !== latest.accepted || value.total !== latest.total;
  summary(value);
  if (document.hidden || clearPending || value.clearing) return;
  if (selectedId !== null && value.first && selectedId < value.first.id) {
    evictionNotice = 'The selected event was evicted. Showing the nearest retained event.';
    requestInspection(value.first.id);
  } else if (live && changed) requestInspection(null);
}

const time = iso => iso.slice(11, 19);
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function rowCount() {
  return Math.max(3, Math.min(5, Math.floor((entries.clientHeight - 20) / (innerWidth <= 720 ? 70 : innerWidth <= 1050 ? 128 : 124))));
}
function render(result) {
  if (result.error) {
    if (selectedId === null) {
      empty();
      entries.replaceChildren(element('p', 'empty', 'Synthetic recording unavailable.'));
    }
    document.querySelector('#notice').textContent = result.error;
    document.documentElement.dataset.ready = 'true';
    return;
  }
  const focusedId = document.activeElement?.dataset.event;
  if (result.selectionEvicted) evictionNotice = 'The selected event was evicted. Showing the nearest retained event.';
  summary(result.accepted >= latest.accepted ? result : latest);
  entries.replaceChildren(...result.rows.map(item => {
    const button = element('button', 'event', '');
    button.dataset.event = String(item.id);
    button.setAttribute('aria-pressed', String(item.id === result.selected?.id));
    const line = element('span', 'eventline', '');
    const stamp = element('time', '', time(item.receivedAt));
    stamp.dateTime = item.receivedAt;
    stamp.title = `${item.receivedAt} UTC`;
    line.append(element('span', 'hook', item.hook), stamp);
    button.append(line, element('span', 'preview', item.preview), element('span', 'eventsession mono', item.session ?? 'No session'));
    button.addEventListener('click', () => { live = false; heldAt = latest.accepted; evictionNotice = ''; summary(latest); requestInspection(item.id); });
    return button;
  }));
  if (!result.total) entries.append(element('p', 'empty', 'No synthetic events have arrived.'));
  if (focusedId) entries.querySelector(`[data-event="${focusedId}"]`)?.focus({ preventScroll: true });
  const event = result.selected;
  if ((event?.id ?? null) !== selectedId) {
    selectedId = event?.id ?? null;
    json.textContent = event?.text ?? '';
    payload.scrollTop = 0;
    payload.dataset.event = String(selectedId);
    status.textContent = '';
    copy.textContent = 'Copy JSON';
  }
  const metadata = document.querySelector('#metadata');
  metadata.replaceChildren();
  if (event) {
    const identity = element('span', 'identity', '');
    identity.append(element('span', 'stamp', `${time(event.receivedAt)} UTC · `),
      element('span', 'session', event.session ?? 'No session'));
    const details = element('span', 'mono details', '');
    details.append(element('span', 'tool', event.tool ?? event.hook), element('span', 'bytes', ` · ${event.bytes} bytes`));
    metadata.append(identity, details);
    metadata.title = event.receivedAt;
  } else metadata.textContent = 'No payload selected';
  copy.disabled = !event || copyPending;
  document.querySelector('#oldest').textContent = result.first ? time(result.first.receivedAt) : '';
  const ticks = document.querySelector('#ticks');
  ticks.replaceChildren(...result.rows.map((item, index) => {
    const tick = element('i', 'tick', '');
    tick.style.top = `${index / Math.max(1, result.rows.length - 1) * 100}%`;
    return tick;
  }));
  document.querySelector('#pin').hidden = !event;
  document.querySelector('#pin').style.top = `${Math.max(0, result.rows.findIndex(item => item.id === selectedId)) / Math.max(1, result.rows.length - 1) * 100}%`;
  updateScroll();
  document.documentElement.dataset.ready = 'true';
}
async function requestInspection(id = selectedId) {
  wanted = { generation, id, rows: rowCount() };
  lastRows = wanted.rows;
  if (loading) return;
  loading = true;
  try {
    while (wanted) {
      const request = wanted;
      wanted = null;
      const result = await window.scope.inspect(request.generation, request.id, request.rows);
      if (!wanted && !result.stale && request.generation === generation && !clearPending) render(result);
    }
  } catch {
    document.querySelector('#notice').textContent = 'The payload could not be opened. Select an event to try again.';
  } finally { loading = false; }
}
copy.addEventListener('click', async () => {
  if (selectedId === null || copyPending) return;
  const id = selectedId;
  const copyGeneration = generation;
  copyPending = true;
  copy.disabled = true;
  status.textContent = '';
  const success = await window.scope.copyPayload(copyGeneration, id);
  copyPending = false;
  copy.disabled = selectedId === null;
  if (selectedId !== id || generation !== copyGeneration) return;
  copy.textContent = success ? 'Copied' : 'Copy JSON';
  status.textContent = success ? '' : 'Copy failed. Try Copy JSON again, or select and copy the original text.';
});
async function activateClear() {
  if (clear.disabled || clearPending) return;
  const now = performance.now();
  if (!clearDeadline || now >= clearDeadline) {
    relock();
    clearDeadline = now + 3000;
    clear.classList.add('unlocked');
    clearLabel.textContent = 'Clear?';
    clear.setAttribute('aria-label', 'Confirm Clear history');
    lock.setAttribute('d', 'M6 9V6a4 4 0 0 1 8 0');
    clearTimer = setTimeout(relock, 3000);
    return;
  }
  relock();
  clearPending = true;
  clear.disabled = true;
  const oldGeneration = generation;
  generation++;
  live = true;
  heldAt = 0;
  evictionNotice = '';
  empty();
  try {
    const result = await window.scope.clear(oldGeneration);
    if (result.error) document.querySelector('#notice').textContent = result.error;
    const value = await window.scope.status();
    clearPending = false;
    receive(value);
    if (!value.error) requestInspection(null);
  } catch {
    clearPending = false;
    document.querySelector('#notice').textContent = 'Clear failed. Restart the app to retry cleanup.';
  }
}
clear.addEventListener('click', activateClear);
clear.addEventListener('keydown', event => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  if (event.repeat || activationKey) return;
  activationKey = event.key;
  activateClear();
});
document.addEventListener('keyup', event => { if (event.key === activationKey) activationKey = null; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') relock(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) relock();
  else window.scope.status().then(receive);
});
window.scope.onHidden(relock);
liveButton.addEventListener('click', () => { live = true; heldAt = 0; evictionNotice = ''; summary(latest); requestInspection(null); });
new ResizeObserver(() => { if (rowCount() !== lastRows && !clearPending) requestInspection(live ? null : selectedId); }).observe(entries);
window.scope.onStatus(receive);
window.scope.status().then(value => { receive(value); requestInspection(null); });
