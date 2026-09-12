import type {
  AnalysisAPI,
  AnalysisCall,
  AnalysisRun,
  AnalysisState,
  AnalysisDecision,
} from "../analysis-types.ts";
import type { HistoryStatus, ChoicePage, Direction } from "../types.ts";
import { requiredElement } from "./elements.ts";

type View = "results" | "trail" | "routing" | "recommendations";
type ViewState = { search: string; sort: string; scroll: number };
type Workspace = { focus: number | null; group: string; views: Record<View, ViewState> };
const views: View[] = ["results", "trail", "routing", "recommendations"];
const createWorkspace = (): Workspace => ({
  focus: null,
  group: "",
  views: Object.fromEntries(
    views.map((view) => [
      view,
      { search: "", sort: view === "results" ? "bytes" : "order", scroll: 0 },
    ]),
  ) as Record<View, ViewState>,
});
const node = <T extends keyof HTMLElementTagNameMap>(tag: T, text = "", className = "") => {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
};
const button = (text: string, action: () => void) => {
  const value = node("button", text);
  value.addEventListener("click", action);
  return value;
};
const option = (text: string, value: string) => {
  const item = node("option", text);
  item.value = value;
  return item;
};
const bytes = (value: number | null) =>
  value === null ? "Response size unknown" : `${value.toLocaleString()} response bytes`;

export function attachAnalysis(
  journalSession: () => string | null,
  journalVisible: (visible: boolean) => void,
) {
  const api = window.scope as typeof window.scope & AnalysisAPI;
  const panel = requiredElement("#analyzer");
  const session = requiredElement<HTMLSelectElement>("#analysis-session");
  const model = requiredElement<HTMLInputElement>("#analysis-model");
  const runSelect = requiredElement<HTMLSelectElement>("#analysis-run");
  const fresh = requiredElement<HTMLInputElement>("#analysis-fresh");
  const search = requiredElement<HTMLInputElement>("#analysis-search");
  const group = requiredElement<HTMLSelectElement>("#analysis-group");
  const sort = requiredElement<HTMLSelectElement>("#analysis-sort");
  const content = requiredElement("#analysis-content");
  const detail = requiredElement("#analysis-detail");
  const status = requiredElement("#analysis-status");
  const start = requiredElement<HTMLButtonElement>("#analysis-start");
  const cancel = requiredElement<HTMLButtonElement>("#analysis-cancel");
  const exportButton = requiredElement<HTMLButtonElement>("#analysis-export");
  const workspaces = new Map<string, Workspace>();
  let history: HistoryStatus | null = null;
  let state: AnalysisState | null = null;
  let run: AnalysisRun | null = null;
  let view: View = "results";
  let selectedSession = "",
    selectedLabel = "";
  let page: ChoicePage = { values: [] };
  let pageCursor: string | null = null,
    pageDirection: Direction = "next";
  let request = 0,
    choiceRequest = 0,
    payloadRequest = 0;
  let setupExpanded = true;
  let loading = false,
    dirty = true,
    busy = false;
  let message = "",
    original: { order: number; text: string } | null = null;
  let defaultWorkspace = createWorkspace();
  const visible = () => !panel.hidden && !document.hidden;
  const workspace = () => {
    if (!run) return defaultWorkspace;
    let value = workspaces.get(run.id);
    if (!value) {
      value = createWorkspace();
      workspaces.set(run.id, value);
    }
    return value;
  };
  const saveScroll = () => {
    workspace().views[view].scroll = content.scrollTop;
  };
  const selectedCall = () => run?.snapshot.calls.find((call) => call.order === workspace().focus);
  const missing = (call: AnalysisCall) =>
    !!history &&
    (!history.first ||
      call.order < history.first.id ||
      run?.snapshot.generation !== history.generation);
  const report = (error: unknown) => {
    message = error instanceof Error ? error.message : "Analysis request failed. Try again.";
    drawStatus();
  };
  function drawStatus() {
    if (!visible()) return;
    const active = state?.runs.find((value) => value.id === state?.activeRunId);
    status.textContent =
      message ||
      (active
        ? `Analyzing with ${active.model}. ${run && run.id !== active.id ? "Your selected run remains open." : "You can keep browsing or cancel."}`
        : run?.error ||
          (run?.state === "cancelled"
            ? "Analysis cancelled. Choose a model and Analyze to try again."
            : ""));
    start.disabled =
      busy ||
      !!active ||
      !selectedSession ||
      !model.value.trim() ||
      !!history?.error ||
      !!history?.clearing;
    cancel.hidden = !active;
    cancel.disabled = busy;
    const compactCancel = requiredElement<HTMLButtonElement>("#analysis-cancel-compact");
    compactCancel.hidden =
      !active || !matchMedia("(max-width: 720px)").matches || setupExpanded || !run;
    compactCancel.disabled = busy;
    fresh.disabled = !run || busy;
    requiredElement("#analysis-source").textContent =
      run && !fresh.checked
        ? "Next analysis uses this run's snapshot."
        : "Next analysis captures a new bounded snapshot.";
  }
  function drawSessions() {
    session.replaceChildren(option("Choose a session", ""));
    if (selectedSession && !page.values.includes(selectedSession))
      session.append(option(selectedLabel || selectedSession, JSON.stringify(selectedSession)));
    page.values.forEach((value, index) => {
      const label = page.labels?.[index] || value;
      if (value === selectedSession) selectedLabel = label;
      const item = option(label, JSON.stringify(value));
      item.title = value;
      session.append(item);
    });
    if (page.previous) session.append(option("Previous sessions…", "@previous"));
    if (page.next) session.append(option("More sessions…", "@next"));
    session.value = selectedSession ? JSON.stringify(selectedSession) : "";
  }
  async function loadSessions(
    cursor: string | null = pageCursor,
    direction: Direction = pageDirection,
  ) {
    if (!history) return;
    const ticket = ++choiceRequest,
      generation = history.generation;
    try {
      const result = await api.choices(generation, "session", cursor, direction);
      if (ticket !== choiceRequest || generation !== history?.generation) return;
      if (!("values" in result))
        throw new Error(
          result.error || "Session choices are unavailable. Reopen the session selector to retry.",
        );
      page = result;
      pageCursor = cursor;
      pageDirection = direction;
      drawSessions();
    } catch (error) {
      if (ticket === choiceRequest) report(error);
    }
  }
  function drawRunControls() {
    const runs = state?.runs.filter((value) => value.session === selectedSession) ?? [];
    runSelect.replaceChildren(
      ...(runs.length
        ? runs.map((value) =>
            option(
              `${value.model} · ${new Date(value.createdAt).toLocaleTimeString()} · ${value.state}`,
              value.id,
            ),
          )
        : [option("No analysis yet", "")]),
    );
    runSelect.value = run?.id ?? "";
    drawStatus();
  }
  async function refresh(preferred?: string) {
    dirty = true;
    if (!visible() || !history) return;
    if (loading && !preferred) return;
    const ticket = ++request,
      generation = history.generation,
      sessionId = selectedSession;
    loading = true;
    dirty = false;
    try {
      const next = await api.analysisList(generation);
      if (ticket !== request || generation !== history?.generation || sessionId !== selectedSession)
        return;
      const previousWorkspace = run ? workspaces.get(run.id) : undefined;
      state = next;
      for (const key of workspaces.keys())
        if (!next.runs.some((value) => value.id === key)) workspaces.delete(key);
      const choices = next.runs.filter((value) => value.session === sessionId);
      const id =
        choices.find((value) => value.id === preferred)?.id ??
        choices.find((value) => value.id === run?.id)?.id ??
        choices[0]?.id;
      const nextRun = id ? await api.analysisRun(generation, id) : null;
      if (ticket !== request || generation !== history?.generation || sessionId !== selectedSession)
        return;
      if (run?.id !== nextRun?.id) {
        original = null;
        payloadRequest++;
      }
      if (run && !next.runs.some((value) => value.id === run?.id))
        message =
          "The selected analysis run was removed by the run limit. Showing another retained run.";
      if (
        nextRun &&
        previousWorkspace &&
        run &&
        run.id !== nextRun.id &&
        !workspaces.has(nextRun.id) &&
        run.snapshot.upper === nextRun.snapshot.upper &&
        run.session === nextRun.session
      )
        workspaces.set(nextRun.id, structuredClone(previousWorkspace));
      run = nextRun;
      draw();
    } catch (error) {
      if (ticket === request) report(error);
    } finally {
      if (ticket === request) {
        loading = false;
        if (dirty) void refresh();
      }
    }
  }
  function drawCoverage() {
    const snapshot = run?.snapshot;
    requiredElement("#analysis-snapshot").textContent = snapshot
      ? `${snapshot.calls.length} captured calls · Snapshot ${new Date(snapshot.createdAt).toLocaleString()} · Coverage unknown`
      : "Choose a session and Analyze. Only captured hook evidence is available.";
    requiredElement("#analysis-limits").textContent = snapshot
      ? `${snapshot.sampledEvents} sampled events; ${snapshot.omittedEvents} events and ${snapshot.omittedCalls} calls omitted by snapshot limits. ${snapshot.calls.filter((call) => call.argumentsOmitted || call.excerptOmitted).length} calls have shortened evidence. ${snapshot.evictedBeforeSnapshot} events evicted before this snapshot. Recording-wide drops: ${snapshot.localDrops} local; ${snapshot.collectorDrops ? Object.values(snapshot.collectorDrops).reduce((a, b) => a + b, 0) + " collector lifetime total" : "collector count unknown"}. These counts are not session-specific. Losses across gaps are unknown. Response bytes do not establish tokens delivered to context, cost, or wasted work.${run?.usage ? ` Analyzer usage: ${run.usage.inputTokens} input tokens, ${run.usage.cachedInputTokens} cached, ${run.usage.outputTokens} output. This is separate from the captured session.` : " Analyzer usage unavailable."}`
      : "The CLI runs locally using its configured model provider. Analyzing sends the selected snapshot to that provider. Missing events cannot be recovered. Runs and decisions are temporary and deleted with history or when the app closes.";
  }
  function focusCall(order: number) {
    saveScroll();
    if (workspace().focus !== order) detail.scrollTop = 0;
    workspace().focus = order;
    original = null;
    payloadRequest++;
    drawBody();
  }
  function filteredCalls() {
    const current = workspace(),
      query = current.views[view].search.toLowerCase();
    return (run?.snapshot.calls ?? [])
      .filter(
        (call) =>
          (!current.group || (call.model ?? "@unknown") === current.group) &&
          (!query ||
            `${call.command} ${call.tool} ${call.model ?? ""} ${call.actor ?? ""}`
              .toLowerCase()
              .includes(query)),
      )
      .sort((a, b) =>
        current.views[view].sort === "bytes"
          ? (b.responseBytes ?? -1) - (a.responseBytes ?? -1) || a.order - b.order
          : a.order - b.order,
      );
  }
  function callRow(call: AnalysisCall, max: number) {
    const row = button("", () => focusCall(call.order));
    row.className = "analysis-call";
    row.dataset.call = String(call.order);
    row.setAttribute("aria-pressed", String(call.order === workspace().focus));
    const line = node("span", "", "analysis-call-line");
    line.append(
      node("span", call.command || call.tool, "mono analysis-command"),
      node("span", bytes(call.responseBytes), "analysis-bytes"),
    );
    row.append(
      line,
      node(
        "span",
        `${call.model || "Model unknown"} · ${call.tool} · ${call.receivedAt.slice(11, 19)} UTC`,
        "analysis-secondary",
      ),
    );
    if (call.responseBytes !== null) {
      const track = node("span", "", "analysis-bar");
      const fill = node("span");
      fill.style.width = `${max ? (call.responseBytes / max) * 100 : 0}%`;
      track.append(fill);
      row.append(track);
    }
    return row;
  }
  function drawCalls(calls: AnalysisCall[]) {
    const max = Math.max(1, ...calls.map((call) => call.responseBytes ?? 0));
    if (view === "routing") {
      content.append(
        node(
          "p",
          "Grouped by reported model. Hook evidence does not establish parent/scout relationships or which model received a result.",
          "analysis-explanation",
        ),
      );
      const groups = new Map<string, AnalysisCall[]>();
      for (const call of calls) {
        const key = call.model || "Model unknown";
        groups.set(key, [...(groups.get(key) ?? []), call]);
      }
      for (const [name, values] of groups) {
        const total = values.reduce((sum, call) => sum + (call.responseBytes ?? 0), 0);
        const cluster = node("div", "", "analysis-model-group");
        const unknown = values.filter((call) => call.responseBytes === null).length;
        const measured =
          unknown === values.length
            ? "Response sizes unknown"
            : `${total.toLocaleString()} measured response bytes${unknown ? ` · ${unknown} sizes unknown` : ""}`;
        const control = button(`${name} · ${values.length} calls · ${measured}`, () => {
          workspace().group = values[0].model ?? "@unknown";
          draw();
        });
        control.className = "analysis-group-control";
        cluster.append(control, ...values.map((call) => callRow(call, max)));
        content.append(cluster);
      }
    } else {
      if (view === "trail")
        content.append(
          node(
            "p",
            workspace().views.trail.sort === "order"
              ? "Captured calls in sequence. Nearby calls may be related; sequence alone does not prove a search strategy."
              : "Calls ranked by response size. Select Captured order to inspect the sequence.",
            "analysis-explanation",
          ),
        );
      content.append(...calls.map((call) => callRow(call, max)));
    }
  }
  async function decide(id: string, value: AnalysisDecision) {
    if (!run || !history || busy) return;
    const generation = history.generation,
      runId = run.id;
    busy = true;
    drawStatus();
    try {
      const next = await api.analysisDecide(generation, runId, id, value);
      if (history?.generation === generation && run?.id === runId) {
        saveScroll();
        run = next;
        drawBody();
      }
    } catch (error) {
      if (history?.generation === generation && run?.id === runId) report(error);
    } finally {
      busy = false;
      drawStatus();
    }
  }
  function filteredFindings() {
    const query = workspace().views[view].search.toLowerCase();
    return (run?.findings ?? []).filter(
      (finding) =>
        (!query ||
          `${finding.title} ${finding.detail} ${finding.suggestion}`
            .toLowerCase()
            .includes(query)) &&
        (!workspace().group ||
          finding.callOrders.some((order) =>
            run?.snapshot.calls.some(
              (call) => call.order === order && (call.model ?? "@unknown") === workspace().group,
            ),
          )),
    );
  }
  function drawFindings() {
    const findings = filteredFindings();
    for (const finding of findings) {
      const item = node("article", "", "analysis-finding");
      item.dataset.finding = finding.id;
      item.classList.toggle("focused", finding.callOrders.includes(workspace().focus ?? -1));
      item.append(
        node("p", finding.title, "analysis-finding-title"),
        node("p", finding.detail),
        node("p", finding.suggestion, "analysis-suggestion"),
      );
      const links = node("div", "", "analysis-finding-calls");
      finding.callOrders.forEach((order) => {
        const call = run?.snapshot.calls.find((value) => value.order === order);
        if (call) links.append(button(call.command || call.tool, () => focusCall(order)));
      });
      const decision = run?.decisions[finding.id] ?? "unreviewed";
      const actions = node("div", "", "analysis-decision");
      if (decision === "unreviewed")
        actions.append(
          button("Keep suggestion", () => void decide(finding.id, "kept")),
          button("Dismiss", () => void decide(finding.id, "dismissed")),
        );
      else
        actions.append(
          node("span", decision === "kept" ? "Kept for export" : "Dismissed"),
          button("Undo", () => void decide(finding.id, "unreviewed")),
        );
      item.append(links, actions);
      content.append(item);
    }
    if (!findings.length)
      content.append(
        node(
          "p",
          run?.findings.length
            ? "No matching recommendations. Reset filters to see all findings."
            : run?.state === "completed"
              ? "No recommendations in this run. This does not establish that the session was efficient."
              : "Recommendations appear when analysis completes.",
          "analysis-empty",
        ),
      );
  }
  function drawFocus(calls: AnalysisCall[]) {
    const banner = requiredElement("#analysis-focus");
    banner.replaceChildren();
    const call = selectedCall();
    if (!call) return;
    const absent =
      view === "recommendations"
        ? !filteredFindings().some((finding) => finding.callOrders.includes(call.order))
        : !calls.some((value) => value.order === call.order);
    const noRecommendation =
      view === "recommendations" &&
      !run?.findings.some((finding) => finding.callOrders.includes(call.order));
    banner.append(node("span", `Focused call: ${call.command || call.tool}`));
    if (absent)
      banner.append(
        node(
          "span",
          noRecommendation
            ? "No recommendation links this call."
            : "Selected call is hidden by these filters.",
        ),
      );
    if (absent && !noRecommendation)
      banner.append(
        button("Show selected call", () => {
          workspace().group = "";
          workspace().views[view].search = "";
          draw();
          content
            .querySelector(`[data-call="${call.order}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }),
      );
    banner.append(
      button("Clear focus", () => {
        workspace().focus = null;
        original = null;
        payloadRequest++;
        drawBody();
      }),
    );
  }
  function drawDetail() {
    const offset = detail.scrollTop;
    detail.replaceChildren();
    const call = selectedCall();
    if (!call) {
      detail.append(
        node("p", "Select a call to follow its evidence across views.", "analysis-empty"),
      );
      return;
    }
    detail.append(
      node("p", call.command || call.tool, "mono analysis-detail-command"),
      node(
        "p",
        `${call.model || "Model unknown"} · ${bytes(call.responseBytes)}`,
        "analysis-secondary",
      ),
    );
    detail.append(
      node(
        "p",
        `Actor: ${call.actor || "unknown"}. Session: ${selectedSession}.`,
        "analysis-secondary",
      ),
    );
    if (missing(call))
      detail.append(
        node(
          "p",
          "The original event has been evicted. This run keeps its bounded snapshot summary; the original payload is unavailable.",
          "analysis-warning",
        ),
      );
    if ((call.argumentsOmitted || call.excerptOmitted) && original?.order !== call.order)
      detail.append(
        node(
          "p",
          "Snapshot evidence was shortened. This excerpt is not the complete original payload.",
          "analysis-warning",
        ),
      );
    const related =
      run?.findings.filter((finding) => finding.callOrders.includes(call.order)) ?? [];
    for (const finding of related)
      detail.append(
        button(finding.title, () => {
          saveScroll();
          view = "recommendations";
          draw();
          content
            .querySelector(`[data-finding="${CSS.escape(finding.id)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }),
      );
    if (!missing(call))
      detail.append(
        button(
          original?.order === call.order ? "Hide original payload" : "Load original payload",
          () => {
            if (original?.order === call.order) {
              original = null;
              payloadRequest++;
              drawDetail();
            } else void loadOriginal(call);
          },
        ),
      );
    detail.append(
      node(
        "pre",
        original?.order === call.order
          ? original.text
          : call.excerpt || "No response excerpt was captured.",
        "analysis-payload",
      ),
    );
    detail.scrollTop = offset;
  }
  async function loadOriginal(call: AnalysisCall) {
    if (!run || !history) return;
    const ticket = ++payloadRequest,
      generation = history.generation,
      runId = run.id;
    try {
      const result = await api.inspect(generation, call.order, 1);
      if (
        ticket !== payloadRequest ||
        history?.generation !== generation ||
        run?.id !== runId ||
        workspace().focus !== call.order
      )
        return;
      if (!("selected" in result) || result.selected?.id !== call.order) {
        message = "The original event is unavailable. No neighboring payload was substituted.";
        drawStatus();
        return;
      }
      original = { order: call.order, text: result.selected.text };
      drawDetail();
    } catch (error) {
      if (ticket === payloadRequest) report(error);
    }
  }
  function drawBody() {
    if (!visible()) return;
    const current = workspace();
    content.replaceChildren();
    const calls = filteredCalls();
    if (!run)
      content.append(
        node(
          "p",
          selectedSession
            ? "Analyze this session to inspect its tool calls and review suggestions. Choose the model above before starting."
            : "Choose a captured session to begin.",
          "analysis-empty",
        ),
      );
    else if (view === "recommendations") drawFindings();
    else if (!calls.length)
      content.append(
        node(
          "p",
          run.snapshot.calls.length
            ? "No matching calls. Reset filters to see the snapshot."
            : "No supported tool calls were captured in this snapshot.",
          "analysis-empty",
        ),
      );
    else drawCalls(calls);
    drawFocus(calls);
    drawDetail();
    content.scrollTop = current.views[view].scroll;
    exportButton.hidden = view !== "recommendations";
    exportButton.disabled =
      !run || run.state !== "completed" || !Object.values(run.decisions).includes("kept");
  }
  function drawSetup() {
    const compact = matchMedia("(max-width: 720px)").matches && !!run;
    const toggle = requiredElement<HTMLButtonElement>("#analysis-settings-toggle");
    toggle.hidden = !compact;
    toggle.textContent = setupExpanded
      ? "Hide session and model controls"
      : `${selectedLabel || selectedSession} · ${run?.model ?? model.value} · Change`;
    toggle.setAttribute("aria-expanded", String(setupExpanded));
    requiredElement<HTMLElement>("#analysis-setup").hidden = compact && !setupExpanded;
    drawStatus();
  }
  function draw() {
    if (!visible()) return;
    drawSetup();
    const current = workspace();
    search.value = current.views[view].search;
    sort.value = current.views[view].sort;
    sort.hidden = view === "recommendations";
    group.replaceChildren(
      option("All observed models", ""),
      ...[...new Set((run?.snapshot.calls ?? []).map((call) => call.model ?? "@unknown"))].map(
        (value) => option(value === "@unknown" ? "Model unknown" : value, value),
      ),
    );
    group.value = current.group;
    document
      .querySelectorAll<HTMLButtonElement>("[data-analysis-view]")
      .forEach((item) =>
        item.setAttribute("aria-pressed", String(item.dataset.analysisView === view)),
      );
    drawRunControls();
    drawCoverage();
    drawBody();
  }
  requiredElement("#open-analysis").addEventListener("click", () => {
    if (!panel.hidden) saveScroll();
    panel.hidden = !panel.hidden;
    document.body.classList.toggle("analysis-open", !panel.hidden);
    journalVisible(panel.hidden);
    requiredElement("h1").textContent = panel.hidden ? "Event journal" : "Session analyzer";
    requiredElement("#open-analysis").textContent = panel.hidden
      ? "Analyze session"
      : "Event journal";
    if (!panel.hidden) {
      if (!selectedSession && journalSession()) {
        selectedSession = journalSession()!;
        selectedLabel = selectedSession;
      }
      draw();
      void loadSessions();
      void refresh();
    }
  });
  session.addEventListener("pointerdown", () => void loadSessions());
  session.addEventListener("keydown", (event) => {
    if (["Enter", " ", "ArrowDown"].includes(event.key)) void loadSessions();
  });
  session.addEventListener("change", () => {
    if (session.value === "@next" || session.value === "@previous") {
      const previous = session.value === "@previous";
      drawSessions();
      void loadSessions(
        previous ? page.values[0] : page.values.at(-1),
        previous ? "previous" : "next",
      );
      return;
    }
    saveScroll();
    selectedSession = session.value ? JSON.parse(session.value) : "";
    setupExpanded = true;
    selectedLabel = session.selectedOptions[0]?.textContent ?? "";
    run = null;
    original = null;
    payloadRequest++;
    request++;
    loading = false;
    message = "";
    defaultWorkspace = createWorkspace();
    draw();
    void refresh();
  });
  runSelect.addEventListener("change", () => {
    saveScroll();
    message = "";
    void refresh(runSelect.value);
  });
  requiredElement("#analysis-settings-toggle").addEventListener("click", () => {
    setupExpanded = !setupExpanded;
    drawSetup();
  });
  window.addEventListener("resize", () => {
    if (visible()) drawSetup();
  });
  model.addEventListener("input", drawStatus);
  fresh.addEventListener("change", drawStatus);
  start.addEventListener("click", async () => {
    if (start.disabled || !history) return;
    const generation = history.generation,
      sessionId = selectedSession;
    busy = true;
    message = "";
    drawStatus();
    try {
      const next = await api.analysisStart(
        generation,
        sessionId,
        model.value.trim(),
        !fresh.checked && run ? run.id : null,
      );
      if (generation !== history?.generation || sessionId !== selectedSession) return;
      state = next;
      setupExpanded = false;
      await refresh(run?.state === "completed" ? run.id : next.activeRunId || undefined);
    } catch (error) {
      if (history?.generation === generation && selectedSession === sessionId) report(error);
    } finally {
      busy = false;
      drawStatus();
    }
  });
  requiredElement("#analysis-cancel-compact").addEventListener("click", () => cancel.click());
  cancel.addEventListener("click", async () => {
    if (!history || busy) return;
    busy = true;
    drawStatus();
    try {
      await api.analysisCancel(history.generation);
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      busy = false;
      drawStatus();
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-analysis-view]").forEach((item) =>
    item.addEventListener("click", () => {
      saveScroll();
      view = item.dataset.analysisView as View;
      draw();
    }),
  );
  search.addEventListener("input", () => {
    workspace().views[view].search = search.value;
    workspace().views[view].scroll = 0;
    drawBody();
  });
  sort.addEventListener("change", () => {
    workspace().views[view].sort = sort.value;
    workspace().views[view].scroll = 0;
    drawBody();
  });
  group.addEventListener("change", () => {
    workspace().group = group.value;
    drawBody();
  });
  requiredElement("#analysis-reset").addEventListener("click", () => {
    workspace().group = "";
    workspace().views[view].search = "";
    workspace().views[view].scroll = 0;
    draw();
  });
  exportButton.addEventListener("click", async () => {
    if (!history || !run) return;
    const generation = history.generation,
      runId = run.id;
    try {
      const exported = await api.analysisExport(generation, runId);
      if (history?.generation !== generation || run?.id !== runId) return;
      message = exported ? "Kept suggestions exported." : "Export cancelled.";
      drawStatus();
    } catch (error) {
      if (history?.generation === generation && run?.id === runId) report(error);
    }
  });
  function receive(value: HistoryStatus) {
    const changed = history?.generation !== value.generation;
    const evicted = history?.first?.id !== value.first?.id;
    history = value;
    if (changed) {
      request++;
      choiceRequest++;
      payloadRequest++;
      loading = false;
      workspaces.clear();
      run = null;
      state = null;
      original = null;
      selectedSession = "";
      selectedLabel = "";
      page = { values: [] };
      pageCursor = null;
      pageDirection = "next";
      defaultWorkspace = createWorkspace();
      message = "";
      dirty = true;
      if (visible()) {
        drawSessions();
        draw();
        void loadSessions();
        void refresh();
      }
    } else if (evicted) {
      if (selectedCall() && missing(selectedCall()!)) {
        original = null;
        payloadRequest++;
      }
      if (visible()) {
        drawDetail();
        drawStatus();
      }
    }
  }
  api.onAnalysis(() => {
    dirty = true;
    if (visible()) {
      saveScroll();
      void refresh();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (visible() && dirty) void refresh();
  });
  return { receive };
}
