const { app, BrowserWindow, clipboard, ipcMain, Menu, protocol, session } = require('electron');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { validNavigation, positive, QUERY_LIMITS } = require('./search.cjs');
const { History, LIMITS } = require('./history.cjs');

const PAGE = 'scope://app/index.html';
const COPY_TIMEOUT_MS = 2000;
const assets = new Map([
  [PAGE, ['index.html', 'text/html']],
  ['scope://app/style.css', ['style.css', 'text/css']],
  ['scope://app/renderer.js', ['renderer.js', 'text/javascript']],
  ['scope://app/scrollbar.js', ['scrollbar.js', 'text/javascript']],
  ['scope://app/filters.js', ['filters.js', 'text/javascript']],
]);
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
protocol.registerSchemesAsPrivileged([{ scheme: 'scope', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
app.setName('Codex Scope');
const testMode = process.argv.includes('--history-test');
const testRoot = testMode && process.argv.find(value => value.startsWith('--scope-test-root='))?.split('=').slice(1).join('=');
if (testRoot) app.setPath('userData', testRoot);
const owner = app.requestSingleInstanceLock();
let history, window, quitting = false, presentationTimer;
let presentationPending = false, presentationDirty = false, hiddenPending = false;
if (!owner) app.exit(0);
app.on('second-instance', () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } });
function present() {
  presentationDirty = true;
  if (presentationPending || !window || window.isDestroyed() || !window.isVisible() || window.isMinimized() || presentationTimer) return;
  presentationTimer = setTimeout(() => {
    presentationTimer = null;
    if (!window.isDestroyed() && window.isVisible() && !window.isMinimized()) {
      presentationDirty = false;
      presentationPending = true;
      window.webContents.send('scope:status', history.snapshot());
    }
  }, 200);
}
app.on('before-quit', event => {
  if (quitting || !history) return;
  event.preventDefault();
  quitting = true;
  clearTimeout(presentationTimer);
  const deadline = setTimeout(() => { console.error('Temporary recording cleanup timed out. Startup will retry removal.'); app.exit(1); }, LIMITS.requestMs + 250);
  history.close().then(ok => {
    if (!ok) console.error('Temporary recording cleanup failed. Startup will retry removal.');
    clearTimeout(deadline);
    app.exit(ok ? 0 : 1);
  }, () => app.exit(1));
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const isolated = session.fromPartition('synthetic');
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !assets.has(details.url) }));
  isolated.on('will-download', event => event.preventDefault());
  isolated.protocol.handle('scope', async request => {
    const asset = assets.get(request.url);
    if (request.method !== 'GET' || !asset) return new Response('', { status: 404 });
    return new Response(await readFile(path.join(__dirname, 'ui', asset[0])), {
      headers: { 'content-type': asset[1], 'content-security-policy': csp, 'x-content-type-options': 'nosniff' },
    });
  });
  history = new History({ directory: path.join(app.getPath('userData'), 'recordings'),
    fixture: path.join(__dirname, '..', 'fixtures', 'journal.jsonl'),
    continuous: !process.argv.includes('--fixtures-only'), testMode });
  if (testMode) globalThis.scopeHistory = history;
  history.on('status', present);
  await history.ready;
  window = new BrowserWindow({
    title: 'Codex Scope', width: 1180, height: 760, useContentSize: true,
    minWidth: 360, minHeight: 640, backgroundColor: '#F2EADE', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), session: isolated,
      sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
      webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  const trusted = event => event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === PAGE;
  ipcMain.on('scope:ack', (event, kind) => {
    if (!trusted(event)) return;
    if (kind === 'hidden') { hiddenPending = false; return; }
    presentationPending = false;
    if (presentationDirty) present();
  });
  let inspecting = false;
  ipcMain.handle('scope:inspect', async (event, generation, id, rows) => {
    if (!trusted(event) || inspecting || !Number.isSafeInteger(generation) ||
        !(id === null || Number.isSafeInteger(id)) || !Number.isInteger(rows) || rows < 1 || rows > LIMITS.rows) {
      throw new Error('Inspection unavailable.');
    }
    inspecting = true;
    try { return { ...await history.inspect(generation, id, rows), localDrops: history.localDrops, rateDrops: history.rateDrops, unknownGap: history.unknownGap }; }
    finally { inspecting = false; }
  });
  ipcMain.on('scope:cancel', (event, generation, targetId) => {
    if (trusted(event) && Number.isSafeInteger(generation) && positive(targetId)) history.cancel(generation, targetId);
  });
  ipcMain.handle('scope:navigate', async (event, generation, query) => {
    if (!trusted(event) || inspecting || !Number.isSafeInteger(generation) || !validNavigation(query, LIMITS.rows)) throw new Error('Navigation unavailable.');
    inspecting = true;
    try { return { ...await history.navigate(generation, query), localDrops: history.localDrops, rateDrops: history.rateDrops, unknownGap: history.unknownGap }; }
    finally { inspecting = false; }
  });
  let readingChoices = false;
  ipcMain.handle('scope:choices', async (event, generation, field, cursor, direction) => {
    if (!trusted(event) || readingChoices || !Number.isSafeInteger(generation) || !['session', 'hook'].includes(field) ||
        !['next', 'previous'].includes(direction) || !(cursor === null || typeof cursor === 'string' && Buffer.byteLength(cursor) <= QUERY_LIMITS.choiceBytes)) throw new Error('Filter choices unavailable.');
    readingChoices = true;
    try { return await history.choices(generation, field, cursor, direction); }
    finally { readingChoices = false; }
  });
  ipcMain.handle('scope:clear', (event, generation) => {
    if (!trusted(event) || !Number.isSafeInteger(generation)) throw new Error('Clear unavailable.');
    return history.clear(generation);
  });
  ipcMain.handle('scope:status', event => {
    if (!trusted(event)) throw new Error('History unavailable.');
    return history.snapshot();
  });
  let copying = false;
  ipcMain.handle('scope:copy', async (event, generation, id) => {
    if (!trusted(event) || !Number.isSafeInteger(id) || !Number.isSafeInteger(generation) || copying) return false;
    copying = true;
    let timer;
    const write = Promise.resolve().then(async () => {
      const result = await history.inspect(generation, id, 1);
      if (generation !== history.generation || result.selected?.id !== id) return false;
      await clipboard.writeText(result.selected.text);
      return generation === history.generation;
    }).catch(() => false).finally(() => { copying = false; });
    try {
      return await Promise.race([write, new Promise(resolve => { timer = setTimeout(() => resolve(false), COPY_TIMEOUT_MS); })]);
    } finally { clearTimeout(timer); }
  });
  for (const event of ['show', 'restore']) window.on(event, present);
  for (const event of ['hide', 'minimize']) window.on(event, () => {
    clearTimeout(presentationTimer); presentationTimer = null;
    if (!hiddenPending) { hiddenPending = true; window.webContents.send('scope:hidden'); }
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(PAGE);
}).catch(() => { app.exit(1); });

app.on('window-all-closed', () => app.quit());
