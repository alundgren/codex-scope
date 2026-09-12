import { attachScrollbar } from './scrollbar.js';
import { attachFilters } from './filters.js';

const entries = document.querySelector('#entries');
const payload = document.querySelector('#payload');
const json = document.querySelector('#json');
const copy = document.querySelector('#copy');
const status = document.querySelector('#copy-status');
const scrubber = document.querySelector('#scrubber');
const updateScroll = attachScrollbar(payload, document.querySelector('#scrollbar'), document.querySelector('#thumb'));
let selectedId = null, selectedText = '', selectedValue = '';
let wanted = null, loading = false, copyPending = false;
let lastRows = 0, generation = 1, queryId = 1, targetId = 0;
let latest = { total: 0, accepted: 0, drops: {} };
let live = true, heldAt = 0, position = 0, displayed = null;
let clearPending = false, clearDeadline = 0, clearTimer, activationKey = null;
let queryFailed = false;
let evictionNotice = '', queryNotice = '', filterPending = false, filterTimer;
let gesture = null, pointerPosition = null, pointerFrame = null, reconcileTarget = 0;
const clear = document.querySelector('#clear');
const liveButton = document.querySelector('#live');
const lock = document.querySelector('.clear svg path');
const clearLabel = document.querySelector('#clear-label');
const filters = attachFilters({ getGeneration: () => generation, changed: changeFilter,
  error: text => { queryNotice = text; summary(latest); } });
const time = iso => iso.slice(11, 19);
const activeView = () => latest.view?.queryId === queryId ? latest.view : null;
const hasFilters = () => { const value = filters.value(); return !!value.text || value.session !== null || !!value.hooks.length; };
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className; node.textContent = text;
  return node;
}
function relock() {
  clearDeadline = 0;
  clearTimeout(clearTimer);
  clear.classList.remove('unlocked');
  clearLabel.textContent = 'Clear';
  clear.setAttribute('aria-label', 'Unlock Clear history');
  lock.setAttribute('d', 'M6 9V6a4 4 0 0 1 8 0v3');
}
function navigationSnapshot() {
  const view = activeView();
  return view?.count != null ? { queryId, upper: latest.last?.id ?? 0, count: view.count, removed: view.removed } : null;
}
function positionMarkers() {
  if (document.hidden) return;
  const snapshot = gesture?.snapshot ?? navigationSnapshot();
  const count = snapshot?.count ?? 0;
  const value = live ? count : Math.max(0, Math.min(count - 1, position));
  scrubber.setAttribute('aria-valuemax', String(count));
  scrubber.setAttribute('aria-valuenow', String(Math.max(0, value)));
  scrubber.setAttribute('aria-valuetext', live && count ? 'Live, following new matching events' : selectedValue || 'No matching events');
  scrubber.setAttribute('aria-disabled', String(!count || filterPending || clearPending));
  scrubber.tabIndex = count && !filterPending && !clearPending ? 0 : -1;
  const ticks = document.querySelector('#ticks');
  const tickCount = Math.min(count, 64);
  if (ticks.children.length !== tickCount) ticks.replaceChildren(...Array.from({ length: tickCount }, () => element('i', 'tick', '')));
  for (let index = 0; index < tickCount; index++) ticks.children[index].style.top = `${(tickCount === 1 ? 0 : index / (tickCount - 1) * (count - 1)) / count * 100}%`;
  const pin = document.querySelector('#pin');
  pin.hidden = !count || selectedId === null;
  pin.style.top = `${count ? value / count * 100 : 0}%`;
}
function summary(value) {
  const oldView = activeView();
  if (!gesture && oldView && value.view?.queryId === queryId) position = Math.max(0, position - Math.max(0, value.view.removed - oldView.removed));
  latest = value;
  const parts = [];
  if (value.error) parts.push(value.error);
  if (value.pressure) parts.push('Storage pressure. Incoming events are being dropped. Available history remains readable.');
  if (evictionNotice) parts.push(evictionNotice);
  if (queryNotice) parts.push(queryNotice);
  if (value.unknownGap) parts.push('Intake timed out. The number of missing events is unknown.');
  const reasons = Object.entries(value.drops ?? {}).filter(([, count]) => count).map(([reason, count]) => `${count} ${reason}`);
  if (value.localDrops) reasons.push(`${value.localDrops} intake capacity`);
  if (value.rateDrops) reasons.push(`${value.rateDrops} intake rate`);
  if (reasons.length) parts.push(`Known local drops: ${reasons.join(', ')}.`);
  const notice = document.querySelector('#notice');
  notice.textContent = parts.join(' ');
  if (queryFailed) { const reset = element('button', '', 'Reset filters'); reset.addEventListener('click', filters.reset); notice.append(reset); }
  document.querySelector('#mode').textContent = live ? 'Live' : 'History · position held';
  liveButton.setAttribute('aria-pressed', String(live));
  const view = activeView();
  const count = view?.count ?? (hasFilters() ? null : value.total);
  const arrivals = live || !view ? 0 : Math.max(0, view.arrivals - heldAt);
  const countNode = document.querySelector('#count');
  countNode.textContent = count === null ? queryFailed ? 'Search stopped' : 'Searching…' : `${count} ${hasFilters() ? 'matching' : 'retained'}${arrivals ? ` · ${arrivals} new` : ''}`;
  countNode.dataset.matching = String(count ?? 0);
  countNode.dataset.arrivals = String(arrivals);
  const oldestMatch = gesture?.first ?? view?.first;
  document.querySelector('#oldest').textContent = hasFilters() ? oldestMatch ? time(oldestMatch.receivedAt) : count ? 'Oldest match' : '' : value.first ? time(value.first.receivedAt) : '';
  document.querySelector('#retention').textContent = value.first ? `Retained from ${time(value.first.receivedAt)} UTC · Deleted when the app closes.` : 'Temporary synthetic recording · Waiting for events.';
  clear.disabled = !value.total || clearPending || !!value.clearing;
  liveButton.disabled = !count || filterPending || !!value.clearing;
  positionMarkers();
}
function empty(message = 'No synthetic events have arrived.', reset = false) {
  selectedId = null; selectedText = ''; selectedValue = ''; displayed = null; position = 0;
  json.textContent = ''; payload.scrollTop = 0; payload.dataset.event = 'null';
  const contents = element('div', 'empty', message);
  if (reset) {
    const button = element('button', '', 'Reset filters');
    button.addEventListener('click', filters.reset);
    contents.append(button);
  }
  entries.replaceChildren(contents);
  document.querySelector('#metadata').textContent = 'No payload selected';
  document.querySelector('#pin').hidden = true;
  status.textContent = ''; copy.disabled = true; copy.textContent = 'Copy JSON';
  updateScroll(); positionMarkers(); busy();
}
function busy() { entries.setAttribute('aria-busy', String(loading || filterPending)); }
function cancelWork() {
  wanted = null;
  targetId++;
  window.scope.cancel(generation, targetId);
}
function stopGesture() {
  if (gesture && scrubber.hasPointerCapture(gesture.pointerId)) scrubber.releasePointerCapture(gesture.pointerId);
  gesture = null; pointerPosition = null;
  if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
  pointerFrame = null;
}
function receive(value) {
  if (value.generation < generation) return;
  if (value.generation !== generation) {
    generation = value.generation; queryId++; targetId = 0;
    live = true; heldAt = 0; evictionNotice = ''; queryNotice = '';
    clearTimeout(filterTimer); filterPending = false;
    stopGesture(); cancelWork(); relock(); empty(); filters.refresh();
  }
  const changed = value.accepted !== latest.accepted || value.total !== latest.total;
  summary(value);
  if (document.hidden || clearPending || value.clearing || filterPending) return;
  if (gesture && value.view?.queryId === queryId && value.view.removed !== gesture.snapshot.removed) {
    stopGesture(); cancelWork();
    evictionNotice = 'History used by the drag was evicted. Drag ended; showing the nearest retained match.';
    requestInspection(selectedId);
  } else if (!gesture && selectedId !== null && value.first && selectedId < value.first.id) {
    evictionNotice = 'The selected event was evicted. Showing the nearest retained matching event.';
    requestInspection(selectedId);
  } else if (!gesture && (live && changed || selectedId === null && activeView()?.count > 0)) requestInspection(null);
}
function rowCount() {
  return Math.max(3, Math.min(5, Math.floor((entries.clientHeight - 20) / (innerWidth <= 720 ? 70 : innerWidth <= 1050 ? 128 : 124))));
}
function hold() {
  if (live) heldAt = activeView()?.arrivals ?? 0;
  live = false;
}
function render(result) {
  if (result.error) {
    stopGesture(); reconcileTarget = 0;
    if (displayed?.queryId === queryId) {
      position = Math.max(0, displayed.position - Math.max(0, (activeView()?.removed ?? 0) - displayed.removed));
      live = displayed.live; heldAt = displayed.heldAt;
    }
    queryFailed = true;
    queryNotice = result.error + (selectedId !== null ? ' Previous selection is still shown.' : '');
    if (selectedId === null) empty(result.timedOut ? 'Search timed out.' : 'History could not be searched.', true);
    summary(latest);
    document.documentElement.dataset.ready = 'true';
    return;
  }
  queryNotice = ''; queryFailed = false;
  if (result.selectionEvicted) evictionNotice = 'The selected event was evicted. Showing the nearest retained matching event.';
  const focusedId = document.activeElement?.dataset.event;
  const current = result.accepted >= latest.accepted || !activeView() ? result : latest;
  summary(current);
  position = Math.max(0, result.position - Math.max(0, (activeView()?.removed ?? 0) - result.snapshot.removed));
  const selectedIndex = result.rows.findIndex(item => item.id === result.selected?.id);
  if (!result.selected) empty(result.total ? 'No matching events.' : 'No synthetic events have arrived.', !!result.total);
  else entries.replaceChildren(...result.rows.map((item, index) => {
    const button = element('button', 'event', '');
    button.dataset.event = String(item.id);
    button.setAttribute('aria-pressed', String(item.id === result.selected.id));
    const line = element('span', 'eventline', '');
    const stamp = element('time', '', time(item.receivedAt));
    stamp.dateTime = item.receivedAt; stamp.title = `${item.receivedAt} UTC`;
    line.append(element('span', 'hook', item.hook), stamp);
    button.append(line, element('span', 'preview', item.preview), element('span', 'eventsession mono', item.session ?? 'No session'));
    button.addEventListener('click', () => {
      if (filterPending) return;
      stopGesture(); hold(); position = result.position + index - selectedIndex;
      evictionNotice = ''; summary(latest); requestInspection(item.id);
    });
    return button;
  }));
  if (focusedId) entries.querySelector(`[data-event="${focusedId}"]`)?.focus({ preventScroll: true });
  const event = result.selected;
  if ((event?.id ?? null) !== selectedId || (event?.text ?? '') !== selectedText) {
    selectedId = event?.id ?? null; selectedText = event?.text ?? '';
    json.textContent = selectedText; payload.scrollTop = 0; payload.dataset.event = String(selectedId);
    status.textContent = ''; copy.textContent = 'Copy JSON';
  }
  selectedValue = event ? `${time(event.receivedAt)} UTC, ${event.hook}` : '';
  const metadata = document.querySelector('#metadata');
  metadata.replaceChildren();
  if (event) {
    const identity = element('span', 'identity', '');
    identity.append(element('span', 'stamp', `${time(event.receivedAt)} UTC · `), element('span', 'session', event.session ?? 'No session'));
    const details = element('span', 'mono details', '');
    details.append(element('span', 'tool', event.tool ?? event.hook), element('span', 'bytes', ` · ${event.bytes} bytes`));
    metadata.append(identity, details); metadata.title = event.receivedAt;
  } else metadata.textContent = 'No payload selected';
  copy.disabled = !event || copyPending;
  displayed = event ? { queryId, position, live, heldAt, removed: activeView()?.removed ?? 0 } : null;
  positionMarkers(); updateScroll(); document.documentElement.dataset.ready = 'true';
}
function requestInspection(id = selectedId) { return requestNavigation(id === null && live ? { kind: 'live' } : { kind: 'select', id }); }
async function requestNavigation(target) {
  if (filterPending || clearPending) return;
  targetId++;
  wanted = { generation, queryId, targetId, filter: filters.value(), target, rows: rowCount() };
  lastRows = wanted.rows;
  window.scope.cancel(generation, targetId);
  if (loading) return;
  loading = true; busy();
  try {
    while (wanted) {
      const request = wanted; wanted = null;
      let result;
      try { result = await window.scope.navigate(request.generation, request); }
      catch { result = { error: 'The event could not be opened. Select an event to try again.' }; }
      if (wanted || result.stale || request.generation !== generation || request.queryId !== queryId || request.targetId !== targetId || clearPending) continue;
      if (result.snapshotLost) {
        stopGesture(); evictionNotice = 'History used by the drag was evicted. Drag ended; showing the nearest retained match.';
        requestInspection(selectedId); continue;
      }
      if (result.selected && latest.first && result.rows.some(row => row.id < latest.first.id)) {
        if (result.selected.id < latest.first.id) evictionNotice = 'The requested event was evicted. Showing the nearest retained matching event.';
        requestInspection(result.selected.id); continue;
      }
      render(result);
      if (!result.error && !result.selected && activeView()?.count > 0) requestInspection(null);
      if (request.targetId === reconcileTarget && !result.error) { reconcileTarget = 0; requestInspection(live ? null : selectedId); }
    }
  } finally { loading = false; busy(); }
}
function changeFilter(_value, delay) {
  queryId++; heldAt = 0; evictionNotice = ''; queryNotice = 'Searching…'; queryFailed = false;
  stopGesture(); cancelWork(); clearTimeout(filterTimer);
  filterPending = true; busy(); summary(latest);
  filterTimer = setTimeout(() => { filterPending = false; requestInspection(live ? null : selectedId); }, delay);
}
function seek(rank, snapshot = navigationSnapshot()) {
  if (!snapshot?.count || filterPending || clearPending) return;
  const next = Math.max(0, Math.min(snapshot.count, Math.round(rank)));
  if (next === snapshot.count) { live = true; heldAt = 0; } else hold();
  position = next; evictionNotice = ''; summary(latest);
  requestNavigation({ kind: live ? 'live' : 'rank', rank: next, snapshot });
}
function movePointer() {
  pointerFrame = null;
  if (!gesture || pointerPosition === null) return;
  seek((pointerPosition - gesture.top) / gesture.height * gesture.snapshot.count, gesture.snapshot);
}
scrubber.addEventListener('pointerdown', event => {
  const snapshot = navigationSnapshot();
  if (!snapshot?.count || filterPending || clearPending || event.button !== 0) return;
  const rect = scrubber.getBoundingClientRect();
  gesture = { snapshot, first: activeView()?.first, pointerId: event.pointerId, top: rect.top, height: rect.height };
  scrubber.setPointerCapture(event.pointerId); scrubber.focus(); pointerPosition = event.clientY; movePointer();
});
scrubber.addEventListener('pointermove', event => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  pointerPosition = event.clientY;
  if (pointerFrame === null) pointerFrame = requestAnimationFrame(movePointer);
});
function releasePointer(event) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  pointerPosition = event.clientY;
  if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
  movePointer();
  const finalTarget = targetId;
  stopGesture();
  if (loading) reconcileTarget = finalTarget; else requestInspection(live ? null : selectedId);
}
scrubber.addEventListener('pointerup', releasePointer);
scrubber.addEventListener('pointercancel', event => { if (gesture?.pointerId === event.pointerId) { stopGesture(); cancelWork(); requestInspection(live ? null : selectedId); } });
scrubber.addEventListener('keydown', event => {
  const snapshot = navigationSnapshot();
  const current = live ? snapshot?.count : position;
  const moves = { ArrowUp: current - 1, ArrowLeft: current - 1, ArrowDown: current + 1, ArrowRight: current + 1,
    PageUp: current - 5, PageDown: current + 5, Home: 0, End: snapshot?.count };
  if (event.key in moves) { event.preventDefault(); seek(moves[event.key], snapshot); }
});
let wheelAt = -Infinity;
document.querySelector('.journal').addEventListener('wheel', event => {
  event.preventDefault();
  if (!event.deltaY || performance.now() - wheelAt < 80) return;
  wheelAt = performance.now();
  const snapshot = navigationSnapshot();
  seek((live ? snapshot?.count : position) + Math.sign(event.deltaY), snapshot);
}, { passive: false });
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
  clearTimeout(filterTimer); filterPending = false; queryId++; targetId = 0;
  stopGesture(); cancelWork(); queryNotice = ''; queryFailed = false; empty();
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
window.scope.onHidden(() => { relock(); stopGesture(); });
liveButton.addEventListener('click', () => { stopGesture(); live = true; heldAt = 0; evictionNotice = ''; summary(latest); requestInspection(null); });
new ResizeObserver(() => {
  positionMarkers();
  if (rowCount() !== lastRows && !clearPending && !gesture && !filterPending) requestInspection(live ? null : selectedId);
}).observe(entries);
window.scope.onStatus(receive);
window.scope.status().then(value => { receive(value); requestInspection(null); filters.refresh(); });
