import { feedbackCopy, FEEDBACK_LIMITS } from "./review-feedback.ts";
import type { GuideAction } from "./review-guidance-types.ts";
import { GUIDANCE_LIMITS } from "./review-guidance-types.ts";
import { validPromptId, validPromptText, snapshotReviewPrompts } from "./review-prompts.ts";
import { ReviewSession } from "./review-session.ts";
import { LENSES, SESSION_LIMITS } from "./review-session-types.ts";
import { PRReview } from "./review.ts";
import { CatalogDiscovery } from "./model-catalog.ts";
import { validEffort, validSelection, selectionError } from "./model-types.ts";
import { runAnalysisCli } from "./analysis-cli.ts";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { ChoiceField, Direction, NavigationRequest } from "./types.ts";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  session,
  shell,
} from "electron";
import { readFile } from "node:fs/promises";
import { SessionAnalysis, validSession, validModel } from "./analysis.ts";
import type { AnalysisDecision } from "./analysis-types.ts";
import * as path from "node:path";
import { validNavigation, positive, QUERY_LIMITS } from "./search.ts";
import { History, LIMITS } from "./history.ts";

const PAGE = "scope://app/index.html";
const COPY_TIMEOUT_MS = 2000;
const assets = new Map([
  [PAGE, ["index.html", "text/html"]],
  ["scope://app/style.css", ["style.css", "text/css"]],
  ["scope://app/renderer.js", ["renderer.js", "text/javascript"]],
]);
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
protocol.registerSchemesAsPrivileged([
  { scheme: "scope", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.enableSandbox();
app.setName("Codex Scope");
const testMode = process.argv.includes("--history-test");
const testRoot =
  testMode &&
  process.argv
    .find((value) => value.startsWith("--scope-test-root="))
    ?.split("=")
    .slice(1)
    .join("=");
if (testRoot) app.setPath("userData", testRoot);
const owner = app.requestSingleInstanceLock();
let analysis: SessionAnalysis;
let catalog: CatalogDiscovery;
let review: PRReview;
let conversation: ReviewSession | null = null;
let conversationPending = false;
let sentConversationVersion = -1;
let pickerDiscovery = false;
let sentAnalysisVersion = -1;
let history: History,
  window: BrowserWindow,
  quitting = false,
  presentationTimer: NodeJS.Timeout | undefined;
let presentationPending = false,
  presentationDirty = false,
  hiddenPending = false;
if (!owner) app.exit(0);
app.on("second-instance", () => {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
  }
});
function present() {
  presentationDirty = true;
  if (
    presentationPending ||
    !window ||
    window.isDestroyed() ||
    !window.isVisible() ||
    window.isMinimized() ||
    presentationTimer
  )
    return;
  presentationTimer = setTimeout(() => {
    presentationTimer = undefined;
    if (!window.isDestroyed() && window.isVisible() && !window.isMinimized()) {
      presentationDirty = false;
      presentationPending = true;
      window.webContents.send("scope:status", history.snapshot());
      if (conversation && sentConversationVersion !== conversation.version) {
        sentConversationVersion = conversation.version;
        window.webContents.send("scope:conversation");
      }
      if (analysis && sentAnalysisVersion !== analysis.version) {
        sentAnalysisVersion = analysis.version;
        window.webContents.send("scope:analysis");
      }
    }
  }, 200);
}
app.on("before-quit", (event) => {
  if (quitting || !history) return;
  event.preventDefault();
  quitting = true;
  clearTimeout(presentationTimer);
  const deadline = setTimeout(() => {
    console.error("Temporary recording cleanup timed out. Startup will retry removal.");
    app.exit(1);
  }, LIMITS.requestMs + 250);
  Promise.all([
    history.close(),
    analysis?.close(),
    catalog?.close(),
    conversation?.close(),
    review?.close(),
  ]).then(
    ([ok]) => {
      if (!ok) console.error("Temporary recording cleanup failed. Startup will retry removal.");
      clearTimeout(deadline);
      app.exit(ok ? 0 : 1);
    },
    () => app.exit(1),
  );
});

app
  .whenReady()
  .then(async () => {
    // macOS routes standard editing shortcuts through the native application menu.
    Menu.setApplicationMenu(
      process.platform === "darwin"
        ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }])
        : null,
    );
    const isolated = session.fromPartition("synthetic");
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !assets.has(details.url) && !review?.acceptsImage(details.url) }),
    );
    isolated.on("will-download", (event) => event.preventDefault());
    isolated.protocol.handle("scope", async (request) => {
      if (request.method === "GET" && review?.acceptsImage(request.url)) {
        const bytes = await review.readImage(request.url);
        return bytes
          ? new Response(new Uint8Array(bytes), {
              headers: {
                "content-type": "image/png",
                "cache-control": "no-store",
                "x-content-type-options": "nosniff",
              },
            })
          : new Response("", { status: 404 });
      }
      const asset = assets.get(request.url);
      if (request.method !== "GET" || !asset) return new Response("", { status: 404 });
      return new Response(await readFile(new URL(`./ui/${asset[0]}`, import.meta.url)), {
        headers: {
          "content-type": asset[1],
          "content-security-policy": csp,
          "x-content-type-options": "nosniff",
        },
      });
    });
    const connectionFile = process.argv
      .find((value) => value.startsWith("--connection-config="))
      ?.slice("--connection-config=".length);
    const synthetic =
      process.argv.includes("--synthetic") || process.argv.includes("--fixtures-only");
    history = new History({
      connectionFile: synthetic
        ? null
        : (connectionFile ?? path.join(app.getPath("userData"), "connection.json")),
      optionalConnection: !connectionFile,
      directory: path.join(app.getPath("userData"), "recordings"),
      fixture: path.join(import.meta.dirname, "fixtures", "journal.jsonl"),
      continuous: !process.argv.includes("--fixtures-only"),
      synthetic,
      settingsFile: path.join(app.getPath("userData"), "preferences.json"),
      testMode,
    });
    review = new PRReview(
      path.join(app.getPath("userData"), "review"),
      async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "Add supplied screenshot",
          properties: ["openFile"],
          filters: [{ name: "PNG screenshot", extensions: ["png"] }],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      testMode
        ? process.argv
            .find((value) => value.startsWith("--review-test-gh="))
            ?.slice("--review-test-gh=".length)
        : undefined,
      (bytes) => {
        const decoded = nativeImage.createFromBuffer(bytes);
        if (decoded.isEmpty()) throw Error("Screenshot could not be decoded.");
        return decoded.getSize();
      },
    );
    catalog = new CatalogDiscovery(
      path.join(app.getPath("userData"), "catalog"),
      testMode
        ? process.argv
            .find((value) => value.startsWith("--catalog-test-cli="))
            ?.slice("--catalog-test-cli=".length)
        : undefined,
    );
    analysis = new SessionAnalysis(
      history.generation,
      async (selectedSession) => {
        const generation = history.generation;
        const value = await history.call("analysis", { session: selectedSession });
        if (generation !== history.generation || !("calls" in value))
          throw new Error(value.error ?? "Session evidence is no longer available.");
        value.localDrops = Math.min(
          Number.MAX_SAFE_INTEGER,
          value.localDrops + history.localDrops + history.rateDrops,
        );
        return value;
      },
      async (options) => {
        if (conversation?.ownsProcess || conversationPending)
          throw new Error("Codex review is open. End review before running diagnosis.");
        const result = await catalog.read(options.signal);
        const error = selectionError(result, options);
        if (error) throw new Error(error);
        return runAnalysisCli(options);
      },
      testMode
        ? process.argv
            .find((value) => value.startsWith("--analysis-test-cli="))
            ?.slice("--analysis-test-cli=".length)
        : undefined,
      path.join(app.getPath("userData"), "analysis"),
    );
    analysis.on("change", present);
    history.on("status", () => {
      if (analysis.generation !== history.generation) analysis.reset(history.generation);
    });
    if (testMode) globalThis.scopeHistory = history;
    history.on("status", present);
    await history.ready;
    await review.ready;
    window = new BrowserWindow({
      title: "Codex Scope",
      width: 1180,
      height: 760,
      useContentSize: true,
      minWidth: 360,
      minHeight: 640,
      backgroundColor: "#F2EADE",
      show: false,
      webPreferences: {
        preload: path.join(import.meta.dirname, "preload.cjs"),
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-frame-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame?.url === PAGE;
    let guidePending: { id: string; finish: (outcome: string) => void } | null = null;
    const dispatchGuide = (action: GuideAction, signal: AbortSignal): Promise<string> =>
      new Promise((resolve) => {
        if (guidePending || signal.aborted || window.isDestroyed()) {
          resolve("Retained. Notebook is unavailable.");
          return;
        }
        const finish = (outcome: string) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          guidePending = null;
          resolve(outcome);
        };
        const cancel = () => {
          window.webContents.send("scope:guide-cancel", action.id);
          finish("Retained. Navigation cancelled.");
        };
        const timer = setTimeout(() => {
          window.webContents.send("scope:guide-cancel", action.id);
          finish("Retained. Notebook acknowledgment timed out; navigation is unconfirmed.");
        }, GUIDANCE_LIMITS.acknowledgmentsMs);
        guidePending = { id: action.id, finish };
        signal.addEventListener("abort", cancel, { once: true });
        window.webContents.send("scope:guide", action);
      });
    ipcMain.on("scope:guide-ack", (event, id, outcome) => {
      if (
        trusted(event) &&
        guidePending?.id === id &&
        typeof outcome === "string" &&
        outcome.length <= 256
      )
        guidePending?.finish(outcome);
    });
    let guidanceBusy = false;
    ipcMain.handle("scope:guidance", async (event, request) => {
      if (
        !trusted(event) ||
        !request ||
        JSON.stringify(request).length > 2048 ||
        !conversation ||
        request.review !== conversation.reviewId
      )
        throw Error("Guidance unavailable or busy.");
      review.identity(request.review);
      const guidance = conversation.tools.guidance;
      if (request.action === "read") return { artifacts: guidance.read() };
      if (request.action === "clear") return { artifacts: guidance.remove() };
      if (typeof request.id !== "string" || request.id.length > 36)
        throw Error("Invalid artifact ID.");
      if (request.action === "remove") return { artifacts: guidance.remove(request.id) };
      if (request.action !== "source") throw Error("Unknown guidance request.");
      if (guidanceBusy) throw Error("Guided source is busy.");
      guidanceBusy = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        return {
          content: await guidance.content(
            request.id,
            controller.signal,
            request.source,
            request.offset,
            request.selected,
          ),
        };
      } finally {
        guidanceBusy = false;
        clearTimeout(timer);
      }
    });
    ipcMain.handle("scope:review", async (event, request) => {
      if (
        !trusted(event) ||
        !request ||
        typeof request !== "object" ||
        JSON.stringify(request).length > 4096
      )
        return { error: "Invalid PR request." };
      if ((request.action === "end" || request.action === "open") && review.posting.blocksSwitch)
        return { error: "Resolve the pending comment before ending or replacing this review." };
      if (
        (request.action === "end" || (request.action === "open" && request.replace === true)) &&
        conversation
      ) {
        if (request.action === "end") review.identity(request.id);
        await conversation.close();
        const reply = await review.request(request);
        if (!reply.error) {
          conversation = null;
          sentConversationVersion = -1;
        }
        return reply;
      }
      return review.request(request);
    });
    ipcMain.handle("scope:posting", (event, request) => {
      if (!trusted(event)) throw Error("Invalid comment sender.");
      return review.posting.request(request);
    });
    let feedbackCopyPending = false;
    async function copyCommentText(text: string) {
      if (feedbackCopyPending) throw Error("Clipboard operation is pending.");
      feedbackCopyPending = true;
      let timer: NodeJS.Timeout | undefined;
      const operation = Promise.resolve()
        .then(async () => {
          await clipboard.writeText(text);
          if ((await clipboard.readText()) !== text)
            throw Error(
              "Clipboard did not retain the complete feedback text. Copy is unconfirmed.",
            );
        })
        .finally(() => {
          feedbackCopyPending = false;
        });
      try {
        await Promise.race([
          operation,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Copy is unconfirmed. It may still finish.")),
              2500,
            );
          }),
        ]);
        return true;
      } finally {
        clearTimeout(timer);
      }
    }
    ipcMain.handle("scope:comment-copy", async (event, request) => {
      if (
        !trusted(event) ||
        !request ||
        typeof request.body !== "string" ||
        Buffer.byteLength(request.body) > 65536
      )
        throw Error("Invalid comment copy.");
      review.identity(request.review);
      // eslint-disable-next-line no-control-regex
      if (
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.body) ||
        Buffer.from(request.body).toString("utf8") !== request.body
      )
        throw Error("Comment contains unsupported text.");
      return copyCommentText(request.body);
    });
    let commentLinkPending = false;
    ipcMain.handle("scope:comment-open", async (event, request) => {
      if (!trusted(event) || !request || JSON.stringify(request).length > 1024)
        throw Error("Invalid comment link.");
      if (commentLinkPending) throw Error("A GitHub link is still opening.");
      const url = review.posting.link(request.review, request.comment);
      commentLinkPending = true;
      let timer: NodeJS.Timeout | undefined;
      const operation = shell.openExternal(url).finally(() => {
        commentLinkPending = false;
      });
      try {
        await Promise.race([
          operation,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Opening GitHub is unconfirmed. It may still finish.")),
              2500,
            );
          }),
        ]);
        return true;
      } finally {
        clearTimeout(timer);
      }
    });
    ipcMain.handle("scope:feedback-copy", async (event, request) => {
      if (
        !trusted(event) ||
        feedbackCopyPending ||
        !request ||
        JSON.stringify(request).length > FEEDBACK_LIMITS.copyBytes * 6
      )
        throw Error("Feedback copy is busy or invalid.");
      const identity = review.identity(request.review);
      if (
        !request.draft ||
        JSON.stringify(request.draft.revision) !==
          JSON.stringify({
            repository: identity.repository,
            number: identity.number,
            base: identity.base,
            head: identity.head,
          })
      )
        throw Error("Feedback revision does not match this retained review.");
      const text = feedbackCopy(request.draft, request.section);
      return copyCommentText(text);
    });
    ipcMain.handle("scope:conversation", async (event, request) => {
      if (
        !trusted(event) ||
        !request ||
        typeof request !== "object" ||
        JSON.stringify(request).length > 20000 ||
        typeof request.review !== "string"
      )
        throw new Error("Invalid conversation request.");
      review.identity(request.review);
      if (request.action === "read") {
        if (
          !Number.isInteger(request.offset) ||
          request.offset < 0 ||
          request.offset > SESSION_LIMITS.entries
        )
          throw new Error("Invalid conversation page.");
        return (
          conversation?.read(request.offset) ?? {
            review: request.review,
            version: 0,
            status: "idle",
            selection: null,
            prompts: null,
            lens: "Overview",
            error: null,
            total: 0,
            offset: 0,
            entries: [],
          }
        );
      }
      if (request.action === "stop") {
        await conversation?.stop();
        return conversation?.read(SESSION_LIMITS.entries);
      }
      if (request.action === "copy") {
        if (conversation) await clipboard.writeText(conversation.export());
        return conversation?.read(SESSION_LIMITS.entries);
      }
      if (
        !["send", "feedback"].includes(request.action) ||
        (request.action === "send" && typeof request.text !== "string") ||
        !LENSES.includes(request.lens) ||
        conversationPending
      )
        throw new Error("Conversation request is invalid or busy.");
      if (analysis.list().activeRunId || analysis.list().handoffRunId || catalog.busy)
        throw new Error("Codex is busy. Wait for diagnosis or model discovery before reviewing.");
      conversationPending = true;
      try {
        const settings = await history.call("settings");
        if (!("review" in settings)) throw new Error("Review settings unavailable.");
        if (request.action === "feedback" && !conversation)
          throw Error("No live review agent. Edit feedback manually.");
        const prompts = snapshotReviewPrompts(
          request.action === "feedback" ? "feedback" : request.lens,
          settings.prompts,
        );
        if (!conversation) {
          const result = await catalog.read();
          const error = selectionError(result, settings.review);
          if (error) throw new Error(error);
          review.identity(request.review);
          conversation = new ReviewSession(
            request.review,
            review,
            path.join(app.getPath("userData"), "review-session"),
            testMode
              ? process.argv
                  .find((v) => v.startsWith("--review-test-cli="))
                  ?.slice("--review-test-cli=".length)
              : undefined,
            [],
            dispatchGuide,
          );
          conversation.on("change", present);
        }
        await conversation.send(
          request.action === "feedback" ? prompts.lens.text : request.text,
          request.lens,
          settings.review,
          prompts,
        );
        return conversation.read(SESSION_LIMITS.entries);
      } finally {
        conversationPending = false;
      }
    });
    ipcMain.on("scope:review-cancel", (event) => {
      if (trusted(event)) review.cancel();
    });
    ipcMain.handle("scope:models", async (event) => {
      if (
        !trusted(event) ||
        catalog.busy ||
        conversation?.ownsProcess ||
        analysis.list().activeRunId ||
        analysis.list().handoffRunId
      )
        return {
          models: [],
          complete: false,
          error: "Codex is busy. Wait for the current task and refresh models.",
        };
      pickerDiscovery = true;
      try {
        return await catalog.read();
      } finally {
        pickerDiscovery = false;
      }
    });
    ipcMain.on("scope:models-cancel", (event) => {
      if (trusted(event) && pickerDiscovery) catalog.cancel();
    });
    for (const operation of ["settings", "saveSettings", "savePrompt", "capture"] as const) {
      ipcMain.handle(`scope:${operation}`, async (event, value) => {
        const stopping = operation === "capture" && value === false;
        if (!trusted(event) || (!stopping && history.savingSettings))
          throw new Error("Settings are busy. Wait for the current save to finish.");
        if (operation === "capture" && typeof value !== "boolean")
          throw new Error("Invalid capture request.");
        if (
          operation === "saveSettings" &&
          (!value ||
            typeof value !== "object" ||
            Object.keys(value).length !== 4 ||
            typeof value.endpoint !== "string" ||
            value.endpoint.length > 4096 ||
            typeof value.token !== "string" ||
            value.token.length > 256 ||
            !validSelection(value.diagnosis) ||
            !validSelection(value.review))
        )
          throw new Error("Check the connection and model settings.");
        if (
          operation === "savePrompt" &&
          (!value ||
            typeof value !== "object" ||
            Object.keys(value).length !== 2 ||
            !validPromptId(value.id) ||
            (value.text !== null && !validPromptText(value.text)))
        )
          throw new Error("Enter a nonempty prompt of at most 8 KiB without control characters.");
        return operation === "settings"
          ? history.call("settings")
          : operation === "capture"
            ? history.call("capture", { start: value })
            : history.call(operation, { value });
      });
    }
    ipcMain.on("scope:ack", (event, kind) => {
      if (!trusted(event)) return;
      if (kind === "hidden") {
        hiddenPending = false;
        return;
      }
      presentationPending = false;
      if (presentationDirty) present();
    });
    const analysisRequest = (event: IpcMainInvokeEvent, generation: unknown) => {
      if (
        !trusted(event) ||
        generation !== history.generation ||
        generation !== analysis.generation
      )
        throw new Error("Analysis is unavailable for this recording.");
    };
    const runId = (id: unknown): id is string =>
      typeof id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(id);
    ipcMain.handle("scope:analysis-list", (event, generation: number) => {
      analysisRequest(event, generation);
      return analysis.list();
    });
    ipcMain.handle("scope:analysis-run", (event, generation: number, id: string) => {
      analysisRequest(event, generation);
      if (!runId(id)) throw new Error("Invalid analysis run.");
      return analysis.get(id);
    });
    if (testMode)
      Object.defineProperty(globalThis, "scopeReviewSession", { get: () => conversation });
    ipcMain.handle(
      "scope:analysis-start",
      (
        event,
        generation: number,
        selectedSession: string,
        model: string,
        effort: string,
        source: string | null,
      ) => {
        analysisRequest(event, generation);
        if (
          !validSession(selectedSession) ||
          !validModel(model) ||
          !validEffort(effort) ||
          !(source === null || runId(source))
        )
          throw new Error("Choose a session and a valid Codex model identifier.");
        if (conversation?.ownsProcess || conversationPending)
          throw new Error("Codex review is open. End review before running diagnosis.");
        return analysis.start(selectedSession, model, effort, source);
      },
    );
    ipcMain.handle("scope:analysis-cancel", (event, generation: number) => {
      analysisRequest(event, generation);
      analysis.cancel();
    });
    ipcMain.handle(
      "scope:analysis-decide",
      (event, generation: number, id: string, finding: string, decision: AnalysisDecision) => {
        analysisRequest(event, generation);
        if (
          !runId(id) ||
          typeof finding !== "string" ||
          finding.length > 80 ||
          !["unreviewed", "kept", "dismissed"].includes(decision)
        )
          throw new Error("Invalid recommendation decision.");
        return analysis.decide(id, finding, decision);
      },
    );
    let exporting = false;
    let handoffCopyPending = false;
    ipcMain.handle("scope:analysis-export", async (event, generation: number, id: string) => {
      analysisRequest(event, generation);
      if (!runId(id) || exporting || handoffCopyPending)
        throw new Error("A handoff is still being prepared or copied.");
      exporting = true;
      try {
        const text = await analysis.handoff(id);
        if (history.generation !== generation) return false;
        handoffCopyPending = true;
        let timer: NodeJS.Timeout | undefined;
        const write = Promise.resolve()
          .then(() => clipboard.writeText(text))
          .catch(() => {
            throw new Error("The handoff could not be copied. Try again.");
          })
          .finally(() => {
            handoffCopyPending = false;
          });
        try {
          await Promise.race([
            write,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error("The clipboard has not confirmed the copy. It may still finish."),
                  ),
                COPY_TIMEOUT_MS,
              );
            }),
          ]);
          return true;
        } finally {
          clearTimeout(timer);
        }
      } finally {
        exporting = false;
      }
    });
    let inspecting = false;
    ipcMain.handle(
      "scope:inspect",
      async (event, generation: number, id: number | null, rows: number) => {
        if (
          !trusted(event) ||
          inspecting ||
          !Number.isSafeInteger(generation) ||
          !(id === null || Number.isSafeInteger(id)) ||
          !Number.isInteger(rows) ||
          rows < 1 ||
          rows > LIMITS.rows
        ) {
          throw new Error("Inspection unavailable.");
        }
        inspecting = true;
        try {
          return {
            ...(await history.inspect(generation, id, rows)),
            localDrops: history.localDrops,
            rateDrops: history.rateDrops,
            unknownGap: history.unknownGap,
          };
        } finally {
          inspecting = false;
        }
      },
    );
    ipcMain.on("scope:cancel", (event, generation: number, targetId: number) => {
      if (trusted(event) && Number.isSafeInteger(generation) && positive(targetId))
        history.cancel(generation, targetId);
    });
    ipcMain.handle(
      "scope:navigate",
      async (event, generation: number, query: NavigationRequest) => {
        if (
          !trusted(event) ||
          inspecting ||
          !Number.isSafeInteger(generation) ||
          !validNavigation(query, LIMITS.rows)
        )
          throw new Error("Navigation unavailable.");
        inspecting = true;
        try {
          return {
            ...(await history.navigate(generation, query)),
            localDrops: history.localDrops,
            rateDrops: history.rateDrops,
            unknownGap: history.unknownGap,
          };
        } finally {
          inspecting = false;
        }
      },
    );
    let readingChoices = false;
    ipcMain.handle(
      "scope:choices",
      async (
        event,
        generation: number,
        field: ChoiceField,
        cursor: string | null,
        direction: Direction,
      ) => {
        if (
          !trusted(event) ||
          readingChoices ||
          !Number.isSafeInteger(generation) ||
          !["session", "hook"].includes(field) ||
          !["next", "previous"].includes(direction) ||
          !(
            cursor === null ||
            (typeof cursor === "string" && Buffer.byteLength(cursor) <= QUERY_LIMITS.choiceBytes)
          )
        )
          throw new Error("Filter choices unavailable.");
        readingChoices = true;
        try {
          return await history.choices(generation, field, cursor, direction);
        } finally {
          readingChoices = false;
        }
      },
    );
    ipcMain.handle("scope:clear", (event, generation: number) => {
      if (!trusted(event) || !Number.isSafeInteger(generation))
        throw new Error("Clear unavailable.");
      return history.clear(generation);
    });
    ipcMain.handle("scope:status", (event) => {
      if (!trusted(event)) throw new Error("History unavailable.");
      return history.snapshot();
    });
    let copying = false;
    ipcMain.handle("scope:copy", async (event, generation: number, id: number) => {
      if (
        !trusted(event) ||
        !Number.isSafeInteger(id) ||
        !Number.isSafeInteger(generation) ||
        copying
      )
        return false;
      copying = true;
      let timer: NodeJS.Timeout | undefined;
      const write = Promise.resolve()
        .then(async () => {
          const result = await history.inspect(generation, id, 1);
          if (
            generation !== history.generation ||
            !("selected" in result) ||
            result.selected?.id !== id
          )
            return false;
          await clipboard.writeText(result.selected.text);
          return generation === history.generation;
        })
        .catch(() => false)
        .finally(() => {
          copying = false;
        });
      try {
        return await Promise.race([
          write,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), COPY_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    window.on("show", present);
    window.on("restore", present);
    const hidden = () => {
      clearTimeout(presentationTimer);
      presentationTimer = undefined;
      if (!hiddenPending) {
        hiddenPending = true;
        window.webContents.send("scope:hidden");
      }
    };
    window.on("hide", hidden);
    window.on("minimize", hidden);
    window.once("ready-to-show", () => window.show());
    await window.loadURL(PAGE);
  })
  .catch(() => {
    app.exit(1);
  });

app.on("window-all-closed", () => app.quit());
