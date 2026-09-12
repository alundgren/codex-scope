export interface ModelSelection {
  model: string;
  effort: string;
}
export interface CatalogModel {
  id: string;
  model: string;
  hidden: boolean;
  efforts: string[];
}
export interface ModelCatalog {
  models: CatalogModel[];
  complete: boolean;
  error?: string;
}
export const emptySelection = (): ModelSelection => ({ model: "", effort: "" });
export const validModel = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value);
export const validEffort = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
export function validSelection(value: unknown): value is ModelSelection {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 2) return false;
  const pair = value as ModelSelection;
  return (
    (pair.model === "" || validModel(pair.model)) &&
    (pair.effort === "" || validEffort(pair.effort)) &&
    (!!pair.model || !pair.effort)
  );
}
export function selectionError(catalog: ModelCatalog, pair: ModelSelection): string | null {
  if (!pair.model || !pair.effort)
    return "Choose a model and reasoning effort in Settings before starting.";
  if (!catalog.complete)
    return catalog.error ?? "Refresh the model catalog in Settings before starting.";
  const model = catalog.models.find((entry) => entry.model === pair.model);
  if (!model)
    return "The selected model is unavailable in the current catalog. Choose another model in Settings.";
  if (!model.efforts.includes(pair.effort))
    return "The selected effort is unavailable for this model. Choose a supported effort in Settings.";
  return null;
}
