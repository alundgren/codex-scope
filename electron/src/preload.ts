import type { ScopeAPI } from "./types.ts";
import { contextBridge, ipcRenderer } from "electron";

let inspecting = false,
  copying = false,
  clearing = false,
  subscribed = false,
  readingStatus = false;
let onHidden: (() => void) | undefined,
  readingChoices = false;
ipcRenderer.on("scope:hidden", () => {
  try {
    onHidden?.();
  } finally {
    ipcRenderer.send("scope:ack", "hidden");
  }
});
let analysisCallback: (() => void) | undefined;
let analysisRequests = 0;
let analysisCancellation: Promise<void> | undefined;
async function analysisInvoke(channel: string, generation: number, ...args: unknown[]) {
  if (
    !Number.isSafeInteger(generation) ||
    analysisRequests >= 3 ||
    args.some((arg) => arg !== null && (typeof arg !== "string" || arg.length > 1024)) ||
    JSON.stringify(args).length > 4096
  )
    throw new Error("Analysis is busy or the request is invalid.");
  analysisRequests++;
  try {
    return await ipcRenderer.invoke(channel, generation, ...args);
  } finally {
    analysisRequests--;
  }
}
let reviewPending = false;
let catalogPending: Promise<unknown> | null = null;
let settingsBusy = false;
async function settingsInvoke(operation: string, value?: unknown) {
  if (settingsBusy || (value !== undefined && JSON.stringify(value).length > 17000))
    throw new Error("Settings are busy or too large. Try again.");
  settingsBusy = true;
  try {
    return await ipcRenderer.invoke(`scope:${operation}`, value);
  } finally {
    settingsBusy = false;
  }
}
let conversationRequests = 0;
let conversationCallback: (() => void) | undefined;
const scope: ScopeAPI = {
  conversation: async (request) => {
    if (conversationRequests >= 3 || !request || JSON.stringify(request).length > 20000)
      throw new Error("Conversation request is busy or invalid.");
    conversationRequests++;
    try {
      return await ipcRenderer.invoke("scope:conversation", request);
    } finally {
      conversationRequests--;
    }
  },
  onConversation: (callback) => {
    if (conversationCallback || typeof callback !== "function") return;
    conversationCallback = callback;
    ipcRenderer.on("scope:conversation", () => conversationCallback?.());
  },
  review: async (request) => {
    if (
      reviewPending ||
      !request ||
      typeof request !== "object" ||
      JSON.stringify(request).length > 4096
    )
      throw new Error("PR request is busy or invalid.");
    reviewPending = true;
    try {
      return await ipcRenderer.invoke("scope:review", request);
    } finally {
      reviewPending = false;
    }
  },
  cancelReview: () => {
    if (reviewPending) ipcRenderer.send("scope:review-cancel");
  },
  models: () => {
    if (catalogPending) throw new Error("Model discovery is already running.");
    const request = ipcRenderer.invoke("scope:models");
    catalogPending = request;
    return request.finally(() => {
      catalogPending = null;
    });
  },
  cancelModels: () => {
    if (catalogPending) ipcRenderer.send("scope:models-cancel");
  },
  settings: () => settingsInvoke("settings"),
  savePrompt: (value) => settingsInvoke("savePrompt", value),
  saveSettings: (value) => settingsInvoke("saveSettings", value),
  capture: (start) => settingsInvoke("capture", start),
  analysisList: (generation) => analysisInvoke("scope:analysis-list", generation),
  analysisRun: (generation, id) => analysisInvoke("scope:analysis-run", generation, id),
  analysisStart: (generation, session, model, effort, source) =>
    analysisInvoke("scope:analysis-start", generation, session, model, effort, source),
  analysisCancel: async (generation) => {
    if (!Number.isSafeInteger(generation)) throw new Error("Invalid analysis cancellation.");
    analysisCancellation ??= ipcRenderer.invoke("scope:analysis-cancel", generation).finally(() => {
      analysisCancellation = undefined;
    });
    await analysisCancellation;
  },
  analysisDecide: (generation, id, finding, decision) =>
    analysisInvoke("scope:analysis-decide", generation, id, finding, decision),
  analysisExport: (generation, id) => analysisInvoke("scope:analysis-export", generation, id),
  onAnalysis: (callback) => {
    if (analysisCallback || typeof callback !== "function") return;
    analysisCallback = callback;
    ipcRenderer.on("scope:analysis", () => analysisCallback?.());
  },
  status: async () => {
    if (readingStatus) throw new Error("History is busy.");
    readingStatus = true;
    try {
      return await ipcRenderer.invoke("scope:status");
    } finally {
      readingStatus = false;
    }
  },
  onStatus: (callback) => {
    if (subscribed || typeof callback !== "function") return;
    subscribed = true;
    ipcRenderer.on("scope:status", (_event, value) => {
      try {
        callback(value);
      } finally {
        ipcRenderer.send("scope:ack", "status");
      }
    });
  },
  onHidden: (callback) => {
    if (!onHidden && typeof callback === "function") onHidden = callback;
  },
  inspect: async (generation, id, rows) => {
    if (
      inspecting ||
      !Number.isSafeInteger(generation) ||
      !(id === null || Number.isSafeInteger(id)) ||
      !Number.isInteger(rows) ||
      rows < 1 ||
      rows > 5
    )
      throw new Error("Invalid inspection request.");
    inspecting = true;
    try {
      return await ipcRenderer.invoke("scope:inspect", generation, id, rows);
    } finally {
      inspecting = false;
    }
  },
  cancel: (generation, targetId) => {
    if (
      Number.isSafeInteger(generation) &&
      Number.isInteger(targetId) &&
      targetId > 0 &&
      targetId <= 2147483647
    )
      ipcRenderer.send("scope:cancel", generation, targetId);
  },
  navigate: async (generation, query) => {
    if (
      inspecting ||
      !Number.isSafeInteger(generation) ||
      !query ||
      JSON.stringify(query).length > 140000
    )
      throw new Error("Invalid navigation request.");
    inspecting = true;
    try {
      return await ipcRenderer.invoke("scope:navigate", generation, query);
    } finally {
      inspecting = false;
    }
  },
  choices: async (generation, field, cursor = null, direction = "next") => {
    if (
      readingChoices ||
      !Number.isSafeInteger(generation) ||
      !["session", "hook"].includes(field) ||
      !(cursor === null || (typeof cursor === "string" && cursor.length <= 61440))
    )
      throw new Error("Filter choices unavailable.");
    readingChoices = true;
    try {
      return await ipcRenderer.invoke("scope:choices", generation, field, cursor, direction);
    } finally {
      readingChoices = false;
    }
  },
  copyPayload: async (generation, id) => {
    if (copying || !Number.isSafeInteger(generation) || !Number.isSafeInteger(id)) return false;
    copying = true;
    try {
      return await ipcRenderer.invoke("scope:copy", generation, id);
    } catch {
      return false;
    } finally {
      copying = false;
    }
  },
  clear: async (generation) => {
    if (clearing || !Number.isSafeInteger(generation)) throw new Error("Clear unavailable.");
    clearing = true;
    try {
      return await ipcRenderer.invoke("scope:clear", generation);
    } finally {
      clearing = false;
    }
  },
};
contextBridge.exposeInMainWorld("scope", scope);
