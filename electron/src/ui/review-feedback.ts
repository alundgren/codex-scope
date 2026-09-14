import {
  feedbackText,
  validateFindings,
  FEEDBACK_LIMITS as L,
  IMPACTS,
  type ReviewFinding,
  type FeedbackDraft,
} from "../review-feedback.ts";
import type { ConversationState, ReviewLens } from "../review-session-types.ts";
import type { ReviewPR } from "../review-types.ts";
const button = (text: string, action: () => void) => {
  const b = document.createElement("button");
  b.textContent = text;
  b.onclick = action;
  return b;
};
export function attachFeedback(review: () => ReviewPR | null, lens: () => ReviewLens) {
  const dialog = document.createElement("dialog");
  dialog.id = "feedback-dialog";
  dialog.dataset.reviewFocusGuard = "";
  dialog.className = "feedback-dialog";
  document.body.append(dialog);
  let id = "",
    findings: ReviewFinding[] = [],
    draft: FeedbackDraft | null = null;
  let state: ConversationState | null = null,
    stale = false,
    edited = false,
    pending: "wait" | "generate" | null = null,
    sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let author: HTMLTextAreaElement,
    agent: HTMLTextAreaElement,
    notice: HTMLElement,
    actions: HTMLElement;
  let leaveLabel = "End without copy";
  let findingsEdited = false;
  let references: Record<string, string> = {};
  let decision = false;
  let message = "",
    leaving: (() => void) | null = null;
  function reset() {
    const p = review();
    if (p?.id === id) return;
    clearTimeout(timer);
    pending = null;
    id = p?.id ?? "";
    findings = [];
    references = {};
    draft = p ? feedbackText([], p) : null;
    decision = false;
    stale = edited = findingsEdited = false;
    sequence = 0;
    message = "";
    state = null;
    leaving = null;
    if (dialog.open) dialog.close();
  }
  function say(text: string) {
    message = text;
    if (notice) notice.textContent = text;
  }
  function cancel() {
    const was = pending;
    pending = null;
    clearTimeout(timer);
    if (was === "generate" && id)
      void window.scope.conversation({ action: "stop", review: id }).catch(() => {});
    say("Generation cancelled. Existing edits kept.");
    renderActions();
  }
  function updateEditors() {
    if (!draft) return;
    author.value = draft.author;
    agent.value = draft.agent;
  }
  function replace(next: () => void, includeFindings = false) {
    if (!edited && !(includeFindings && findingsEdited)) {
      next();
      return;
    }
    decision = true;
    actions.replaceChildren(
      button("Replace edited text", () => {
        decision = false;
        next();
      }),
      button("Keep edits", () => {
        decision = false;
        say("Existing edits kept.");
        renderActions();
      }),
    );
    say("Replace both edited handoffs? Existing text stays until you choose.");
  }
  async function generate() {
    if (!id || pending) return;
    pending = "generate";
    sequence = state?.feedback?.sequence ?? 0;
    say("Generating feedback in this review thread…");
    renderActions();
    const target = id;
    clearTimeout(timer);
    timer = setTimeout(cancel, 120000);
    try {
      const next = await window.scope.conversation({
        action: "feedback",
        review: target,
        lens: lens(),
      });
      if (next) receive(next);
    } catch (error) {
      if (id === target && pending) {
        pending = null;
        clearTimeout(timer);
        say(error instanceof Error ? error.message : "Generation failed. Existing edits kept.");
        renderActions();
      }
    }
  }
  function waitForCurrentTurn() {
    decision = false;
    if (state?.status === "ready") {
      void generate();
      return false;
    }
    if (!state || !["starting", "running"].includes(state.status)) {
      say(
        "The review agent is unavailable. Existing edits remain available for manual editing and copy.",
      );
      renderActions();
      return false;
    }
    pending = "wait";
    say("Waiting for the current turn. You can cancel this request.");
    clearTimeout(timer);
    timer = setTimeout(cancel, 120000);
    renderActions();
    return true;
  }
  function requestGeneration() {
    replace(() => {
      if (state && ["starting", "running"].includes(state.status)) {
        decision = true;
        actions.replaceChildren(
          button("Wait for current turn", () => {
            waitForCurrentTurn();
          }),
          button("Stop turn first", () => {
            if (!waitForCurrentTurn()) return;
            void window.scope
              .conversation({ action: "stop", review: id })
              .then((next) => {
                if (next) receive(next);
              })
              .catch(() => {
                pending = null;
                clearTimeout(timer);
                say("Stop failed. Existing edits kept.");
                renderActions();
              });
          }),
          button("Cancel request", () => {
            decision = false;
            say("Existing edits kept.");
            renderActions();
          }),
        );
        say("A review turn is active. Wait or stop it before generating feedback.");
      } else void generate();
    }, true);
  }
  function receive(next: ConversationState) {
    reset();
    if (next.review !== id) return;
    const previousStatus = state?.status;
    state = next;
    if (pending === "wait" && next.status === "ready") {
      pending = null;
      clearTimeout(timer);
      void generate();
      return;
    }
    if (pending && ["failed", "capacity"].includes(next.status)) {
      pending = null;
      clearTimeout(timer);
      say(
        "The review agent is unavailable. Existing edits remain available for manual editing and copy.",
      );
    }
    if (pending === "generate" && next.feedback && next.feedback.sequence > sequence) {
      pending = null;
      clearTimeout(timer);
      sequence = next.feedback.sequence;
      if (next.feedback.error) say(next.feedback.error);
      else {
        findings = next.feedback.findings;
        references = next.feedback.references ?? {};
        draft = feedbackText(findings, review()!, references);
        edited = findingsEdited = false;
        if (dialog.open) render();
        say(
          findings.length
            ? "Feedback prepared. Check the findings and both handoffs."
            : "No findings returned. You can edit both handoffs manually.",
        );
      }
    }
    if (dialog.open && previousStatus !== next.status) renderActions();
  }
  async function copy(section: "author" | "agent" | "both") {
    if (!draft) return;
    const target = id;
    const snapshot = structuredClone(draft);
    say("Copying…");
    try {
      const success = await window.scope.copyFeedback({
        review: id,
        draft: snapshot,
        section,
      });
      if (id === target)
        say(
          success
            ? draft.author !== snapshot.author || draft.agent !== snapshot.agent
              ? "Earlier editor snapshot copied with revision. Current edits have not been copied."
              : `${section === "both" ? "Both handoffs" : section === "author" ? "Author feedback" : "Agent handoff"} copied with revision.`
            : "Copy failed. Your drafts are unchanged.",
        );
    } catch (error) {
      if (id === target)
        say(error instanceof Error ? error.message : "Copy failed. Your drafts are unchanged.");
    }
  }
  function renderActions() {
    if (!actions || decision) return;
    if (author) author.disabled = !!pending;
    if (agent) agent.disabled = !!pending;
    for (const control of dialog.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >(".feedback-findings input,.feedback-findings select,.feedback-findings button"))
      control.disabled = !!pending;
    actions.replaceChildren();
    if (pending) actions.append(button("Cancel generation", cancel));
    else if (state && ["ready", "running", "starting"].includes(state.status))
      actions.append(button("Generate feedback", requestGeneration));
    else {
      const text = document.createElement("span");
      text.textContent = "No live agent. Edit and copy manually.";
      actions.append(text);
    }
    actions.append(
      button("Copy author", () => void copy("author")),
      button("Copy agent", () => void copy("agent")),
      button("Copy both", () => void copy("both")),
    );
    if (leaving)
      actions.append(
        button(leaveLabel, () => {
          const action = leaving;
          leaving = null;
          cancel();
          dialog.close();
          action?.();
        }),
      );
    actions.append(
      button(leaving ? "Cancel ending" : "Close feedback", () => {
        leaving = null;
        dialog.close();
      }),
    );
  }
  function render() {
    if (!draft) return;
    decision = false;
    dialog.replaceChildren();
    const title = document.createElement("h1");
    title.textContent = "Feedback";
    const revision = document.createElement("p");
    revision.textContent = `${stale ? "Stale feedback. PR changed. " : ""}${draft.revision.repository} #${draft.revision.number} · head ${draft.revision.head.slice(0, 7)}. Copy includes this original revision.`;
    notice = document.createElement("p");
    notice.setAttribute("role", "status");
    notice.textContent = message;
    const list = document.createElement("div");
    list.className = "feedback-findings";
    list.addEventListener("input", () => {
      findingsEdited = true;
      say("Finding edits are pending. Apply selected findings to update handoffs.");
    });
    list.addEventListener("change", () => {
      findingsEdited = true;
      say("Finding edits are pending. Apply selected findings to update handoffs.");
    });
    for (const f of findings) {
      const row = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${f.id} · ${f.hypothesis ? "Working hypothesis" : f.included ? "Included finding" : "Excluded finding"} · ${f.area}-${f.impact}`;
      row.append(summary);
      const field = (key: keyof ReviewFinding, text: string, max: number) => {
        const label = document.createElement("label");
        label.textContent = text;
        const input = document.createElement("input");
        input.value = String(f[key]);
        input.maxLength = max;
        input.oninput = () => {
          Object.assign(f, { [key]: input.value });
        };
        label.append(input);
        row.append(label);
      };
      field("area", "Area", 48);
      field("description", "One-sentence description", 320);
      const label = document.createElement("label");
      label.textContent = "Impact";
      const impact = document.createElement("select");
      for (const value of IMPACTS) impact.add(new Option(value, value));
      impact.value = f.impact;
      impact.onchange = () => {
        f.impact = impact.value as ReviewFinding["impact"];
      };
      label.append(impact);
      row.append(label);
      for (const [key, text] of [
        ["included", "Include finding"],
        ["hypothesis", "Working hypothesis"],
        ["includeSuggestion", "Include discussed suggestion"],
      ] as const) {
        const label = document.createElement("label");
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = f[key];
        check.onchange = () => {
          f[key] = check.checked;
        };
        label.append(check, text);
        row.append(label);
      }
      const evidence = document.createElement("pre");
      evidence.textContent = `Original evidence: ${f.evidence || "Not supplied"}`;
      row.append(evidence);
      field("reasoning", "Reasoning", 512);
      field("uncertainty", "Uncertainty", 256);
      field("verification", "Verification steps", 512);
      field("suggestion", "Discussed optional suggestion", 320);
      const attribution = document.createElement("label");
      attribution.textContent = "Suggestion attribution";
      const source = document.createElement("select");
      source.add(new Option("agent", "agent"));
      source.add(new Option("user", "user"));
      source.value = f.attribution;
      source.onchange = () => {
        f.attribution = source.value as "user" | "agent";
      };
      attribution.append(source);
      row.append(attribution);
      row.append(
        button("Remove finding", () => {
          findingsEdited = true;
          findings = findings.filter((item) => item.id !== f.id);
          render();
        }),
      );
      list.append(row);
    }
    list.append(
      button("Apply selected findings to handoffs", () =>
        replace(() => {
          try {
            validateFindings({ findings });
          } catch (error) {
            say(error instanceof Error ? error.message : "Invalid findings.");
            renderActions();
            return;
          }
          draft = feedbackText(findings, draft!.revision, references);
          edited = false;
          updateEditors();
          say("Handoffs updated from included findings. Working hypotheses are excluded.");
          renderActions();
        }),
      ),
    );
    const editors = document.createElement("div");
    editors.className = "feedback-editors";
    const editor = (kind: "author" | "agent", text: string) => {
      const label = document.createElement("label");
      label.textContent = text;
      const input = document.createElement("textarea");
      input.id = `feedback-${kind}`;
      input.maxLength = L.draftBytes;
      input.value = draft![kind];
      input.oninput = () => {
        draft![kind] = input.value;
        edited = true;
        say("Draft edited. Copy again to include these changes.");
      };
      label.append(input);
      editors.append(label);
      return input;
    };
    author = editor("author", "For the author");
    agent = editor("agent", "For the agent");
    actions = document.createElement("div");
    actions.className = "feedback-actions";
    dialog.append(title, revision, list, editors, notice, actions);
    renderActions();
  }
  dialog.addEventListener("cancel", () => {
    leaving = null;
  });
  window.addEventListener("scope-conversation-state", ((event: CustomEvent<ConversationState>) =>
    receive(event.detail)) as EventListener);
  return {
    reset,
    stale: () => {
      stale = true;
    },
    open: (leave?: () => void, label = "End without copy") => {
      reset();
      leaving = leave ?? null;
      leaveLabel = label;
      if (leave)
        message =
          "Copy feedback before removing this temporary review, continue without copying, or cancel.";
      render();
      if (!dialog.open) dialog.showModal();
    },
  };
}
