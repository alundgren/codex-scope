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
  const opener = requiredElement<HTMLButtonElement>("#filter-open");
  const picker = requiredElement("#filter-picker");
  const choices = requiredElement("#filter-choices");
  const chips = requiredElement("#filter-chips");
  type Field = "session" | "tool" | "model" | "prefix" | "size";
  let field: Field = "session",
    disabled = false,
    loading = false,
    revision = 0;
  let choiceText = "",
    timer: ReturnType<typeof setTimeout> | undefined;
  let pending: {
    field: ChoiceField;
    cursor: string | null;
    direction: Direction;
    text: string;
    revision: number;
    generation: number;
  } | null = null;
  let page: ChoicePage = { values: [] };
  let filter: Filter;
  const labels = new Map<string, string>();
  const blank = (): Filter => ({
    text: "",
    session: null,
    hooks: ["PostToolUse"],
    sessions: [],
    tools: [],
    models: [],
    prefix: "",
    minimumBytes: null,
    unknownBytes: false,
    sort: "newest",
  });
  filter = blank();
  const value = (): Filter => ({
    ...filter,
    text: search.value,
    sessions: [...filter.sessions!],
    tools: [...filter.tools!],
    models: [...filter.models!],
  });
  function button(text: string, action: () => void) {
    const node = document.createElement("button");
    node.textContent = text;
    node.addEventListener("click", action);
    return node;
  }
  function notify(delay = 0) {
    drawChips();
    if (!disabled) changed(value(), delay);
  }
  function selection() {
    return field === "session"
      ? filter.sessions!
      : field === "tool"
        ? filter.tools!
        : filter.models!;
  }
  function close() {
    picker.hidden = true;
    opener.setAttribute("aria-expanded", "false");
    revision++;
    pending = null;
    clearTimeout(timer);
  }
  function drawChips() {
    chips.replaceChildren();
    for (const [key, names] of [
      ["sessions", filter.sessions!],
      ["tools", filter.tools!],
      ["models", filter.models!],
    ] as const) {
      for (const name of names) {
        const label =
          name === null ? "Unknown model" : key === "sessions" ? (labels.get(name) ?? name) : name;
        const chip = button(`${label || "Empty value"} ×`, () => {
          const names = filter[key] as (string | null)[];
          names.splice(names.indexOf(name), 1);
          if (key === "sessions" && name !== null) labels.delete(name);
          notify();
          if (!picker.hidden) draw();
        });
        chip.className = "filter-chip";
        chip.title = name ?? "Unknown model";
        chip.setAttribute("aria-label", `Remove ${label || "empty value"}`);
        chips.append(chip);
      }
    }
    for (const [key, label] of [
      ["prefix", filter.prefix ? `Prefix ${filter.prefix}` : ""],
      [
        "minimumBytes",
        filter.minimumBytes != null ? `> ${filter.minimumBytes.toLocaleString()} B` : "",
      ],
      ["unknownBytes", filter.unknownBytes ? "Size unknown" : ""],
    ] as const) {
      if (!label) continue;
      const chip = button(`${label} ×`, () => {
        if (key === "prefix") filter.prefix = "";
        else if (key === "minimumBytes") filter.minimumBytes = null;
        else filter.unknownBytes = false;
        notify();
        if (!picker.hidden) draw();
      });
      chip.className = "filter-chip";
      chip.setAttribute("aria-label", `Remove ${label}`);
      chips.append(chip);
    }
  }
  function checkChoice(name: string | null, label: string) {
    const row = document.createElement("label");
    row.className = "filter-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selection().includes(name as never);
    const text = document.createElement("span");
    text.textContent = label;
    text.title = name ?? "Unknown model";
    input.addEventListener("change", () => {
      const selected = selection() as (string | null)[];
      if (input.checked) selected.push(name);
      else selected.splice(selected.indexOf(name), 1);
      if (
        selected.length > 32 ||
        new TextEncoder().encode(JSON.stringify(value())).length > 128 * 1024
      ) {
        selected.pop();
        input.checked = false;
        error("Choose fewer values before adding another.");
        return;
      }
      if (field === "session" && name !== null) {
        if (input.checked) labels.set(name, label);
        else labels.delete(name);
      }
      notify();
    });
    row.append(input, text);
    return row;
  }
  function drawOptions() {
    const host = requiredElement("#filter-options");
    host.replaceChildren();
    if (field === "model" && (!choiceText || "unknown model".includes(choiceText.toLowerCase())))
      host.append(checkChoice(null, "Unknown model"));
    page.values.forEach((name, index) => {
      const label = page.labels?.[index] ?? (name || "Empty value");
      if (field === "session" && filter.sessions!.includes(name)) labels.set(name, label);
      host.append(checkChoice(name, label));
    });
    drawChips();
    if (!host.children.length) host.textContent = "No choices found.";
    const pager = requiredElement("#filter-pages");
    pager.replaceChildren();
    if (page.previous) pager.append(button("Previous", () => load(page.values[0], "previous")));
    if (page.next) pager.append(button("More", () => load(page.values.at(-1), "next")));
  }
  async function load(cursor: string | null = null, direction: Direction = "next") {
    if (disabled || field === "prefix" || field === "size" || picker.hidden) return;
    pending = { field, cursor, direction, text: choiceText, revision, generation: getGeneration() };
    if (loading) return;
    loading = true;
    try {
      while (pending) {
        const request = pending;
        pending = null;
        const result = await window.scope.choices(
          request.generation,
          request.field,
          request.cursor,
          request.direction,
          request.text,
        );
        if (
          disabled ||
          picker.hidden ||
          request.revision !== revision ||
          request.generation !== getGeneration() ||
          result.stale ||
          pending
        )
          continue;
        if (result.error) {
          error(result.error);
          continue;
        }
        if ("values" in result) {
          page = result;
          drawOptions();
        }
      }
    } catch {
      if (!disabled && !picker.hidden)
        error("Filter choices could not be loaded. Open the filter to try again.");
    } finally {
      loading = false;
    }
  }
  function draw() {
    revision++;
    clearTimeout(timer);
    pending = null;
    for (const item of picker.querySelectorAll<HTMLButtonElement>("[data-field]"))
      item.setAttribute("aria-pressed", String(item.dataset.field === field));
    choices.replaceChildren();
    if (field === "prefix") {
      const label = document.createElement("label");
      label.textContent = "Starts exactly with";
      label.htmlFor = "command-prefix";
      const input = document.createElement("input");
      input.id = "command-prefix";
      input.value = filter.prefix ?? "";
      input.placeholder = "rg";
      input.maxLength = 512;
      const apply = button("Apply prefix", () => {
        filter.prefix = input.value;
        notify();
      });
      apply.className = "apply-filter";
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") apply.click();
      });
      choices.append(label, input, apply);
      return;
    }
    if (field === "size") {
      const label = document.createElement("label");
      label.textContent = "Response larger than";
      label.htmlFor = "response-size";
      const row = document.createElement("div");
      row.className = "size-input";
      const input = document.createElement("input");
      input.id = "response-size";
      input.type = "number";
      input.min = "0";
      input.step = "any";
      input.placeholder = "10";
      input.value = filter.minimumBytes === null ? "" : String(filter.minimumBytes);
      const unit = document.createElement("select");
      unit.setAttribute("aria-label", "Response size unit");
      for (const name of ["B", "KB", "MB"]) {
        const option = document.createElement("option");
        option.textContent = name;
        unit.append(option);
      }
      row.append(input, unit);
      const apply = button("Apply size", () => {
        const amount = Number(input.value) * ({ B: 1, KB: 1000, MB: 1e6 }[unit.value] ?? 1);
        if (
          input.value === "" ||
          !Number.isFinite(amount) ||
          amount < 0 ||
          amount > Number.MAX_SAFE_INTEGER
        ) {
          error("Enter a response size of zero or more.");
          return;
        }
        filter.minimumBytes = amount;
        notify();
      });
      apply.className = "apply-filter";
      const unknown = document.createElement("label");
      unknown.className = "filter-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = filter.unknownBytes ?? false;
      checkbox.addEventListener("change", () => {
        filter.unknownBytes = checkbox.checked;
        notify();
      });
      unknown.append(checkbox, document.createTextNode("Size unknown"));
      choices.append(label, row, apply, unknown);
      return;
    }
    const input = document.createElement("input");
    input.type = "search";
    input.maxLength = 512;
    input.value = choiceText;
    input.placeholder = `Search ${field}s…`;
    input.setAttribute("aria-label", `Search ${field} choices`);
    input.addEventListener("input", () => {
      choiceText = input.value;
      revision++;
      clearTimeout(timer);
      timer = setTimeout(() => load(), 180);
    });
    const options = document.createElement("div");
    options.id = "filter-options";
    options.textContent = "Loading choices…";
    const pages = document.createElement("div");
    pages.id = "filter-pages";
    pages.className = "filter-pages";
    choices.append(input, options, pages);
    void load();
  }
  opener.addEventListener("click", () => {
    if (disabled) return;
    if (!picker.hidden) {
      close();
      return;
    }
    picker.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    choiceText = "";
    draw();
    choices.querySelector("input")?.focus();
  });
  for (const item of picker.querySelectorAll<HTMLButtonElement>("[data-field]"))
    item.addEventListener("click", () => {
      field = item.dataset.field as Field;
      choiceText = "";
      draw();
    });
  requiredElement("#filter-done").addEventListener("click", () => {
    close();
    opener.focus();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!picker.hidden && !(e.target as Element).closest(".filterbar,#filter-picker")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !picker.hidden) {
      close();
      opener.focus();
    }
  });
  search.addEventListener("input", () => notify(180));
  function reset() {
    if (disabled) return;
    const sort = filter.sort;
    filter = blank();
    filter.sort = sort;
    search.value = "";
    labels.clear();
    notify();
    if (!picker.hidden) draw();
  }
  requiredElement("#filter-reset").addEventListener("click", reset);
  function disable(next: boolean) {
    disabled = next;
    search.disabled = opener.disabled = next;
    if (next) close();
  }
  return {
    value,
    reset,
    disable,
    refresh: () => {
      if (!picker.hidden) draw();
    },
    sort: (sort: "newest" | "largest") => {
      filter.sort = sort;
      notify(60);
    },
  };
}
