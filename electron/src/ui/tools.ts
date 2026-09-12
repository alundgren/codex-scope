import { attachReview } from "./review.ts";
import { attachModelSettings } from "./model-settings.ts";
import type { HistoryStatus, ConnectionSettings, Reply } from "../types.ts";
import { connectionInput } from "../connection-input.ts";
import { requiredElement } from "./elements.ts";
export function attachTools(analyzer: { show(open: boolean): void }, journal: () => void) {
  const review = attachReview();
  const menu = requiredElement<HTMLDetailsElement>("#functions");
  const search = requiredElement<HTMLInputElement>("#function-search");
  const endpoint = requiredElement<HTMLInputElement>("#collector-url");
  const token = requiredElement<HTMLInputElement>("#collector-token");
  const models = attachModelSettings();
  const status = requiredElement("#settings-status");
  const capture = requiredElement<HTMLButtonElement>("#capture");
  const save = requiredElement<HTMLButtonElement>("#settings-save");
  let capturing = false,
    busy = false,
    initialized = false;
  let view = "idle";
  let pendingSave: number | null = null;
  let settingsSave: HistoryStatus["settingsSave"];
  function unlockSave() {
    busy = false;
    models.disable(false);
    save.disabled = capture.disabled = endpoint.disabled = token.disabled = false;
  }
  function saved(value: Reply<ConnectionSettings>) {
    if (value.error) status.textContent = value.error;
    else if ("endpoint" in value) {
      apply(value);
      status.textContent = "Settings saved.";
    } else
      status.textContent =
        "The save result could not be confirmed. Restart Scope and check Settings.";
  }
  function settleSave() {
    if (!pendingSave || settingsSave?.id !== pendingSave) return;
    saved(settingsSave.result);
    pendingSave = null;
    unlockSave();
  }
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-tool]")];
  function show(next: string) {
    if (view === "settings" && next !== "settings") models.stop();
    view = next;
    review.show(next === "review");
    document.body.classList.toggle("tool-open", next !== "journal");
    analyzer.show(next === "analysis");
    for (const [id, name] of [
      ["idle", "idle"],
      ["settings", "settings"],
      ["review-entry", "review"],
    ])
      requiredElement(`#${id}`).hidden = name !== next;
    requiredElement("h1").textContent = (
      {
        idle: "Codex Scope",
        journal: "Event journal",
        analysis: "Session analyzer",
        settings: "Settings",
        review: "PR review",
      } as Record<string, string>
    )[next];
    menu.open = false;
    if (next === "journal") journal();
  }
  function apply(value: Awaited<ReturnType<typeof window.scope.settings>>) {
    endpoint.value = value.endpoint;
    token.value = "";
    models.apply(value.diagnosis, value.review);
    requiredElement("#token-state").textContent = value.hasToken
      ? "A token is saved. Leave blank to keep it, or enter a replacement."
      : "Enter a token.";
    requiredElement("#settings-override").hidden = !value.commandLineOverride;
    status.textContent = value.error ?? "";
  }
  void window.scope
    .settings()
    .then(apply)
    .catch(() => {
      status.textContent = "Settings could not be loaded. Try saving again.";
    });
  for (const button of buttons) button.addEventListener("click", () => show(button.dataset.tool!));
  search.addEventListener("input", () => {
    for (const button of buttons)
      button.hidden = !button
        .textContent!.toLowerCase()
        .includes(search.value.toLowerCase().trim());
    requiredElement("#function-empty").hidden = buttons.some((button) => !button.hidden);
  });
  menu.addEventListener("toggle", () => {
    if (menu.open) {
      search.value = "";
      search.dispatchEvent(new Event("input"));
      search.focus();
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      menu.open = false;
      menu.querySelector("summary")!.focus();
    }
    if (event.key === "Enter" && event.target === search) {
      event.preventDefault();
      buttons.find((button) => !button.hidden)?.click();
    }
  });
  endpoint.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") ?? "";
    if (!text.includes("?")) return;
    event.preventDefault();
    try {
      const value = connectionInput(text, "");
      endpoint.value = value.endpoint;
      token.value = value.token;
      status.textContent = "Pairing URL split into collector URL and token. Save to apply.";
    } catch {
      status.textContent =
        "Pairing URL is invalid. Use an origin URL or a link with exactly one valid token parameter.";
    }
  });
  requiredElement<HTMLFormElement>("#connection-settings").addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      models.disable(true);
      save.disabled = capture.disabled = endpoint.disabled = token.disabled = true;
      status.textContent = "Saving settings…";
      try {
        const value = await window.scope.saveSettings({
          endpoint: endpoint.value,
          token: token.value,
          ...models.values(),
        });
        if (value.pending) {
          pendingSave = value.pending;
          status.textContent = "Still saving settings. You can stop capture while you wait.";
          capture.disabled = !capturing;
          settleSave();
        } else saved(value);
      } catch {
        status.textContent = "Settings were not saved. Check the values and try again.";
      } finally {
        if (!pendingSave) unlockSave();
      }
    },
  );
  capture.addEventListener("click", async () => {
    if (busy && !(pendingSave && capturing)) return;
    busy = true;
    capture.disabled = save.disabled = true;
    const start = !capturing;
    try {
      const result = await window.scope.capture(start);
      if (result.error) {
        show("settings");
        status.textContent = result.error;
      } else if (view === "idle" && start) show("journal");
    } catch {
      show("settings");
      status.textContent = "Capture could not change. Try again.";
    } finally {
      if (!pendingSave) {
        busy = false;
        save.disabled = false;
      }
      capture.disabled = busy && !(pendingSave && capturing);
    }
  });
  show("idle");
  return {
    receive(value: HistoryStatus) {
      capturing = !!value.capturing;
      settingsSave = value.settingsSave;
      settleSave();
      if (pendingSave && value.error) {
        status.textContent =
          "The save result could not be confirmed. Restart Scope and check Settings.";
        pendingSave = null;
        unlockSave();
      }
      capture.textContent = capturing ? "Stop capture" : "Start capture";
      capture.disabled = (busy && !(pendingSave && capturing)) || !!value.error;
      if (!initialized) {
        initialized = true;
        if (value.synthetic) show("journal");
      }
    },
  };
}
