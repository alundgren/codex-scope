import { currentPromptOverrides } from "./prompt-settings.ts";
import { effectivePrompt } from "../review-prompts.ts";
import { requiredElement as el } from "./elements.ts";
import {
  SESSION_LIMITS as L,
  type ConversationState,
  type ReviewLens,
} from "../review-session-types.ts";
export function attachConversation(
  review: () => string | null,
  lens: () => ReviewLens,
  end: () => void,
) {
  const entries = el("#conversation-entries"),
    status = el("#conversation-state"),
    input = el<HTMLTextAreaElement>("#conversation-input");
  let reading = false,
    dirty = false,
    current = "",
    offset: number = L.entries,
    version = -1,
    total = 0;
  const nodes = new Map<string, HTMLElement>();
  function render(state: ConversationState) {
    if (state.review !== review()) return;
    const following = offset === L.entries;
    total = state.total;
    const changed =
      state.prompts &&
      (state.prompts.base !== effectivePrompt("base", currentPromptOverrides).version ||
        state.lens !== lens() ||
        state.prompts.lens !== effectivePrompt(lens(), currentPromptOverrides).version);
    status.textContent = state.selection
      ? `${state.selection.model} · ${state.selection.effort} · ${state.status}. ${state.error ?? `Next turn: ${lens()}. ${changed ? "Saved prompts or lens pending for next turn. " : ""}Model changes apply to the next review.`}`
      : "Choose a review model and effort in Settings, then send a message.";
    el<HTMLButtonElement>("#conversation-send").disabled = !["idle", "ready"].includes(
      state.status,
    );
    el<HTMLButtonElement>("#conversation-stop").disabled = !["starting", "running"].includes(
      state.status,
    );
    el<HTMLButtonElement>("#conversation-copy").disabled = !total;
    el("#conversation-end").hidden = !["failed", "capacity"].includes(state.status);
    el<HTMLButtonElement>("#conversation-previous").disabled = state.offset === 0;
    el<HTMLButtonElement>("#conversation-latest").disabled = following;
    if (version === state.version) return;
    version = state.version;
    const visible = new Set(state.entries.map((e) => e.id));
    for (const [id, node] of nodes)
      if (!visible.has(id)) {
        node.remove();
        nodes.delete(id);
      }
    for (const [index, item] of state.entries.entries()) {
      let node = nodes.get(item.id);
      if (!node) {
        node = document.createElement("div");
        node.className = `conversation-message ${item.role}`;
        const label = document.createElement("span");
        label.textContent = `${{ user: "You", assistant: "Codex", activity: "Review activity" }[item.role]} · ${item.lens}`;
        const body = document.createElement("pre");
        node.append(label, body);
        nodes.set(item.id, node);
      }
      const position = entries.children.item(index);
      if (position !== node) entries.insertBefore(node, position);
      const body = node.lastElementChild!;
      if (body.textContent !== item.text) body.textContent = item.text;
    }
    if (following) entries.scrollTop = entries.scrollHeight;
  }
  async function refresh() {
    const id = review();
    if (!id) {
      current = "";
      entries.replaceChildren();
      nodes.clear();
      return;
    }
    if (id !== current) {
      current = id;
      offset = L.entries;
      version = -1;
      nodes.clear();
      entries.replaceChildren();
      input.value = "";
      el("#conversation-notice").textContent = "";
    }
    if (reading) {
      dirty = true;
      return;
    }
    reading = true;
    try {
      const state = await window.scope.conversation({ action: "read", review: id, offset });
      if (state) render(state);
    } catch {
      status.textContent = "Conversation is unavailable.";
    } finally {
      reading = false;
      if (dirty) {
        dirty = false;
        void refresh();
      }
    }
  }
  async function copy() {
    const id = review();
    if (!id) return;
    try {
      await window.scope.conversation({ action: "copy", review: id });
      el("#conversation-notice").textContent = "Transcript copied.";
    } catch {
      el("#conversation-notice").textContent =
        "Transcript could not be copied. Select visible text to copy it.";
    }
  }
  el("#conversation-end").addEventListener("click", end);
  el("#conversation-copy").addEventListener("click", () => void copy());
  el("#conversation-previous").addEventListener("click", () => {
    offset = Math.max(
      0,
      (offset === L.entries ? Math.max(0, total - L.pageEntries) : offset) - L.pageEntries,
    );
    version = -1;
    void refresh();
  });
  el("#conversation-latest").addEventListener("click", () => {
    offset = L.entries;
    version = -1;
    void refresh();
  });
  el("#conversation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const id = review();
    if (!id || !input.value.trim()) return;
    const text = input.value;
    el<HTMLButtonElement>("#conversation-send").disabled = true;
    void window.scope
      .conversation({ action: "send", review: id, text, lens: lens() })
      .then((state) => {
        input.value = "";
        el("#conversation-notice").textContent = "";
        offset = L.entries;
        if (state) render(state);
      })
      .catch((error) => {
        status.textContent = error instanceof Error ? error.message : "Message failed.";
        el<HTMLButtonElement>("#conversation-send").disabled = false;
      });
  });
  el("#conversation-stop").addEventListener("click", () => {
    const id = review();
    if (id)
      void window.scope
        .conversation({ action: "stop", review: id })
        .then(() => refresh())
        .catch(() => {
          status.textContent = "Stop failed. End the review.";
        });
  });
  window.addEventListener("scope-prompts", () => void refresh());
  window.scope.onConversation(() => void refresh());
  return { refresh: () => void refresh(), copy: () => void copy() };
}
