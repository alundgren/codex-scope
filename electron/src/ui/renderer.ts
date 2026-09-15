import { attachTools } from "./tools.ts";
import { attachAnalysis } from "./analysis.ts";
import type {
  HistoryStatus,
  NavigationRequest,
  NavigationTarget,
  NavigationSnapshot,
  Navigation,
  Reply,
  StoredEvent,
} from "../types.ts";
import { requiredElement } from "./elements.ts";
import { attachScrollbar } from "./scrollbar.ts";
import { attachFilters } from "./filters.ts";

const entries = requiredElement("#entries"),
  payload = requiredElement("#payload"),
  json = requiredElement("#json");
const dialog = requiredElement<HTMLDialogElement>("#call-detail");
const copy = requiredElement<HTMLButtonElement>("#copy"),
  status = requiredElement("#copy-status");
const clear = requiredElement<HTMLButtonElement>("#clear"),
  liveButton = requiredElement<HTMLButtonElement>("#live");
const lock = requiredElement(".clear svg path"),
  clearLabel = requiredElement("#clear-label");
const updateScroll = attachScrollbar(
  payload,
  requiredElement("#scrollbar"),
  requiredElement("#thumb"),
);
const previousPage = requiredElement<HTMLButtonElement>("#previous-page"),
  nextPage = requiredElement<HTMLButtonElement>("#next-page");
const sort = requiredElement<HTMLSelectElement>("#sort");
let selectedId: number | null = null,
  selected: StoredEvent | null = null,
  selectedText = "";
let tab: "response" | "input" | "json" = "response";
let generation = 1,
  queryId = 1,
  targetId = 0,
  position = 0,
  heldAt = 0;
let live = true,
  loading = false,
  copyPending = false,
  clearPending = false,
  filterPending = false,
  queryFailed = false;
let wanted: (NavigationRequest & { generation: number }) | null = null;
let snapshot: NavigationSnapshot | undefined;
let pageChanged = false;
let currentRows: Navigation["rows"] = [];
let latest: HistoryStatus = {
  generation: 1,
  total: 0,
  accepted: 0,
  drops: {},
  first: null,
  last: null,
};
let evictionNotice = "",
  queryNotice = "";
let clearDeadline = 0,
  activationKey: string | null = null;
let clearTimer: ReturnType<typeof setTimeout> | undefined,
  filterTimer: ReturnType<typeof setTimeout> | undefined;
const PAGE_ROWS = 12;
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
const byteFormats = [0, 1, 2].map(
  (maximumFractionDigits) => new Intl.NumberFormat("en-US", { maximumFractionDigits }),
);
export function formatBytes(value: number | null) {
  if (value === null) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index++;
  }
  return `${byteFormats[index ? (value >= 10 ? 1 : 2) : 0].format(value)} ${units[index]}`;
}
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
function setText(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}
function summary(value: HistoryStatus) {
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
  const view = activeView(),
    count = view?.count ?? null;
  const arrivals = live || !view ? 0 : Math.max(0, view.arrivals - heldAt);
  setText(requiredElement("#mode"), live ? "List holds when you inspect a call" : "Position held");
  setText(liveButton, live ? "Live ↓" : "Resume live");
  liveButton.setAttribute("aria-pressed", String(live));
  setText(
    requiredElement("#new-matches"),
    !live ? `${arrivals.toLocaleString()} new matching` : "",
  );
  const countNode = requiredElement("#count");
  setText(
    countNode,
    count === null
      ? value.error
        ? "Unavailable"
        : queryFailed
          ? "Search stopped"
          : "Searching…"
      : count.toLocaleString(),
  );
  countNode.dataset.matching = String(count ?? 0);
  countNode.dataset.arrivals = String(arrivals);
  const measured = view?.measuredCalls ?? 0,
    total = view?.responseBytes ?? 0;
  setText(requiredElement("#response-total"), count === null ? "Unavailable" : formatBytes(total));
  setText(
    requiredElement("#response-unknown"),
    count === null
      ? ""
      : count > measured
        ? `+ ${(count - measured).toLocaleString()} unknown responses`
        : "All matching responses measured",
  );
  setText(
    requiredElement("#response-average"),
    measured ? formatBytes(total / measured) : "Unavailable",
  );
  setText(
    requiredElement("#response-denominator"),
    `Across ${measured.toLocaleString()} measured calls`,
  );
  setText(
    requiredElement("#retention"),
    value.first
      ? `Retained from ${time(value.first.receivedAt)} UTC · Deleted when the app closes.`
      : "Temporary recording · Waiting for events.",
  );
  const blocked = filterPending || clearPending || !!value.clearing || !!value.error;
  clear.disabled = !value.total || clearPending || !!value.clearing || !!value.error;
  liveButton.disabled = blocked || !count;
  sort.disabled = !!value.error || clearPending;
  copy.disabled = selectedId === null || copyPending || !!value.error;
  filters.disable(!!value.error || !!value.clearing);
  previousPage.disabled = blocked || (pageChanged ? !currentRows.length : !position);
  nextPage.disabled =
    blocked ||
    (pageChanged ? !currentRows.length : position + currentRows.length >= (snapshot?.count ?? 0));
  requiredElement("#page-position").textContent = pageChanged
    ? `${currentRows.length} held calls`
    : currentRows.length
      ? `${position + 1}–${position + currentRows.length} of ${(snapshot?.count ?? 0).toLocaleString()}`
      : "";
  for (const row of entries.querySelectorAll<HTMLElement>("[data-event]")) {
    row.setAttribute("aria-disabled", String(blocked));
    row.tabIndex = blocked ? -1 : 0;
  }
}
function empty(message = "No tool calls have arrived.", reset = false) {
  pageChanged = false;
  currentRows = [];
  selectedId = null;
  selected = null;
  selectedText = "";
  position = 0;
  entries.replaceChildren();
  json.textContent = "";
  payload.dataset.event = "null";
  if (dialog.open) dialog.close();
  const host = requiredElement("#empty-results");
  host.hidden = false;
  host.textContent = message;
  if (reset) {
    const button = element("button", "", "Reset filters");
    button.addEventListener("click", filters.reset);
    host.append(button);
  }
  status.textContent = "";
  copy.disabled = true;
  updateScroll();
}
function cancelWork() {
  wanted = null;
  targetId++;
  window.scope.cancel(generation, targetId);
}
function hold() {
  cancelWork();
  if (live) heldAt = activeView()?.arrivals ?? 0;
  live = false;
}
function receive(value: HistoryStatus) {
  if (value.generation < generation) return;
  const changed = value.accepted !== latest.accepted || value.total !== latest.total;
  const reset = value.generation !== generation || (!!latest.clearing && !value.clearing);
  analyzer.receive(value);
  if (value.generation !== generation) {
    generation = value.generation;
    queryId++;
    targetId = 0;
    live = true;
    heldAt = 0;
    snapshot = undefined;
    evictionNotice = "";
    queryNotice = "";
    filterPending = false;
    clearTimeout(filterTimer);
    cancelWork();
    relock();
    empty();
  }
  if (value.error) {
    if (!currentRows.length) empty("Temporary history is unavailable.");
    queryNotice = "";
    queryFailed = false;
    filterPending = false;
    clearTimeout(filterTimer);
    cancelWork();
    relock();
  }
  summary(value);
  tools.receive(value);
  if (!value.starting) document.documentElement.dataset.ready = "true";
  if (
    value.error ||
    document.hidden ||
    document.body.classList.contains("tool-open") ||
    clearPending ||
    value.clearing ||
    filterPending
  )
    return;
  if (reset) filters.refresh();
  if (
    !live &&
    snapshot &&
    value.view?.queryId === queryId &&
    value.view.removed !== snapshot.removed
  ) {
    const missing = currentRows.some((row) => value.first && row.id < value.first.id);
    if (missing) {
      snapshot = undefined;
      evictionNotice = "Held calls were evicted. Showing the nearest retained matching calls.";
      if (selectedId !== null && value.first && selectedId < value.first.id) {
        evictionNotice =
          "The selected event was evicted. Showing the nearest retained matching call.";
        if (dialog.open) {
          detailTarget++;
          dialog.close();
        }
        selectedId = null;
        selected = null;
      }
      void requestNavigation({ kind: "select", id: currentRows[0]?.id ?? null });
    } else {
      pageChanged = true;
      snapshot = {
        ...snapshot,
        count: Math.max(0, snapshot.count - (value.view.removed - snapshot.removed)),
        removed: value.view.removed,
      };
      summary(value);
    }
  } else if (
    reset ||
    (live && (changed || (!loading && !currentRows.length && (activeView()?.count ?? 0) > 0)))
  )
    void requestNavigation({ kind: "live" });
}
function drawRows() {
  const focused = (document.activeElement as HTMLElement | null)?.dataset.event;
  entries.dataset.position = String(position);
  const existing = new Map(
    [...entries.querySelectorAll<HTMLTableRowElement>("tr[data-event]")].map((row) => [
      Number(row.dataset.event),
      row,
    ]),
  );
  const rows = currentRows.map((item) => {
    const retained = existing.get(item.id);
    if (retained) {
      retained.setAttribute("aria-selected", String(item.id === selectedId));
      return retained;
    }
    const row = element("tr", "event", "");
    row.dataset.event = String(item.id);
    row.tabIndex = 0;
    row.setAttribute("aria-label", `Inspect ${item.tool ?? "Unknown tool"} ${item.preview}`);
    row.setAttribute("aria-selected", String(item.id === selectedId));
    const input = element("td", "", "");
    const preview = element("div", "preview", item.preview);
    preview.title = item.preview;
    input.append(
      preview,
      element(
        "div",
        "eventsession",
        `${item.context ?? item.session ?? "No session"} · ${item.model ?? "Unknown model"}`,
      ),
    );
    row.append(
      element("td", "tool-name", item.tool ?? "Unknown tool"),
      input,
      element("td", "response-size", formatBytes(item.responseBytes ?? null)),
      element("td", "received", time(item.receivedAt)),
    );
    const open = () => {
      if (filterPending || clearPending || latest.error) return;
      hold();
      summary(latest);
      void openDetail(item.id);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
    return row;
  });
  for (const row of existing.values()) if (!rows.includes(row)) row.remove();
  rows.forEach((row, index) => {
    if (entries.children[index] !== row) entries.insertBefore(row, entries.children[index] ?? null);
  });
  if (focused)
    entries.querySelector<HTMLElement>(`[data-event="${focused}"]`)?.focus({ preventScroll: true });
}
let detailTarget = 0,
  detailLoading = false,
  detailWanted: number | null = null;
async function openDetail(id: number) {
  detailWanted = id;
  detailTarget++;
  if (detailLoading) return;
  detailLoading = true;
  try {
    while (detailWanted !== null) {
      const id = detailWanted;
      detailWanted = null;
      const request = detailTarget,
        recording = generation;
      // Navigation and inspection share one bounded broker slot.
      while (loading) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        if (request !== detailTarget || recording !== generation) break;
      }
      if (request !== detailTarget || recording !== generation) continue;
      const result = await window.scope.inspect(recording, id, 1);
      if (request !== detailTarget || recording !== generation) continue;
      if (result.error) {
        queryNotice = result.error;
        summary(latest);
        continue;
      }
      if (!("selected" in result) || !result.selected || result.selected.id !== id) {
        evictionNotice = "That call is no longer retained.";
        summary(latest);
        return;
      }
      selected = result.selected;
      selectedId = id;
      selectedText = selected.text;
      tab = "response";
      renderPayload();
      drawRows();
      if (!dialog.open) dialog.showModal();
      requiredElement("#detail-close").focus();
      updateScroll();
    }
  } catch {
    queryNotice = "The call could not be opened. Select it to try again.";
    summary(latest);
  } finally {
    detailLoading = false;
    if (wanted) void requestNavigation(wanted.target);
  }
}
function renderPayload() {
  if (!selected) return;
  const value = JSON.parse(selectedText) as Record<string, unknown>;
  const content = tab === "response" ? value.tool_response : value.tool_input;
  json.textContent =
    tab === "json"
      ? selectedText
      : content === undefined
        ? tab === "response"
          ? "Response unavailable."
          : "Input unavailable."
        : typeof content === "string"
          ? content
          : JSON.stringify(content);
  payload.scrollTop = 0;
  payload.dataset.event = String(selectedId);
  payload.setAttribute(
    "aria-label",
    tab === "json"
      ? "Complete original JSON payload"
      : tab === "response"
        ? "Tool response"
        : "Tool input",
  );
  const metadata = requiredElement("#metadata");
  metadata.replaceChildren(
    element(
      "div",
      "detail-title",
      `${selected.tool ?? "Unknown tool"} · ${formatBytes(selected.responseBytes ?? null)}`,
    ),
    element(
      "div",
      "detail-identity",
      `${selected.session ?? "No session"} · ${selected.model ?? "Unknown model"} · ${time(selected.receivedAt)} UTC`,
    ),
  );
  for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-tab]"))
    button.setAttribute("aria-pressed", String(button.dataset.tab === tab));
  copy.textContent = `Copy ${tab === "json" ? "JSON" : tab}`;
  copy.disabled = false;
  status.textContent = "List held while you inspect.";
  updateScroll();
}
function render(result: Reply<Navigation>) {
  if (!("rows" in result)) {
    if (result.error) {
      queryFailed = true;
      queryNotice = result.error + (currentRows.length ? " Previous results are still shown." : "");
      if (!currentRows.length) empty("Search stopped.", true);
      summary(latest);
    }
    return;
  }
  queryFailed = false;
  queryNotice = "";
  pageChanged = false;
  snapshot = result.snapshot;
  position = result.position;
  currentRows = result.rows;
  if (result.accepted >= latest.accepted || !activeView()) latest = result;
  if (!currentRows.length)
    empty(
      result.total ? "No calls match these filters." : "No tool calls have arrived.",
      !!result.total,
    );
  else {
    requiredElement("#empty-results").hidden = true;
    drawRows();
  }
  summary(latest);
  document.documentElement.dataset.ready = "true";
}
async function requestNavigation(target: NavigationTarget) {
  if (filterPending || clearPending || latest.clearing || latest.error) return;
  targetId++;
  wanted = { generation, queryId, targetId, filter: filters.value(), target, rows: PAGE_ROWS };
  window.scope.cancel(generation, targetId);
  if (loading || detailLoading) return;
  loading = true;
  entries.setAttribute("aria-busy", "true");
  try {
    while (wanted) {
      const request = wanted;
      wanted = null;
      let result: Reply<Navigation>;
      try {
        result = await window.scope.navigate(request.generation, request);
      } catch {
        result = { error: "History could not be searched. Try again." };
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
        snapshot = undefined;
        evictionNotice = "Held history was evicted. Showing retained calls.";
        void requestNavigation({ kind: "rank", rank: position });
        continue;
      }
      if (
        "rows" in result &&
        latest.first &&
        result.rows.some((row) => row.id < latest.first!.id)
      ) {
        snapshot = undefined;
        evictionNotice = "Requested calls were evicted. Showing retained calls.";
        void requestNavigation({ kind: "select", id: latest.first.id });
        continue;
      }
      render(result);
    }
  } finally {
    loading = false;
    entries.setAttribute("aria-busy", String(filterPending));
  }
}
function changeFilter(_value: unknown, delay: number) {
  if (latest.error) return;
  queryId++;
  heldAt = 0;
  snapshot = undefined;
  position = 0;
  detailTarget++;
  if (dialog.open) dialog.close();
  evictionNotice = "";
  queryNotice = "Searching…";
  queryFailed = false;
  cancelWork();
  clearTimeout(filterTimer);
  filterPending = true;
  entries.setAttribute("aria-busy", "true");
  summary(latest);
  filterTimer = setTimeout(() => {
    filterPending = false;
    void requestNavigation({ kind: "live" });
  }, delay);
}
previousPage.addEventListener("click", () => {
  hold();
  void requestNavigation({
    kind: "select",
    id: currentRows[0]?.id ?? null,
    page: "previous",
    snapshot,
  });
  summary(latest);
});
nextPage.addEventListener("click", () => {
  hold();
  void requestNavigation({
    kind: "select",
    id: currentRows[0]?.id ?? null,
    page: "next",
    snapshot,
  });
  summary(latest);
});
sort.addEventListener("change", () => filters.sort(sort.value as "newest" | "largest"));
requiredElement("#detail-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  detailTarget++;
  selected = null;
  selectedText = "";
  json.textContent = "";
  entries
    .querySelector<HTMLElement>(`[data-event="${selectedId}"]`)
    ?.focus({ preventScroll: true });
});
for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-tab]"))
  button.addEventListener("click", () => {
    tab = button.dataset.tab as typeof tab;
    renderPayload();
  });
copy.addEventListener("click", async () => {
  if (selectedId === null || copyPending || latest.error) return;
  const id = selectedId,
    recording = generation,
    part = tab;
  copyPending = true;
  copy.disabled = true;
  const success = await window.scope.copyPayload(recording, id, part);
  copyPending = false;
  copy.disabled = selectedId === null || !!latest.error;
  if (id !== selectedId || recording !== generation || part !== tab) return;
  copy.textContent = success ? "Copied" : `Copy ${part === "json" ? "JSON" : part}`;
  status.textContent = success ? "" : "Copy failed. Select and copy the visible text.";
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
  cancelWork();
  summary(latest);
  try {
    const result = await window.scope.clear(oldGeneration);
    if (result.error) requiredElement("#notice").textContent = result.error;
    const value = await window.scope.status();
    clearPending = false;
    receive(value);
    if (!value.error) void requestNavigation({ kind: "live" });
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
});
liveButton.addEventListener("click", () => {
  if (liveButton.disabled) return;
  live = true;
  heldAt = 0;
  snapshot = undefined;
  evictionNotice = "";
  summary(latest);
  void requestNavigation({ kind: "live" });
});
window.scope.onStatus(receive);
void window.scope.status().then((value) => {
  receive(value);
  void requestNavigation({ kind: "live" });
});
const analyzer = attachAnalysis(
  () => (filters.value().sessions?.length === 1 ? filters.value().sessions![0] : null),
  (visible) => {
    if (!visible) {
      cancelWork();
      relock();
    } else {
      summary(latest);
      if (live) void requestNavigation({ kind: "live" });
    }
  },
);
const tools = attachTools(analyzer, () => {
  summary(latest);
  if (live) void requestNavigation({ kind: "live" });
});
