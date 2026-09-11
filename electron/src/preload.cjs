const { contextBridge, ipcRenderer } = require('electron');

let inspecting = false;
let copying = false;
contextBridge.exposeInMainWorld('scope', {
  inspect: async (id, rows) => {
    if (inspecting || !(id === null || Number.isSafeInteger(id)) || !Number.isInteger(rows) || rows < 1 || rows > 5) {
      throw new Error('Invalid inspection request.');
    }
    inspecting = true;
    try { return await ipcRenderer.invoke('scope:inspect', id, rows); }
    finally { inspecting = false; }
  },
  copyPayload: async id => {
    if (copying || !Number.isSafeInteger(id)) return false;
    copying = true;
    try { return await ipcRenderer.invoke('scope:copy', id); }
    catch { return false; }
    finally { copying = false; }
  },
});
