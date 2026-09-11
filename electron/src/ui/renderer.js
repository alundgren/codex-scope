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
    document.querySelector('#notice').textContent = result.error;
    document.querySelector('#metadata').textContent = 'No payload selected';
    entries.replaceChildren(element('p', 'empty', 'Synthetic recording unavailable.'));
    return;
  }
  const focusedId = document.activeElement?.dataset.event;
  document.querySelector('#count').textContent = `${result.total} fixture${result.total === 1 ? '' : 's'}`;
  const rejected = Object.values(result.drops).reduce((sum, count) => sum + count, 0);
  document.querySelector('#notice').textContent = rejected ?
    `${rejected} synthetic event${rejected === 1 ? '' : 's'} rejected · ${result.drops.oversized} oversized, ${result.drops.invalid} invalid, ${result.drops.capacity} over capacity.` : '';
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
    button.addEventListener('click', () => requestInspection(item.id));
    return button;
  }));
  if (!result.total) entries.append(element('p', 'empty', 'No synthetic events in this recording.'));
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
  document.querySelector('#oldest').textContent = result.rows[0] ? time(result.rows[0].receivedAt) : '';
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
  wanted = { id, rows: rowCount() };
  lastRows = wanted.rows;
  if (loading) return;
  loading = true;
  try {
    while (wanted) {
      const request = wanted;
      wanted = null;
      const result = await window.scope.inspect(request.id, request.rows);
      if (!wanted) render(result);
    }
  } catch {
    document.querySelector('#notice').textContent = 'The payload could not be opened. Select an event to try again.';
  } finally { loading = false; }
}
copy.addEventListener('click', async () => {
  if (selectedId === null || copyPending) return;
  const id = selectedId;
  copyPending = true;
  copy.disabled = true;
  status.textContent = '';
  const success = await window.scope.copyPayload(id);
  copyPending = false;
  copy.disabled = selectedId === null;
  if (selectedId !== id) return;
  copy.textContent = success ? 'Copied' : 'Copy JSON';
  status.textContent = success ? '' : 'Copy failed. Try Copy JSON again, or select and copy the original text.';
});
new ResizeObserver(() => { if (rowCount() !== lastRows) requestInspection(); }).observe(entries);
requestInspection();
