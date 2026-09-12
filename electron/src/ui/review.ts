import { requiredElement as el } from "./elements.ts";
import { REVIEW_LIMITS as L } from "../review-types.ts";
import type {
  ReviewPR,
  ReviewFile,
  ReviewContent,
  ReviewImage,
  ReviewAnchor,
  ReviewRequest,
} from "../review-types.ts";
const button = (text: string, action: () => void) => {
  const b = document.createElement("button");
  b.textContent = text;
  b.addEventListener("click", action);
  return b;
};
export function attachReview() {
  let pr: ReviewPR | null = null,
    files: ReviewFile[] = [],
    filePage = 1,
    path = "",
    mode: ReviewContent["mode"] = "diff",
    view = "Changes",
    lens = "Overview",
    content: ReviewContent | null = null,
    images: ReviewImage[] = [],
    imageId = "",
    selection: ReviewAnchor | null = null;
  let busy = false,
    visible = false,
    ratio = 60,
    focus = "review",
    shownChat = false,
    menu: HTMLElement | null = null,
    anchor: HTMLButtonElement | null = null;
  const scrolls = new Map<string, number>(),
    offsets = new Map<string, number>();
  const pane = el("#review-content"),
    grid = el("#review-grid"),
    dialog = el<HTMLDialogElement>("#review-dialog"),
    functions = el("#functions"),
    home = functions.parentElement!;
  const status = (text: string) => {
    el("#review-status").textContent = text;
  };
  function closeMenu(restore = false) {
    menu?.remove();
    menu = null;
    anchor?.setAttribute("aria-expanded", "false");
    if (restore) anchor?.focus();
    anchor = null;
  }
  function dropdown(
    target: HTMLButtonElement,
    choices: { text: string; action: () => void; selected?: boolean }[],
  ) {
    if (anchor === target) {
      closeMenu(true);
      return;
    }
    closeMenu();
    anchor = target;
    target.setAttribute("aria-haspopup", "menu");
    target.setAttribute("aria-expanded", "true");
    menu = document.createElement("div");
    menu.className = "review-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", target.textContent ?? "Review controls");
    for (const choice of choices) {
      const b = button(choice.text, () => {
        closeMenu(true);
        choice.action();
      });
      b.setAttribute("role", "menuitem");
      b.tabIndex = -1;
      if (choice.selected) b.setAttribute("aria-current", "true");
      menu.append(b);
    }
    document.body.append(menu);
    const rect = target.getBoundingClientRect(),
      width = Math.min(380, innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.maxHeight = `${Math.max(48, innerHeight - rect.bottom - 12)}px`;
    (
      menu.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? menu.querySelector("button")
    )?.focus();
  }
  function modal(text: string, actions: { text: string; action: () => void }[] = []) {
    closeMenu();
    const box = el("#review-dialog-content");
    box.replaceChildren();
    const p = document.createElement("p");
    p.textContent = text;
    box.append(p);
    for (const action of actions)
      box.append(
        button(action.text, () => {
          dialog.close();
          action.action();
        }),
      );
    dialog.showModal();
  }
  el("#review-dialog-close").addEventListener("click", () => dialog.close());
  const key = () => `${view}:${path}:${mode}:${content?.offset ?? 0}:${imageId}`;
  function remember() {
    scrolls.set(key(), pane.scrollTop);
    if (scrolls.size > 20) scrolls.delete(scrolls.keys().next().value!);
  }
  const restore = () => {
    pane.scrollTop = scrolls.get(key()) ?? 0;
  };
  function layout() {
    grid.dataset.focus = focus;
    grid.style.setProperty("--review-width", `${ratio}%`);
    el("#review-divider").setAttribute("aria-valuenow", String(Math.round(ratio)));
    el("#review-chat-toggle").textContent = focus === "chat" ? "Review" : "Chat";
    el("#review-expand").textContent =
      focus === "review" && shownChat ? "Restore split" : "Expand review";
    el("#review-chat-expand").textContent = focus === "chat" ? "Restore split" : "Expand chat";
  }
  function update() {
    el("#review-open").hidden = !!pr;
    el("#review-controls").hidden = !pr;
    grid.hidden = !pr;
    el("#review-title").textContent = pr ? `${pr.repository} #${pr.number}` : "PR review";
    el("#review-revision").textContent = pr ? `Revision ${pr.head.slice(0, 7)}` : "";
    el("#review-files").textContent = path || "Choose file ⌄";
    el("#review-view").textContent = `${view} ⌄`;
    el("#review-lens").textContent = `${lens} ⌄`;
    el("#review-side").textContent =
      `${mode === "diff" ? "Diff" : mode === "base" ? "Base source" : "Head source"} ⌄`;
    el("#review-side").hidden = view !== "Changes";
    el("#review-files").hidden = view !== "Changes";
    el("#review-selection").textContent = selection
      ? `${selection.path} · ${selection.side} line ${selection.line}`
      : "Select a source line";
    for (const id of ["#review-previous", "#review-next"])
      el<HTMLButtonElement>(id).hidden = view !== "Changes" || !content || content.total <= L.rows;
    el<HTMLButtonElement>("#review-previous").disabled = !content || content.offset === 0;
    el<HTMLButtonElement>("#review-next").disabled =
      !content || content.offset + L.rows >= content.total;
    layout();
  }
  function lock(value: boolean) {
    for (const node of document.querySelectorAll<HTMLButtonElement>(
      "#review-controls button,#review-evidence-bar button,#review-footer button,#review-content button,#review-open button",
    ))
      node.disabled = value;
  }
  async function request(value: ReviewRequest) {
    if (busy) return null;
    busy = true;
    lock(true);
    el("#review-cancel").hidden = false;
    status("Reading PR evidence…");
    try {
      const reply = await window.scope.review(value);
      if (reply.error) {
        status(reply.error);
        return null;
      }
      status("");
      return reply;
    } catch {
      status("PR evidence could not be read. Try again.");
      return null;
    } finally {
      busy = false;
      lock(false);
      el("#review-cancel").hidden = true;
      update();
    }
  }
  el("#review-cancel").addEventListener("click", () => window.scope.cancelReview());
  async function readFiles(page: number) {
    if (!pr) return false;
    const reply = await request({ action: "files", id: pr.id, page });
    if (!reply?.files) return false;
    files = reply.files;
    filePage = page;
    return true;
  }
  function drawContent() {
    pane.replaceChildren();
    if (!content) {
      pane.textContent = "Choose a changed file to inspect its diff.";
      return;
    }
    if (content.omission) {
      pane.textContent = content.omission;
      return;
    }
    for (const row of content.rows) {
      const line = document.createElement("div");
      line.className = `review-code-row ${row.kind}`;
      for (const side of ["base", "head"] as const) {
        const n = row[side];
        if (n === null) {
          line.append(document.createElement("span"));
          continue;
        }
        const b = button(String(n), () => {
          if (!pr) return;
          selection = {
            repository: pr.repository,
            number: pr.number,
            base: pr.base,
            head: pr.head,
            path,
            sourcePath: side === "base" ? (content?.previousPath ?? path) : path,
            sourceOid: side === "base" ? pr.diffBase : pr.head,
            side,
            line: n,
          };
          pane.querySelector(".selected-line")?.classList.remove("selected-line");
          line.classList.add("selected-line");
          update();
        });
        b.setAttribute("aria-label", `${side} line ${n}`);
        line.append(b);
      }
      const code = document.createElement("span");
      code.textContent = row.text;
      line.append(code);
      if (selection?.path === path && row[selection.side] === selection.line)
        line.classList.add("selected-line");
      pane.append(line);
    }
    restore();
  }
  async function readContent(offset = offsets.get(`${path}:${mode}`) ?? 0) {
    if (!pr || !path || busy) return;
    const reply = await request({ action: "content", id: pr.id, path, mode, offset });
    if (reply?.content) {
      content = reply.content;
      offsets.set(`${path}:${mode}`, offset);
      if (offsets.size > 20) offsets.delete(offsets.keys().next().value!);
      drawContent();
    } else {
      content = null;
      pane.textContent =
        "This source is unavailable. Choose another side or retry with the same control.";
    }
    update();
  }
  async function openPR(input: string, replace = false) {
    const reply = await request({ action: "open", input, replace });
    if (!reply?.pr) return;
    pr = reply.pr;
    files = [];
    images = [];
    imageId = "";
    path = "";
    content = null;
    selection = null;
    scrolls.clear();
    offsets.clear();
    view = "Changes";
    focus = "review";
    shownChat = false;
    update();
    drawContent();
    if (reply.pr.fileCount && (await readFiles(1))) {
      path = files[0]?.path ?? "";
      await readContent();
    } else if (!reply.pr.fileCount) pane.textContent = "This PR has no changed files.";
  }
  el<HTMLFormElement>("#review-open-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void openPR(el<HTMLInputElement>("#review-address").value);
  });
  async function chooseFiles() {
    if (!pr) return;
    if (!files.length && !(await readFiles(filePage))) return;
    const choices = files.map((file) => ({
      text: `${file.path} · ${file.status} +${file.additions} −${file.deletions}`,
      selected: file.path === path,
      action: () => {
        remember();
        path = file.path;
        mode = "diff";
        void readContent();
      },
    }));
    if (filePage > 1)
      choices.unshift({
        text: "Previous files",
        selected: false,
        action: () => {
          void readFiles(filePage - 1).then((ok) => {
            if (ok) void chooseFiles();
          });
        },
      });
    if (filePage * L.pageFiles < Math.min(pr.fileCount, L.maxFiles))
      choices.push({
        text: "Next files",
        selected: false,
        action: () => {
          void readFiles(filePage + 1).then((ok) => {
            if (ok) void chooseFiles();
          });
        },
      });
    dropdown(el<HTMLButtonElement>("#review-files"), choices);
  }
  el("#review-files").addEventListener("click", () => {
    void chooseFiles();
  });
  el("#review-side").addEventListener("click", () =>
    dropdown(
      el<HTMLButtonElement>("#review-side"),
      (["diff", "base", "head"] as const).map((value) => ({
        text: value === "diff" ? "Diff" : value === "base" ? "Base source" : "Head source",
        selected: mode === value,
        action: () => {
          remember();
          mode = value;
          void readContent();
        },
      })),
    ),
  );
  el("#review-lens").addEventListener("click", () =>
    dropdown(
      el<HTMLButtonElement>("#review-lens"),
      ["Overview", "Security", "UX", "Performance", "Architecture"].map((value) => ({
        text: value,
        selected: lens === value,
        action: () => {
          lens = value;
          update();
        },
      })),
    ),
  );
  async function showImage(id: string) {
    if (!pr) return;
    const result = await request({ action: "image", id: pr.id, image: id });
    if (!result?.imageUrl) return;
    remember();
    imageId = id;
    drawImages(result.imageUrl);
    restore();
  }
  function drawImages(data?: string) {
    pane.replaceChildren();
    const controls = document.createElement("div");
    controls.className = "review-image-controls";
    controls.append(
      button("Add screenshot", () => {
        if (pr)
          void request({ action: "attach", id: pr.id }).then((result) => {
            if (result?.images) {
              images = result.images;
              imageId = "";
              drawImages();
            }
          });
      }),
    );
    for (const item of images)
      controls.append(
        button(item.name, () => {
          void showImage(item.id);
        }),
      );
    pane.append(controls);
    const selected = images.find((x) => x.id === imageId),
      p = document.createElement("p");
    p.textContent = selected
      ? `${selected.attribution} · ${selected.width} × ${selected.height} · pinned to ${selected.head.slice(0, 7)}. Supplied evidence, not a running app.`
      : "Add PNG screenshots supplied for this PR. No screenshots have been selected. Other formats and remote URLs are unsupported.";
    pane.append(p);
    if (selected && data) {
      pane.append(
        button("Remove screenshot", () => {
          if (pr)
            void request({ action: "remove-image", id: pr.id, image: selected.id }).then(
              (result) => {
                if (result?.images) {
                  images = result.images;
                  imageId = "";
                  drawImages();
                }
              },
            );
        }),
      );
      const image = document.createElement("img");
      image.alt = selected.name;
      image.src = data;
      image.addEventListener("error", () => {
        image.remove();
        status("Screenshot could not be decoded. Remove it and choose another PNG.");
      });
      pane.append(image);
    }
  }
  el("#review-view").addEventListener("click", () =>
    dropdown(
      el<HTMLButtonElement>("#review-view"),
      ["Changes", "Visual evidence"].map((value) => ({
        text: value,
        selected: view === value,
        action: () => {
          remember();
          view = value;
          if (view === "Changes") drawContent();
          else if (imageId) void showImage(imageId);
          else drawImages();
          update();
          restore();
        },
      })),
    ),
  );
  el("#review-previous").addEventListener("click", () => {
    remember();
    void readContent(Math.max(0, (content?.offset ?? 0) - L.rows));
  });
  el("#review-next").addEventListener("click", () => {
    remember();
    void readContent((content?.offset ?? 0) + L.rows);
  });
  function chat(next: string) {
    shownChat = true;
    focus = next;
    layout();
    if (focus === "chat") el("#review-chat-expand").focus();
    else pane.focus();
  }
  el("#review-chat-toggle").addEventListener("click", () =>
    chat(innerWidth <= 720 ? (focus === "chat" ? "review" : "chat") : "both"),
  );
  el("#review-expand").addEventListener("click", () =>
    chat(focus === "review" ? "both" : "review"),
  );
  el("#review-chat-expand").addEventListener("click", () =>
    chat(focus === "chat" ? "both" : "chat"),
  );
  function end() {
    if (pr)
      void request({ action: "end", id: pr.id }).then((result) => {
        if (result) {
          pr = null;
          files = [];
          images = [];
          content = null;
          selection = null;
          path = imageId = "";
          scrolls.clear();
          offsets.clear();
          pane.replaceChildren();
          update();
          el("#review-address").focus();
        }
      });
  }
  el("#review-more").addEventListener("click", () =>
    dropdown(el<HTMLButtonElement>("#review-more"), [
      {
        text: "PR details",
        action: () => {
          if (pr)
            modal(
              `${pr.title}\n${pr.repository} #${pr.number} · ${pr.state} · ${pr.fileCount} changed files\nTarget base ${pr.base}\nDiff base ${pr.diffBase}\nHead ${pr.head}\n${pr.headRepository ?? "Fork unavailable"}\n\n${pr.body}`,
            );
        },
      },
      {
        text: "Refresh PR",
        action: () => {
          if (pr)
            void request({ action: "refresh", id: pr.id }).then((result) => {
              if (!result) return;
              if (result.changed)
                modal(
                  "The PR changed. Replace this review with the new revision? Supplied screenshots and selections will be removed. Feedback copy is not available yet.",
                  [
                    {
                      text: "Replace review",
                      action: () => {
                        if (pr) void openPR(`${pr.repository} #${pr.number}`, true);
                      },
                    },
                  ],
                );
              else status("The PR still matches this pinned revision.");
            });
        },
      },
      {
        text: "Findings and annotations",
        action: () =>
          modal(
            selection
              ? `Selected evidence: ${selection.path}, ${selection.side} line ${selection.line}. Findings and annotations are not available yet.`
              : "No findings or annotations. These controls are not available yet.",
          ),
      },
      {
        text: "Evidence limits",
        action: () =>
          modal(
            `Only the current ${L.pageFiles}-file page and one selected diff or source are retained. ${Math.max(0, (pr?.fileCount ?? 0) - L.maxFiles)} paths exceed the ${L.maxFiles}-file browsing limit. GitHub may omit binary or large patches. Diff limit: 128 KiB. Source limit: 256 KiB and 20,000 lines, displayed 200 lines at a time. Screenshots: four PNG files, 4 MiB and 4,194,304 pixels each. Evidence stays temporary until this review ends or Scope closes.`,
          ),
      },
      { text: "Show conversation", action: () => chat("both") },
      {
        text: "Reset divider",
        action: () => {
          ratio = 60;
          chat("both");
        },
      },
      {
        text: "Open another PR",
        action: () =>
          modal(
            "Leave this review to open another PR? Supplied screenshots and selections will be removed. Feedback copy is not available yet.",
            [{ text: "Leave review", action: end }],
          ),
      },
      {
        text: "End review",
        action: () =>
          modal("End this temporary review? Supplied screenshots and selections will be removed.", [
            { text: "End review", action: end },
          ]),
      },
    ]),
  );
  const divider = el("#review-divider"),
    setRatio = (value: number) => {
      ratio = Math.min(80, Math.max(20, value));
      layout();
    };
  divider.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setRatio(
        event.key === "Home"
          ? 20
          : event.key === "End"
            ? 80
            : ratio + (event.key === "ArrowLeft" ? -2 : 2),
      );
    }
  });
  divider.addEventListener("dblclick", () => setRatio(60));
  divider.addEventListener("pointerdown", (event) => {
    divider.setPointerCapture(event.pointerId);
  });
  divider.addEventListener("pointermove", (event) => {
    if (divider.hasPointerCapture(event.pointerId)) {
      const rect = grid.getBoundingClientRect();
      setRatio(((event.clientX - rect.left) / rect.width) * 100);
    }
  });
  divider.addEventListener("pointerup", (event) => {
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  });
  document.addEventListener("pointerdown", (event) => {
    if (menu && !menu.contains(event.target as Node) && !anchor?.contains(event.target as Node))
      closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (!visible) return;
    if (menu) {
      const buttons = [...menu.querySelectorAll("button")],
        index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        buttons[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length
        ]?.focus();
      } else if (event.key === "Tab") closeMenu(true);
    }
  });
  window.addEventListener("resize", () => {
    closeMenu();
    if (innerWidth <= 720 && focus === "both") focus = "review";
    layout();
  });
  return {
    show(open: boolean) {
      visible = open;
      document.body.classList.toggle("review-open", open);
      if (open) el("#review-functions").append(functions);
      else {
        home.append(functions);
        closeMenu();
        dialog.close();
      }
      update();
    },
  };
}
