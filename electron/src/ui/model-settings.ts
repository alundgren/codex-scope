import { type ModelCatalog, type ModelSelection, selectionError } from "../model-types.ts";
import { requiredElement } from "./elements.ts";
export function attachModelSettings() {
  const diagnosis = requiredElement<HTMLSelectElement>("#analysis-model");
  const diagnosisEffort = requiredElement<HTMLSelectElement>("#analysis-effort");
  const review = requiredElement<HTMLSelectElement>("#review-model");
  const reviewEffort = requiredElement<HTMLSelectElement>("#review-effort");
  const status = requiredElement("#model-status");
  const refresh = requiredElement<HTMLButtonElement>("#model-refresh");
  const cancel = requiredElement<HTMLButtonElement>("#model-cancel");
  const pairs = [
    [diagnosis, diagnosisEffort],
    [review, reviewEffort],
  ] as const;
  let catalog: ModelCatalog = { models: [], complete: false };
  let loading = false,
    epoch = 0;
  const selections = () =>
    pairs.map(([model, effort]) => ({ model: model.value, effort: effort.value }));
  const option = (label: string, value: string) => new Option(label, value);
  function notifySelection() {
    for (const [model] of pairs) {
      model.dispatchEvent(new Event("input"));
    }
  }
  function render(values = selections()) {
    pairs.forEach(([model, effort], i) => {
      const pair = values[i];
      model.replaceChildren(
        option("Choose a model", ""),
        ...catalog.models.map((entry) =>
          option(
            `${entry.id}${entry.id === entry.model ? "" : ` (${entry.model})`}${entry.hidden ? " · hidden" : ""}${entry.efforts.length ? "" : " · no supported efforts"}`,
            entry.model,
          ),
        ),
      );
      if (pair.model && !catalog.models.some((entry) => entry.model === pair.model))
        model.add(
          option(
            `${pair.model} · ${catalog.complete ? "unavailable" : "not verified"}`,
            pair.model,
          ),
        );
      model.value = pair.model;
      const supported = catalog.models.find((entry) => entry.model === pair.model)?.efforts ?? [];
      effort.replaceChildren(
        option("Choose an effort", ""),
        ...supported.map((value) => option(value, value)),
      );
      if (pair.effort && !supported.includes(pair.effort))
        effort.add(
          option(
            `${pair.effort} · ${catalog.complete ? "unavailable" : "not verified"}`,
            pair.effort,
          ),
        );
      effort.value = pair.effort;
    });
    notifySelection();
  }
  async function discover() {
    if (loading) return;
    loading = true;
    const current = ++epoch;
    refresh.disabled = true;
    cancel.hidden = false;
    status.textContent = "Reading models from the local Codex CLI…";
    try {
      const result = await window.scope.models();
      if (current !== epoch) return;
      catalog = result;
      render();
      const stale = selections().some(
        (pair) => pair.model && pair.effort && selectionError(catalog, pair),
      );
      status.textContent =
        result.error ??
        `${catalog.models.length} ${catalog.models.length === 1 ? "model" : "models"}. Hidden entries are included. ${stale ? "A saved choice is unavailable. Choose a supported model and effort." : "Choose both values explicitly; account access is checked when work starts."}`;
    } catch {
      if (current !== epoch) return;
      catalog = { models: [], complete: false };
      render();
      status.textContent = "Model discovery failed. Check the local CLI and refresh to retry.";
    } finally {
      loading = false;
      refresh.disabled = false;
      cancel.hidden = true;
    }
  }
  for (const [model, effort] of pairs) {
    model.addEventListener("pointerdown", () => void discover());
    model.addEventListener("focus", () => void discover());
    model.addEventListener("keydown", (event) => {
      if ([" ", "Enter", "F4"].includes(event.key) || (event.altKey && event.key === "ArrowDown"))
        void discover();
    });
    model.addEventListener("change", () => {
      const values = selections();
      values[pairs.findIndex((pair) => pair[0] === model)].effort = "";
      render(values);
    });
    effort.addEventListener("change", notifySelection);
  }
  refresh.addEventListener("click", () => void discover());
  const stop = () => {
    if (!loading) return;
    epoch++;
    window.scope.cancelModels();
    catalog = { ...catalog, complete: false };
    notifySelection();
    status.textContent = "Model discovery cancelled. Refresh models to try again.";
  };
  cancel.addEventListener("click", stop);
  render();
  return {
    apply(diagnosis: ModelSelection, review: ModelSelection) {
      render([diagnosis, review]);
    },
    values() {
      const [diagnosis, review] = selections();
      return { diagnosis, review };
    },
    disable(value: boolean) {
      for (const pair of pairs) for (const control of pair) control.disabled = value;
    },
    stop,
  };
}
