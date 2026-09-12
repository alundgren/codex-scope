import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { ChoiceField, Direction, NavigationRequest } from "./types.ts";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, session } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { SessionAnalysis, exportRecommendations, validSession, validModel } from "./analysis.ts";
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
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
protocol.registerSchemesAsPrivileged([
  { scheme: "scope", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.enableSandbox();
app.setName("Codex Scope");
Menu.setApplicationMenu(null);
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
  Promise.all([history.close(), analysis?.close()]).then(
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
    const isolated = session.fromPartition("synthetic");
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !assets.has(details.url) }),
    );
    isolated.on("will-download", (event) => event.preventDefault());
    isolated.protocol.handle("scope", async (request) => {
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
      testMode,
    });
    analysis = new SessionAnalysis(
      history.generation,
      async (selectedSession) => {
        const generation = history.generation;
        const value = await history.call("analysis", { session: selectedSession });
        if (generation !== history.generation || !("calls" in value))
          throw new Error(value.error ?? "Session evidence is no longer available.");
        value.localDrops = history.localDrops + history.rateDrops;
        return value;
      },
      undefined,
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
    ipcMain.handle(
      "scope:analysis-start",
      (
        event,
        generation: number,
        selectedSession: string,
        model: string,
        source: string | null,
      ) => {
        analysisRequest(event, generation);
        if (
          !validSession(selectedSession) ||
          !validModel(model) ||
          !(source === null || runId(source))
        )
          throw new Error("Choose a session and a valid Codex model identifier.");
        return analysis.start(selectedSession, model, source);
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
    ipcMain.handle("scope:analysis-export", async (event, generation: number, id: string) => {
      analysisRequest(event, generation);
      if (!runId(id) || exporting) return false;
      const run = analysis.get(id);
      if (!run) throw new Error("That analysis run is no longer retained.");
      const text = exportRecommendations(run);
      exporting = true;
      try {
        const choice = testRoot
          ? { canceled: false, filePath: path.join(testRoot, "analysis-export.md") }
          : await dialog.showSaveDialog(window, {
              title: "Save recommendations",
              defaultPath: "session-recommendations.md",
              filters: [{ name: "Markdown", extensions: ["md"] }],
            });
        if (choice.canceled || !choice.filePath || history.generation !== generation) return false;
        await writeFile(choice.filePath, text, { mode: 0o600 });
        return true;
      } catch {
        throw new Error("Recommendations could not be saved. Choose another location.");
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
