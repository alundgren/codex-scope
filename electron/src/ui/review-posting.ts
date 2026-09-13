import { feedbackCopy, type FeedbackDraft } from "../review-feedback.ts";
import { POST_LIMITS, type PostingRequest, type PostingState } from "../review-posting-types.ts";
export function attachPosting() {
  const dialog = document.createElement("dialog");
  dialog.id = "posting-dialog";
  dialog.className = "feedback-dialog posting-dialog";
  dialog.dataset.reviewFocusGuard = "";
  document.body.append(dialog);
  let review = "",
    text = "",
    initial = "",
    busy = false;
  let state: PostingState | null = null;
  let editor: HTMLTextAreaElement, notice: HTMLElement, actions: HTMLElement, result: HTMLElement;
  const button = (label: string, action: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = action;
    return b;
  };
  function openComment(comment: number | null) {
    void window.scope.openComment({ review, comment }).catch((error) => {
      notice.textContent =
        error instanceof Error
          ? error.message
          : "Could not open GitHub. The destination remains visible.";
    });
  }
  function controls() {
    if (!actions) return;
    actions.replaceChildren();
    editor.disabled = busy;
    if (busy) {
      notice.textContent = "Checking GitHub and completing this comment operation…";
      return;
    }
    const over = new TextEncoder().encode(text).length > POST_LIMITS.bodyBytes;
    const post = button(
      state?.status === "sent" ? "Post edited comment" : "Post comment",
      () => void request({ action: "post", review, body: text }),
    );
    post.disabled =
      over ||
      state?.status === "uncertain" ||
      state?.status === "stale" ||
      (state?.status === "sent" && text === state.body);
    if (state?.status === "uncertain") {
      actions.append(
        button("Check GitHub for this comment", () => void request({ action: "verify", review })),
      );
      const link = document.createElement("a");
      // Destination comes from the retained review, never from agent text.
      link.href = dialog.dataset.destination!;
      link.onclick = (event) => {
        event.preventDefault();
        openComment(null);
      };
      link.textContent = "Inspect PR on GitHub";
      actions.append(link);
      const candidates = document.createElement("div");
      candidates.className = "posting-candidates";
      for (const candidate of state.candidates) {
        const row = document.createElement("span"),
          a = document.createElement("a");
        a.href = candidate.url;
        a.onclick = (event) => {
          event.preventDefault();
          openComment(candidate.id);
        };
        a.textContent = `Matching comment ${candidate.id}`;
        row.append(
          a,
          button(
            "Use this comment",
            () => void request({ action: "resolve", review, candidate: candidate.id }),
          ),
        );
        candidates.append(row);
      }
      if (state.candidates.length) actions.append(candidates);
      if (state.checked)
        actions.append(
          button(
            "I checked GitHub; comment is absent",
            () => void request({ action: "resolve", review, candidate: null }),
          ),
        );
    } else actions.append(post);
    actions.append(
      button("Copy exact preview", () => {
        const snapshot = text,
          target = review;
        void window.scope
          .copyComment({ review, body: snapshot })
          .then(() => {
            if (review === target)
              notice.textContent =
                text === snapshot
                  ? "Exact preview copied."
                  : "Earlier preview copied. Current edits have not been copied.";
          })
          .catch(() => {
            if (review === target) notice.textContent = "Copy failed. Preview unchanged.";
          });
      }),
    );
    if (initial !== text)
      actions.append(
        button("Use current handoffs", () => {
          text = initial;
          editor.value = text;
          notice.textContent = "Current handoffs loaded. Check the exact body before posting.";
          controls();
        }),
      );
    actions.append(
      button(state?.status === "stale" ? "Back to refresh and review" : "Back to feedback", () =>
        dialog.close(),
      ),
    );
    if (over)
      notice.textContent = "Comment exceeds 65,536 UTF-8 bytes. Shorten the draft before posting.";
  }
  async function request(value: PostingRequest) {
    if (busy) return;
    const target = review;
    busy = true;
    controls();
    try {
      const next = await window.scope.posting(value);
      if (target !== review) return;
      state = next;
      notice.textContent = next.message;
      result.replaceChildren();
      if (next.status === "sent" && next.comment) {
        const link = document.createElement("a");
        link.href = next.comment.url;
        link.onclick = (event) => {
          event.preventDefault();
          openComment(next.comment!.id);
        };
        link.textContent = "View posted comment";
        const sent = document.createElement("details"),
          label = document.createElement("summary"),
          body = document.createElement("pre");
        label.textContent = "Exact sent body";
        body.textContent = next.body;
        sent.append(label, body);
        result.append(link, sent);
      }
    } catch (error) {
      if (target === review)
        notice.textContent =
          error instanceof Error ? error.message : "Comment operation failed. Draft kept.";
    } finally {
      if (target === review) {
        busy = false;
        controls();
      }
    }
  }
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  return {
    reset() {
      if (!busy) {
        review = "";
        text = initial = "";
        state = null;
        dialog.close();
      }
    },
    open(id: string, draft: FeedbackDraft) {
      const combined = feedbackCopy(draft, "both");
      if (review !== id) {
        review = id;
        text = combined;
        state = null;
      }
      initial = combined;
      dialog.replaceChildren();
      const title = document.createElement("h1");
      title.textContent = "Post comment";
      const destination = document.createElement("p");
      destination.textContent = `${draft.revision.repository} #${draft.revision.number} · reviewed head ${draft.revision.head}`;
      dialog.dataset.destination = `https://github.com/${draft.revision.repository}/pull/${draft.revision.number}`;
      const label = document.createElement("label");
      label.textContent = "Exact comment Markdown";
      editor = document.createElement("textarea");
      editor.id = "posting-body";
      editor.maxLength = POST_LIMITS.bodyBytes;
      editor.value = text;
      editor.oninput = () => {
        text = editor.value;
        notice.textContent = "Draft edited. Check the complete body before posting.";
        controls();
      };
      label.append(editor);
      const help = document.createElement("p");
      help.textContent =
        "The feedback revision must remain at the end. GitHub can change after the final head check; this comment records the reviewed head.";
      notice = document.createElement("p");
      notice.setAttribute("role", "status");
      actions = document.createElement("div");
      actions.className = "feedback-actions";
      result = document.createElement("div");
      result.className = "posting-result";
      dialog.append(title, destination, label, help, notice, result, actions);
      controls();
      if (!dialog.open) dialog.showModal();
      void request({ action: "read", review });
    },
  };
}
