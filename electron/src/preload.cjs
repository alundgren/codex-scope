const { contextBridge, ipcRenderer } = require('electron');

let inspecting = false, copying = false, clearing = false, subscribed = false, readingStatus = false;
let onHidden;
ipcRenderer.on('scope:hidden', () => { try { onHidden?.(); } finally { ipcRenderer.send('scope:ack', 'hidden'); } });
contextBridge.exposeInMainWorld('scope', {
  status: async () => {
    if (readingStatus) throw new Error('History is busy.');
    readingStatus = true;
    try { return await ipcRenderer.invoke('scope:status'); }
    finally { readingStatus = false; }
  },
  onStatus: callback => {
    if (subscribed || typeof callback !== 'function') return;
    subscribed = true;
    ipcRenderer.on('scope:status', (_event, value) => { try { callback(value); } finally { ipcRenderer.send('scope:ack', 'status'); } });
  },
  onHidden: callback => { if (!onHidden && typeof callback === 'function') onHidden = callback; },
  inspect: async (generation, id, rows) => {
    if (inspecting || !Number.isSafeInteger(generation) || !(id === null || Number.isSafeInteger(id)) ||
        !Number.isInteger(rows) || rows < 1 || rows > 5) throw new Error('Invalid inspection request.');
    inspecting = true;
    try { return await ipcRenderer.invoke('scope:inspect', generation, id, rows); }
    finally { inspecting = false; }
  },
  copyPayload: async (generation, id) => {
    if (copying || !Number.isSafeInteger(generation) || !Number.isSafeInteger(id)) return false;
    copying = true;
    try { return await ipcRenderer.invoke('scope:copy', generation, id); }
    catch { return false; }
    finally { copying = false; }
  },
  clear: async generation => {
    if (clearing || !Number.isSafeInteger(generation)) throw new Error('Clear unavailable.');
    clearing = true;
    try { return await ipcRenderer.invoke('scope:clear', generation); }
    finally { clearing = false; }
  },
});
