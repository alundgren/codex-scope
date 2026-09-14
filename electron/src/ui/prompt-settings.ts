import { requiredElement as el } from "./elements.ts";
import {
  REVIEW_PROMPTS,
  PROMPT_IDS,
  PROMPT_LIMITS,
  effectivePrompt,
  promptBytes,
  validPromptText,
  type PromptId,
  type PromptOverrides,
} from "../review-prompts.ts";
import type { ConnectionSettings, HistoryStatus, Reply } from "../types.ts";
export let currentPromptOverrides: PromptOverrides = {};
export function attachPromptSettings() {
  const input = el<HTMLTextAreaElement>("#prompt-text");
  const selector = el<HTMLButtonElement>("#prompt-select");
  const menu = el("#prompt-options");
  const save = el<HTMLButtonElement>("#prompt-save");
  const cancel = el<HTMLButtonElement>("#prompt-cancel");
  const revert = el<HTMLButtonElement>("#prompt-revert");
  const status = el("#prompt-status");
  const drafts = new Map<PromptId, string | null>();
  let selected: PromptId = "base",
    busy = false,
    pending: number | null = null;
  let lastSave: HistoryStatus["settingsSave"];
  const dirty = () => drafts.has(selected);
  const text = () =>
    drafts.get(selected) === null
      ? REVIEW_PROMPTS[selected].text
      : (drafts.get(selected) ?? effectivePrompt(selected, currentPromptOverrides).text);
  function close(restore = false) {
    menu.hidden = true;
    selector.setAttribute("aria-expanded", "false");
    if (restore) selector.focus();
  }
  function render(load = false) {
    if (load) input.value = text();
    selector.textContent = REVIEW_PROMPTS[selected].label + " ▾";
    el("#prompt-modified").textContent = dirty()
      ? "Unsaved changes"
      : currentPromptOverrides[selected]
        ? "Modified"
        : "System default";
    el("#prompt-bytes").textContent =
      `${promptBytes(input.value)} / ${PROMPT_LIMITS.promptBytes} bytes`;
    el("#prompt-system-text").textContent = REVIEW_PROMPTS[selected].text;
    el("#prompt-system-label").textContent =
      `Shipped default · version ${REVIEW_PROMPTS[selected].version}`;
    save.disabled = busy || !dirty();
    cancel.disabled = busy || !dirty();
    revert.disabled = busy || (!dirty() && !currentPromptOverrides[selected]);
    input.disabled = selector.disabled = busy;
  }
  for (const id of PROMPT_IDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.textContent = REVIEW_PROMPTS[id].label;
    button.addEventListener("click", () => {
      selected = id;
      close(true);
      status.textContent = "";
      render(true);
    });
    menu.append(button);
  }
  selector.addEventListener("click", () => {
    if (!menu.hidden) return close(true);
    menu.hidden = false;
    selector.setAttribute("aria-expanded", "true");
    const rect = selector.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 296))}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.width = `${Math.min(280, innerWidth - 16)}px`;
    menu.style.maxHeight = `${Math.max(48, innerHeight - rect.bottom - 12)}px`;
    menu.querySelectorAll<HTMLButtonElement>("button")[PROMPT_IDS.indexOf(selected)]?.focus();
  });
  menu.addEventListener("keydown", (event) => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const positions: Record<string, number> = {
      ArrowDown: (index + 1) % buttons.length,
      ArrowUp: (index + buttons.length - 1) % buttons.length,
      Home: 0,
      End: buttons.length - 1,
    };
    if (event.key in positions) {
      event.preventDefault();
      buttons[positions[event.key]]?.focus();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    }
    if (event.key === "Tab") close();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target as Node) && !selector.contains(event.target as Node)) close();
  });
  window.addEventListener("resize", () => close());
  input.addEventListener("input", () => {
    drafts.set(selected, input.value);
    status.textContent = "";
    render();
  });
  input.addEventListener("paste", (event) => {
    const pasted = event.clipboardData?.getData("text") ?? "";
    if (pasted.length > PROMPT_LIMITS.promptBytes) {
      event.preventDefault();
      status.textContent = "Paste exceeds 8 KiB. The draft was kept.";
      return;
    }
    const next =
      input.value.slice(0, input.selectionStart) + pasted + input.value.slice(input.selectionEnd);
    if (next.length > PROMPT_LIMITS.promptBytes || promptBytes(next) > PROMPT_LIMITS.promptBytes) {
      event.preventDefault();
      status.textContent = "Paste exceeds 8 KiB. The draft was kept.";
    }
  });
  cancel.addEventListener("click", () => {
    drafts.delete(selected);
    status.textContent = "Changes cancelled.";
    render(true);
  });
  revert.addEventListener("click", () => {
    drafts.set(selected, null);
    status.textContent =
      "System default staged. Save prompt to remove this override, or Cancel to undo.";
    render(true);
  });
  function apply(value: ConnectionSettings) {
    currentPromptOverrides = value.prompts;
    window.dispatchEvent(new Event("scope-prompts"));
    render(true);
  }
  function saved(value: Reply<ConnectionSettings>) {
    if (value.error) status.textContent = value.error;
    else if ("prompts" in value) {
      drafts.delete(selected);
      apply(value);
      status.textContent =
        "Prompt saved. Applies to the next turn; active work keeps its submitted instructions.";
    } else
      status.textContent =
        "The save result could not be confirmed. Restart Scope and check Settings.";
  }
  function settle() {
    if (!pending || lastSave?.id !== pending) return;
    saved(lastSave.result);
    pending = null;
    busy = false;
    render();
  }
  save.addEventListener("click", async () => {
    if (busy || !dirty()) return;
    const draft = drafts.get(selected)!;
    if (draft !== null && !validPromptText(draft)) {
      status.textContent =
        "Enter a nonempty prompt of at most 8 KiB without control characters. The draft was kept.";
      return;
    }
    busy = true;
    render();
    status.textContent = "Saving prompt…";
    try {
      const result = await window.scope.savePrompt({ id: selected, text: draft });
      if (result.pending) {
        pending = result.pending;
        status.textContent = "Still saving prompt. The draft is kept until the result arrives.";
        settle();
      } else saved(result);
    } catch {
      status.textContent = "Prompt was not saved. The draft was kept; try again.";
    } finally {
      if (!pending) {
        busy = false;
        render();
      }
    }
  });
  render(true);
  return {
    apply,
    close,
    receive(value: HistoryStatus) {
      lastSave = value.settingsSave;
      settle();
      if (pending && value.error) {
        pending = null;
        busy = false;
        status.textContent =
          "The save result could not be confirmed. Restart Scope and check Settings.";
        render();
      }
    },
  };
}
