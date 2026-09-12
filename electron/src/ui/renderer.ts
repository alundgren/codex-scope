import { attachTools } from "./tools.ts";
import { attachAnalysis } from "./analysis.ts";
import type {
  HistoryStatus,
  NavigationRequest,
  NavigationTarget,
  NavigationSnapshot,
  Navigation,
  Reply,
  Filter,
  EventPosition,
} from "../types.ts";
import { requiredElement } from "./elements.ts";
import { attachScrollbar } from "./scrollbar.ts";
import { attachFilters } from "./filters.ts";

const entries = requiredElement("#entries");
const payload = requiredElement("#payload");
const json = requiredElement("#json");
const copy = requiredElement<HTMLButtonElement>("#copy");
const status = requiredElement("#copy-status");
const scrubber = requiredElement("#scrubber");
const updateScroll = attachScrollbar(
  payload,
  requiredElement("#scrollbar"),
  requiredElement("#thumb"),
);
let selectedId: number | null = null,
  selectedText = "",
  selectedValue = "";
let wanted: (NavigationRequest & { generation: number }) | null = null,
  loading = false,
  copyPending = false;
let lastRows = 0,
  generation = 1,
  queryId = 1,
  targetId = 0;
let latest: HistoryStatus = {
  generation: 1,
  total: 0,
  accepted: 0,
  drops: {},
  first: null,
  last: null,
};
let live = true,
  heldAt = 0,
  position = 0;
let displayed: {
  queryId: number;
  position: number;
  live: boolean;
  heldAt: number;
  removed: number;
} | null = null;
let clearPending = false,
  clearDeadline = 0,
  clearTimer: ReturnType<typeof setTimeout> | undefined,
  activationKey: string | null = null;
let queryFailed = false;
let evictionNotice = "",
  queryNotice = "",
  filterPending = false,
  filterTimer: ReturnType<typeof setTimeout> | undefined;
let gesture: {
  snapshot: NavigationSnapshot;
  first?: EventPosition | null;
  pointerId: number;
  top: number;
  height: number;
} | null = null;
let pointerPosition: number | null = null,
  pointerFrame: number | null = null,
  reconcileTarget = 0;
const clear = requiredElement<HTMLButtonElement>("#clear");
const liveButton = requiredElement<HTMLButtonElement>("#live");
const lock = requiredElement(".clear svg path");
const clearLabel = requiredElement("#clear-label");
const filters = attachFilters({
  getGeneration: () => generation,
  changed: changeFilter,
  error: (text) => {
    queryNotice = text;
    summary(latest);
  },
});
const time = (iso: string) => iso.slice(11, 19);
const activeView = () => (latest.view?.queryId === queryId ? latest.view : null);
const hasFilters = () => {
  const value = filters.value();
  return !!value.text || value.session !== null || !!value.hooks.length;
};
function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string,
  text: string | null,
) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function relock() {
  clearDeadline = 0;
  clearTimeout(clearTimer);
  clear.classList.remove("unlocked");
  clearLabel.textContent = "Clear";
  clear.setAttribute("aria-label", "Unlock Clear history");
  lock.setAttribute("d", "M6 9V6a4 4 0 0 1 8 0v3");
}
function navigationSnapshot() {
  const view = activeView();
  return view?.count != null
    ? { queryId, upper: latest.last?.id ?? 0, count: view.count, removed: view.removed }
    : null;
}
function positionMarkers() {
  if (document.hidden || document.body.classList.contains("tool-open")) return;
  const snapshot = gesture?.snapshot ?? navigationSnapshot();
  const count = snapshot?.count ?? 0;
  const value = live ? count : Math.max(0, Math.min(count - 1, position));
  scrubber.setAttribute("aria-valuemax", String(count));
  scrubber.setAttribute("aria-valuenow", String(Math.max(0, value)));
  scrubber.setAttribute(
    "aria-valuetext",
    live && count ? "Live, following new matching events" : selectedValue || "No matching events",
  );
  scrubber.setAttribute(
    "aria-disabled",
    String(!count || filterPending || clearPending || !!latest.error),
  );
  scrubber.tabIndex = count && !filterPending && !clearPending && !latest.error ? 0 : -1;
  const ticks = requiredElement("#ticks");
  const tickCount = Math.min(count, 64);
  if (ticks.children.length !== tickCount)
    ticks.replaceChildren(...Array.from({ length: tickCount }, () => element("i", "tick", "")));
  for (let index = 0; index < tickCount; index++)
    (ticks.children[index] as HTMLElement).style.top =
      `${((tickCount === 1 ? 0 : (index / (tickCount - 1)) * (count - 1)) / count) * 100}%`;
  const pin = requiredElement("#pin");
  pin.hidden = !count || selectedId === null;
  pin.style.top = `${count ? (value / count) * 100 : 0}%`;
}
function summary(value: HistoryStatus) {
  const oldView = activeView();
  if (!gesture && oldView && value.view?.queryId === queryId)
    position = Math.max(0, position - Math.max(0, value.view.removed - oldView.removed));
  latest = value;
  const parts = [];
  const transport = value.transport;
  const connectionLabels = {
    connecting: "Connecting…",
    connected: "Connected",
    disconnected: "Disconnected",
  };
  const connection = requiredElement(".connection");
  const connectionText =
    value.capturing === false
      ? "Stopped"
      : transport
        ? (connectionLabels[transport.state] ?? "Disconnected")
        : value.starting
          ? "Starting…"
          : "Synthetic data";
  if (connection.textContent !== connectionText) connection.textContent = connectionText;
  const connectionReasons: Partial<
    Record<NonNullable<HistoryStatus["transport"]>["reason"] & string, string>
  > = {
    auth: "Authentication failed. Open Settings, check the token, then Start capture.",
    version: "Unsupported collector version. Update the collector or viewer, then restart the app.",
    config:
      "Connection settings could not be read. Open Settings and save a valid origin URL and token.",
    tls: "Secure connection failed. Check the certificate and URL in Settings, then Start capture.",
    endpoint: "Collector endpoint rejected the request. Check Settings, then Start capture.",
    conflict: "Another viewer is connected or this connection expired. Retrying.",
    busy: "Collector is busy. Retrying.",
    protocol: "Collector sent invalid stream data. Reconnecting.",
    frame: "Collector sent an oversized stream frame. Reconnecting.",
    rate: "Stream exceeded the intake rate limit. Reconnecting.",
    stalled: "Intake stopped making progress. Reconnecting when processing finishes.",
    disconnected: "Connection lost. Reconnecting.",
  };
  if (transport?.reason && connectionReasons[transport.reason])
    parts.push(connectionReasons[transport.reason]!);
  if (transport?.coverageUnknown)
    parts.push(
      "Coverage before connection and across gaps is unknown. Missing events cannot be recovered.",
    );
  if (transport?.collectorTotals) {
    const totals = Object.entries(transport.collectorTotals)
      .filter(([, count]) => count)
      .map(([reason, count]) => `${count} ${reason}`);
    if (totals.length) parts.push(`Collector lifetime drops: ${totals.join(", ")}.`);
  }
  if (value.error) parts.push(value.error);
  if (value.pressure)
    parts.push(
      "Storage pressure. Incoming events are being dropped. Available history remains readable.",
    );
  if (evictionNotice) parts.push(evictionNotice);
  if (queryNotice) parts.push(queryNotice);
  if (value.unknownGap) parts.push("Intake timed out. The number of missing events is unknown.");
  const reasons = Object.entries(value.drops ?? {})
    .filter(([, count]) => count)
    .map(([reason, count]) => `${count} ${reason}`);
  if (value.localDrops) reasons.push(`${value.localDrops} intake capacity`);
  if (value.rateDrops) reasons.push(`${value.rateDrops} intake rate`);
  if (reasons.length) parts.push(`Known local drops: ${reasons.join(", ")}.`);
  const notice = requiredElement("#notice");
  const noticeText = parts.join(" ");
  if (notice.dataset.message !== noticeText || notice.dataset.failed !== String(queryFailed)) {
    notice.dataset.message = noticeText;
    notice.dataset.failed = String(queryFailed);
    notice.textContent = noticeText;
    if (queryFailed) {
      const reset = element("button", "", "Reset filters");
      reset.addEventListener("click", filters.reset);
      notice.append(reset);
    }
    notice.tabIndex = notice.scrollHeight > notice.clientHeight ? 0 : -1;
  }
  const mode = requiredElement("#mode"),
    modeText = live ? "Live" : "History · position held";
  if (mode.textContent !== modeText) mode.textContent = modeText;
  liveButton.setAttribute("aria-pressed", String(live));
  const view = activeView();
  const count = view?.count ?? (hasFilters() ? null : value.total);
  const arrivals = live || !view ? 0 : Math.max(0, view.arrivals - heldAt);
  const countNode = requiredElement("#count");
  countNode.textContent =
    count === null
      ? value.error
        ? "History unavailable"
        : queryFailed
          ? "Search stopped"
          : "Searching…"
      : `${count} ${hasFilters() ? "matching" : "retained"}${arrivals ? ` · ${arrivals} new` : ""}`;
  countNode.dataset.matching = String(count ?? 0);
  countNode.dataset.arrivals = String(arrivals);
  const oldestMatch = gesture?.first ?? view?.first;
  requiredElement("#oldest").textContent = hasFilters()
    ? oldestMatch
      ? time(oldestMatch.receivedAt)
      : count
        ? "Oldest match"
        : ""
    : value.first
      ? time(value.first.receivedAt)
      : "";
  requiredElement("#retention").textContent = value.first
    ? `Retained from ${time(value.first.receivedAt)} UTC · Deleted when the app closes.`
    : transport || value.starting
      ? "Temporary recording · Waiting for events."
      : "Temporary synthetic recording · Waiting for events.";
  clear.disabled = !value.total || clearPending || !!value.clearing || !!value.error;
  liveButton.disabled =
    !count || filterPending || clearPending || !!value.clearing || !!value.error;
  copy.disabled = selectedId === null || copyPending || !!value.error;
  filters.disable(!!value.error || !!value.clearing);
  for (const button of entries.querySelectorAll("button"))
    button.disabled = clearPending || !!value.clearing || !!value.error;
  positionMarkers();
}
function empty(
  message = latest.transport ? "No events have arrived." : "No synthetic events have arrived.",
  reset = false,
) {
  selectedId = null;
  selectedText = "";
  selectedValue = "";
  displayed = null;
  position = 0;
  json.textContent = "";
  payload.scrollTop = 0;
  payload.dataset.event = "null";
  const contents = element("div", "empty", message);
  if (reset) {
    const button = element("button", "", "Reset filters");
    button.addEventListener("click", filters.reset);
    contents.append(button);
  }
  entries.replaceChildren(contents);
  requiredElement("#metadata").textContent = "No payload selected";
  requiredElement("#pin").hidden = true;
  status.textContent = "";
  copy.disabled = true;
  copy.textContent = "Copy JSON";
  updateScroll();
  positionMarkers();
  busy();
}
function busy() {
  entries.setAttribute("aria-busy", String(!latest.error && (loading || filterPending)));
}
function cancelWork() {
  wanted = null;
  targetId++;
  window.scope.cancel(generation, targetId);
}
function stopGesture() {
  if (gesture && scrubber.hasPointerCapture(gesture.pointerId))
    scrubber.releasePointerCapture(gesture.pointerId);
  gesture = null;
  pointerPosition = null;
  if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
  pointerFrame = null;
}
function receive(value: HistoryStatus) {
  if (value.generation < generation) return;
  const cleared = !!latest.clearing && !value.clearing;
  const newGeneration = value.generation !== generation;
  analyzer.receive(value);
  if (newGeneration) {
    generation = value.generation;
    queryId++;
    targetId = 0;
    live = true;
    heldAt = 0;
    evictionNotice = "";
    queryNotice = "";
    clearTimeout(filterTimer);
    filterPending = false;
    stopGesture();
    cancelWork();
    relock();
    empty();
  }
  const changed = cleared || value.accepted !== latest.accepted || value.total !== latest.total;
  if (value.error) {
    queryNotice = "";
    queryFailed = false;
    clearTimeout(filterTimer);
    filterPending = false;
    stopGesture();
    cancelWork();
    relock();
  }
  summary(value);
  if ((newGeneration || cleared) && !value.clearing && !value.error) filters.refresh();
  tools.receive(value);
  if (!value.starting) document.documentElement.dataset.ready = "true";
  if (value.error) {
    busy();
    if (selectedId === null) empty("Temporary history is unavailable.");
    document.documentElement.dataset.ready = "true";
    return;
  }
  if (
    document.hidden ||
    document.body.classList.contains("tool-open") ||
    clearPending ||
    value.clearing ||
    filterPending
  )
    return;
  if (
    gesture &&
    value.view?.queryId === queryId &&
    value.view.removed !== gesture.snapshot.removed
  ) {
    stopGesture();
    cancelWork();
    evictionNotice =
      "History used by the drag was evicted. Drag ended; showing the nearest retained match.";
    requestInspection(selectedId);
  } else if (!gesture && selectedId !== null && value.first && selectedId < value.first.id) {
    evictionNotice = "The selected event was evicted. Showing the nearest retained matching event.";
    requestInspection(selectedId);
  } else if (
    !gesture &&
    ((live && changed) || (selectedId === null && (activeView()?.count ?? 0) > 0))
  )
    requestInspection(null);
}
function rowCount() {
  return Math.max(
    3,
    Math.min(
      5,
      Math.floor(
        (entries.clientHeight - 20) / (innerWidth <= 720 ? 70 : innerWidth <= 1050 ? 128 : 124),
      ),
    ),
  );
}
function hold() {
  if (live) heldAt = activeView()?.arrivals ?? 0;
  live = false;
}
function render(result: Reply<Navigation>) {
  if (!("rows" in result)) {
    if (!result.error) return;
    stopGesture();
    reconcileTarget = 0;
    if (displayed?.queryId === queryId) {
      position = Math.max(
        0,
        displayed.position - Math.max(0, (activeView()?.removed ?? 0) - displayed.removed),
      );
      live = displayed.live;
      heldAt = displayed.heldAt;
    }
    queryFailed = true;
    queryNotice = result.error + (selectedId !== null ? " Previous selection is still shown." : "");
    if (selectedId === null)
      empty(result.timedOut ? "Search timed out." : "History could not be searched.", true);
    summary(latest);
    document.documentElement.dataset.ready = "true";
    return;
  }
  queryNotice = "";
  queryFailed = false;
  if (result.selectionEvicted)
    evictionNotice = "The selected event was evicted. Showing the nearest retained matching event.";
  const focusedId = (document.activeElement as HTMLElement | null)?.dataset.event;
  const current = result.accepted >= latest.accepted || !activeView() ? result : latest;
  summary(current);
  position = Math.max(
    0,
    result.position - Math.max(0, (activeView()?.removed ?? 0) - result.snapshot.removed),
  );
  const selectedIndex = result.rows.findIndex((item) => item.id === result.selected?.id);
  if (!result.selected)
    empty(
      result.total
        ? "No matching events."
        : latest.transport
          ? "No events have arrived."
          : "No synthetic events have arrived.",
      !!result.total,
    );
  else
    entries.replaceChildren(
      ...result.rows.map((item, index) => {
        const button = element("button", "event", "");
        button.dataset.event = String(item.id);
        button.setAttribute("aria-pressed", String(item.id === result.selected!.id));
        const line = element("span", "eventline", "");
        const stamp = element("time", "", time(item.receivedAt));
        stamp.dateTime = item.receivedAt;
        stamp.title = `${item.receivedAt} UTC`;
        line.append(element("span", "hook", item.hook), stamp);
        button.append(
          line,
          element("span", "preview", item.preview),
          element("span", "eventsession mono", item.session ?? "No session"),
        );
        button.addEventListener("click", () => {
          if (filterPending || clearPending || latest.error) return;
          stopGesture();
          hold();
          position = result.position + index - selectedIndex;
          evictionNotice = "";
          summary(latest);
          requestInspection(item.id);
        });
        return button;
      }),
    );
  if (focusedId)
    entries
      .querySelector<HTMLButtonElement>(`[data-event="${focusedId}"]`)
      ?.focus({ preventScroll: true });
  const event = result.selected;
  if ((event?.id ?? null) !== selectedId || (event?.text ?? "") !== selectedText) {
    selectedId = event?.id ?? null;
    selectedText = event?.text ?? "";
    json.textContent = selectedText;
    payload.scrollTop = 0;
    payload.dataset.event = String(selectedId);
    status.textContent = "";
    copy.textContent = "Copy JSON";
  }
  selectedValue = event ? `${time(event.receivedAt)} UTC, ${event.hook}` : "";
  const metadata = requiredElement("#metadata");
  metadata.replaceChildren();
  if (event) {
    const identity = element("span", "identity", "");
    identity.append(
      element("span", "stamp", `${time(event.receivedAt)} UTC · `),
      element("span", "session", event.session ?? "No session"),
    );
    const details = element("span", "mono details", "");
    details.append(
      element("span", "tool", event.tool ?? event.hook),
      element("span", "bytes", ` · ${event.bytes} bytes`),
    );
    metadata.append(identity, details);
    metadata.title = event.receivedAt;
  } else metadata.textContent = "No payload selected";
  copy.disabled = !event || copyPending;
  displayed = event
    ? { queryId, position, live, heldAt, removed: activeView()?.removed ?? 0 }
    : null;
  positionMarkers();
  updateScroll();
  document.documentElement.dataset.ready = "true";
}
function requestInspection(id: number | null = selectedId) {
  return requestNavigation(id === null && live ? { kind: "live" } : { kind: "select", id });
}
async function requestNavigation(target: NavigationTarget) {
  if (filterPending || clearPending || latest.clearing || latest.error) return;
  targetId++;
  wanted = { generation, queryId, targetId, filter: filters.value(), target, rows: rowCount() };
  lastRows = wanted.rows;
  window.scope.cancel(generation, targetId);
  if (loading) return;
  loading = true;
  busy();
  try {
    while (wanted) {
      const request = wanted;
      wanted = null;
      let result: Reply<Navigation>;
      try {
        result = await window.scope.navigate(request.generation, request);
      } catch {
        result = { error: "The event could not be opened. Select an event to try again." };
      }
      if (
        wanted ||
        result.stale ||
        request.generation !== generation ||
        request.queryId !== queryId ||
        request.targetId !== targetId ||
        clearPending
      )
        continue;
      if (result.snapshotLost) {
        stopGesture();
        evictionNotice =
          "History used by the drag was evicted. Drag ended; showing the nearest retained match.";
        requestInspection(selectedId);
        continue;
      }
      if (
        "rows" in result &&
        result.selected &&
        latest.first &&
        result.rows.some((row) => row.id < latest.first!.id)
      ) {
        if (result.selected!.id < latest.first.id)
          evictionNotice =
            "The requested event was evicted. Showing the nearest retained matching event.";
        requestInspection(result.selected!.id);
        continue;
      }
      render(result);
      if ("rows" in result && !result.error && !result.selected && (activeView()?.count ?? 0) > 0)
        requestInspection(null);
      if (request.targetId === reconcileTarget && !result.error) {
        reconcileTarget = 0;
        requestInspection(live ? null : selectedId);
      }
    }
  } finally {
    loading = false;
    busy();
    if (rowCount() !== lastRows && !queryFailed && !clearPending && !gesture && !filterPending)
      requestInspection(live ? null : selectedId);
  }
}
function changeFilter(_value: Filter, delay: number) {
  if (latest.error) return;
  queryId++;
  heldAt = 0;
  evictionNotice = "";
  queryNotice = "Searching…";
  queryFailed = false;
  stopGesture();
  cancelWork();
  clearTimeout(filterTimer);
  filterPending = true;
  busy();
  summary(latest);
  filterTimer = setTimeout(() => {
    filterPending = false;
    requestInspection(live ? null : selectedId);
  }, delay);
}
function seek(rank: number, snapshot = navigationSnapshot()) {
  if (!snapshot?.count || filterPending || clearPending || latest.error) return;
  const next = Math.max(0, Math.min(snapshot.count, Math.round(rank)));
  if (next === snapshot.count) {
    live = true;
    heldAt = 0;
  } else hold();
  position = next;
  evictionNotice = "";
  summary(latest);
  requestNavigation(live ? { kind: "live", snapshot } : { kind: "rank", rank: next, snapshot });
}
function movePointer() {
  pointerFrame = null;
  if (!gesture || pointerPosition === null) return;
  seek(
    ((pointerPosition - gesture.top) / gesture.height) * gesture.snapshot.count,
    gesture.snapshot,
  );
}
scrubber.addEventListener("pointerdown", (event) => {
  const snapshot = navigationSnapshot();
  if (!snapshot?.count || filterPending || clearPending || latest.error || event.button !== 0)
    return;
  const rect = scrubber.getBoundingClientRect();
  gesture = {
    snapshot,
    first: activeView()?.first,
    pointerId: event.pointerId,
    top: rect.top,
    height: rect.height,
  };
  scrubber.setPointerCapture(event.pointerId);
  scrubber.focus();
  pointerPosition = event.clientY;
  movePointer();
});
scrubber.addEventListener("pointermove", (event) => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  pointerPosition = event.clientY;
  if (pointerFrame === null) pointerFrame = requestAnimationFrame(movePointer);
});
function releasePointer(event: PointerEvent) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  pointerPosition = event.clientY;
  if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
  movePointer();
  const finalTarget = targetId;
  stopGesture();
  if (loading) reconcileTarget = finalTarget;
  else requestInspection(live ? null : selectedId);
}
scrubber.addEventListener("pointerup", releasePointer);
scrubber.addEventListener("pointercancel", (event) => {
  if (gesture?.pointerId === event.pointerId) {
    stopGesture();
    cancelWork();
    requestInspection(live ? null : selectedId);
  }
});
scrubber.addEventListener("keydown", (event) => {
  const snapshot = navigationSnapshot();
  const current = live ? (snapshot?.count ?? 0) : position;
  const moves: Record<string, number> = {
    ArrowUp: current - 1,
    ArrowLeft: current - 1,
    ArrowDown: current + 1,
    ArrowRight: current + 1,
    PageUp: current - 5,
    PageDown: current + 5,
    Home: 0,
    End: snapshot?.count ?? 0,
  };
  if (event.key in moves) {
    event.preventDefault();
    seek(moves[event.key], snapshot);
  }
});
let wheelAt = -Infinity;
requiredElement(".journal").addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (!event.deltaY || performance.now() - wheelAt < 80) return;
    wheelAt = performance.now();
    const snapshot = navigationSnapshot();
    seek((live ? (snapshot?.count ?? 0) : position) + Math.sign(event.deltaY), snapshot);
  },
  { passive: false },
);
copy.addEventListener("click", async () => {
  if (selectedId === null || copyPending || latest.error) return;
  const id = selectedId;
  const copyGeneration = generation;
  copyPending = true;
  copy.disabled = true;
  status.textContent = "";
  const success = await window.scope.copyPayload(copyGeneration, id);
  copyPending = false;
  copy.disabled = selectedId === null || !!latest.error;
  if (selectedId !== id || generation !== copyGeneration) return;
  copy.textContent = success ? "Copied" : "Copy JSON";
  status.textContent = success
    ? ""
    : "Copy failed. Try Copy JSON again, or select and copy the original text.";
});
async function activateClear() {
  if (clear.disabled || clearPending) return;
  const now = performance.now();
  if (!clearDeadline || now >= clearDeadline) {
    relock();
    clearDeadline = now + 3000;
    clear.classList.add("unlocked");
    clearLabel.textContent = "Clear?";
    clear.setAttribute("aria-label", "Confirm Clear history");
    lock.setAttribute("d", "M6 9V6a4 4 0 0 1 8 0");
    clearTimer = setTimeout(relock, 3000);
    return;
  }
  relock();
  clearPending = true;
  clear.disabled = true;
  const oldGeneration = generation;
  clearTimeout(filterTimer);
  filterPending = false;
  stopGesture();
  cancelWork();
  summary(latest);
  try {
    const result = await window.scope.clear(oldGeneration);
    if (result.error) requiredElement("#notice").textContent = result.error;
    const value = await window.scope.status();
    clearPending = false;
    receive(value);
    if (!value.error) requestInspection(null);
  } catch {
    clearPending = false;
    requiredElement("#notice").textContent = "Clear failed. Restart the app to retry cleanup.";
  }
}
clear.addEventListener("click", activateClear);
clear.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  if (event.repeat || activationKey) return;
  activationKey = event.key;
  void activateClear();
});
document.addEventListener("keyup", (event) => {
  if (event.key === activationKey) activationKey = null;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") relock();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) relock();
  else void window.scope.status().then(receive);
});
window.scope.onHidden(() => {
  relock();
  stopGesture();
});
liveButton.addEventListener("click", () => {
  if (liveButton.disabled) return;
  stopGesture();
  live = true;
  heldAt = 0;
  evictionNotice = "";
  summary(latest);
  requestInspection(null);
});
new ResizeObserver(() => {
  if (document.body.classList.contains("tool-open")) return;
  const notice = requiredElement("#notice");
  notice.tabIndex = notice.scrollHeight > notice.clientHeight ? 0 : -1;
  positionMarkers();
  if (
    rowCount() !== lastRows &&
    !loading &&
    !queryFailed &&
    !clearPending &&
    !gesture &&
    !filterPending
  )
    requestInspection(live ? null : selectedId);
}).observe(entries);
window.scope.onStatus(receive);
void window.scope.status().then((value) => {
  receive(value);
  requestInspection(null);
  filters.refresh();
});

const analyzer = attachAnalysis(
  () => filters.value().session,
  (visible) => {
    if (!visible) {
      stopGesture();
      cancelWork();
      relock();
    } else {
      summary(latest);
      requestInspection(live ? null : selectedId);
    }
  },
);

const tools = attachTools(analyzer, () => {
  summary(latest);
  requestInspection(live ? null : selectedId);
});
