import { type ModelCatalog, type ModelSelection, selectionError } from "../model-types.ts";
import { requiredElement } from "./elements.ts";
export function attachModelSettings() {
  const diagnosis = requiredElement<HTMLSelectElement>("#analysis-model");
  const diagnosisEffort = requiredElement<HTMLSelectElement>("#analysis-effort");
  const status = requiredElement("#model-status");
  const refresh = requiredElement<HTMLButtonElement>("#model-refresh");
  const cancel = requiredElement<HTMLButtonElement>("#model-cancel");
  let catalog: ModelCatalog = { models: [], complete: false };
  let loading = false,
    epoch = 0;
  const selection = () => ({ model: diagnosis.value, effort: diagnosisEffort.value });
  const option = (label: string, value: string) => new Option(label, value);
  function notifySelection() {
    diagnosis.dispatchEvent(new Event("input"));
  }
  function render(value = selection()) {
    diagnosis.replaceChildren(
      option("Choose a model", ""),
      ...catalog.models.map((entry) =>
        option(
          `${entry.id}${entry.id === entry.model ? "" : ` (${entry.model})`}${entry.hidden ? " · hidden" : ""}${entry.efforts.length ? "" : " · no supported efforts"}`,
          entry.model,
        ),
      ),
    );
    if (value.model && !catalog.models.some((entry) => entry.model === value.model))
      diagnosis.add(
        option(
          `${value.model} · ${catalog.complete ? "unavailable" : "not verified"}`,
          value.model,
        ),
      );
    diagnosis.value = value.model;
    const supported = catalog.models.find((entry) => entry.model === value.model)?.efforts ?? [];
    diagnosisEffort.replaceChildren(
      option("Choose an effort", ""),
      ...supported.map((effort) => option(effort, effort)),
    );
    if (value.effort && !supported.includes(value.effort))
      diagnosisEffort.add(
        option(
          `${value.effort} · ${catalog.complete ? "unavailable" : "not verified"}`,
          value.effort,
        ),
      );
    diagnosisEffort.value = value.effort;
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
      const value = selection();
      const stale = value.model && value.effort && selectionError(catalog, value);
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
  diagnosis.addEventListener("pointerdown", () => void discover());
  diagnosis.addEventListener("focus", () => void discover());
  diagnosis.addEventListener("keydown", (event) => {
    if ([" ", "Enter", "F4"].includes(event.key) || (event.altKey && event.key === "ArrowDown"))
      void discover();
  });
  diagnosis.addEventListener("change", () => render({ model: diagnosis.value, effort: "" }));
  diagnosisEffort.addEventListener("change", notifySelection);
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
    apply(diagnosis: ModelSelection) {
      render(diagnosis);
    },
    values() {
      return { diagnosis: selection() };
    },
    disable(value: boolean) {
      diagnosis.disabled = diagnosisEffort.disabled = value;
    },
    stop,
  };
}
