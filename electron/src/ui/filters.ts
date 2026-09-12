import type { ChoiceField, ChoicePage, Direction, Filter } from "../types.ts";
import { requiredElement } from "./elements.ts";
export function attachFilters({
  getGeneration,
  changed,
  error,
}: {
  getGeneration: () => number;
  changed: (filter: Filter, delay: number) => void;
  error: (message: string) => void;
}) {
  const search = requiredElement<HTMLInputElement>("#search");
  const session = requiredElement<HTMLSelectElement>("#session");
  session.title =
    "Labels use last observed Git metadata or the hook working directory. Branch changes may appear after later events.";
  const hooks = requiredElement<HTMLDetailsElement>("#hooks");
  const hookLabel = requiredElement("#hook-label");
  const menu = requiredElement("#hookmenu");
  const selectedHooks = new Set<string>();
  let selectedSession: string | null = null;
  let selectedLabel: string | null = null;
  const pages: Record<ChoiceField, ChoicePage> = { session: { values: [] }, hook: { values: [] } };
  const pending = new Map<
    ChoiceField,
    { generation: number; cursor: string | null; direction: Direction }
  >();
  let loading = false,
    disabled = false;
  const value = () => ({ text: search.value, session: selectedSession, hooks: [...selectedHooks] });
  function notify(delay = 0) {
    if (!disabled) changed(value(), delay);
  }
  function option(text: string, value: string) {
    const node = document.createElement("option");
    node.textContent = text;
    node.value = value;
    return node;
  }
  function button(text: string, action: () => void) {
    const node = document.createElement("button");
    node.textContent = text;
    node.addEventListener("click", action);
    return node;
  }
  function draw(field: ChoiceField) {
    const page = pages[field];
    if (field === "session") {
      session.replaceChildren(option("All sessions", ""));
      const values =
        selectedSession !== null && !page.values.includes(selectedSession)
          ? [selectedSession, ...page.values]
          : page.values;
      for (const name of values) {
        const index = page.values.indexOf(name);
        const label =
          index >= 0
            ? (page.labels?.[index] ?? name)
            : ((name === selectedSession ? selectedLabel : null) ?? name);
        if (name === selectedSession) selectedLabel = label;
        const item = option(label || "Empty session ID", JSON.stringify(name));
        item.title = name;
        session.append(item);
      }
      if (page.previous) session.append(option("Previous sessions…", "@previous"));
      if (page.next) session.append(option("More sessions…", "@next"));
      session.value = selectedSession === null ? "" : JSON.stringify(selectedSession);
    } else {
      requiredElement("#hook-label").textContent = selectedHooks.size
        ? `${selectedHooks.size} hook ${selectedHooks.size === 1 ? "type" : "types"}`
        : "All hooks";
      menu.replaceChildren();
      if (selectedHooks.size)
        menu.append(
          button("All hooks", () => {
            selectedHooks.clear();
            draw("hook");
            notify();
          }),
        );
      const values = [...new Set([...selectedHooks, ...page.values])];
      for (const name of values) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = selectedHooks.has(name);
        input.addEventListener("change", () => {
          if (input.checked) selectedHooks.add(name);
          else selectedHooks.delete(name);
          if (
            selectedHooks.size > 32 ||
            new TextEncoder().encode(JSON.stringify(value())).length > 128 * 1024
          ) {
            selectedHooks.delete(name);
            input.checked = false;
            error("Choose fewer hook types before adding another.");
            return;
          }
          requiredElement("#hook-label").textContent = selectedHooks.size
            ? `${selectedHooks.size} hook ${selectedHooks.size === 1 ? "type" : "types"}`
            : "All hooks";
          notify();
        });
        label.append(input, document.createTextNode(name || "Empty hook type"));
        menu.append(label);
      }
      if (page.previous)
        menu.append(button("Previous hooks", () => load(field, page.values[0], "previous")));
      if (page.next)
        menu.append(button("More hooks", () => load(field, page.values.at(-1), "next")));
    }
  }
  async function load(
    field: ChoiceField,
    cursor: string | null = null,
    direction: Direction = "next",
  ) {
    if (disabled) return;
    pending.set(field, { generation: getGeneration(), cursor, direction });
    if (loading) return;
    loading = true;
    try {
      while (pending.size) {
        const [field, request] = pending.entries().next().value!;
        pending.delete(field);
        const result = await window.scope.choices(
          request.generation,
          field,
          request.cursor,
          request.direction,
        );
        if (
          disabled ||
          request.generation !== getGeneration() ||
          result.stale ||
          pending.has(field)
        )
          continue;
        if (result.error) {
          error(result.error);
          continue;
        }
        if (!("values" in result)) continue;
        pages[field] = result;
        draw(field);
      }
    } catch {
      if (!disabled) error("Filter choices could not be loaded. Open the filter to try again.");
    } finally {
      loading = false;
    }
  }
  search.addEventListener("input", () => notify(180));
  session.addEventListener("change", () => {
    if (disabled) return;
    if (session.value.startsWith("@")) {
      const direction = session.value.slice(1) as Direction;
      void load(
        "session",
        direction === "previous" ? pages.session.values[0] : pages.session.values.at(-1),
        direction,
      );
      session.value = selectedSession === null ? "" : JSON.stringify(selectedSession);
      return;
    }
    const previous = selectedSession;
    const previousLabel = selectedLabel;
    selectedLabel = session.selectedOptions[0]?.textContent ?? null;
    selectedSession = session.value === "" ? null : JSON.parse(session.value);
    if (new TextEncoder().encode(JSON.stringify(value())).length > 128 * 1024) {
      selectedSession = previous;
      selectedLabel = previousLabel;
      draw("session");
      error("Clear some hook choices before selecting this session.");
      return;
    }
    notify();
  });
  session.addEventListener("focus", () => load("session"));
  session.addEventListener("pointerdown", () => load("session"));
  hooks.addEventListener("toggle", () => {
    if (hooks.open) void load("hook");
  });
  hookLabel.addEventListener("click", (event) => {
    if (disabled) event.preventDefault();
  });
  function disable(next: boolean) {
    if (disabled === next) return;
    disabled = next;
    search.disabled = session.disabled = disabled;
    hookLabel.setAttribute("aria-disabled", String(disabled));
    hookLabel.tabIndex = disabled ? -1 : 0;
    if (disabled) {
      hooks.open = false;
      pending.clear();
    }
  }
  function refresh() {
    void load("session");
    void load("hook");
  }
  function reset() {
    if (disabled) return;
    search.value = "";
    selectedSession = null;
    selectedLabel = null;
    selectedHooks.clear();
    draw("session");
    draw("hook");
    notify();
  }
  return { value, refresh, reset, disable };
}
