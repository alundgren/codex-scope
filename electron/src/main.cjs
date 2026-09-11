const { app, BrowserWindow, clipboard, ipcMain, Menu, protocol, session } = require('electron');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { loadRecording, inspect } = require('./recording.cjs');

const PAGE = 'scope://app/index.html';
const COPY_TIMEOUT_MS = 2000;
const assets = new Map([
  [PAGE, ['index.html', 'text/html']],
  ['scope://app/style.css', ['style.css', 'text/css']],
  ['scope://app/renderer.js', ['renderer.js', 'text/javascript']],
  ['scope://app/scrollbar.js', ['scrollbar.js', 'text/javascript']],
]);
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
protocol.registerSchemesAsPrivileged([{ scheme: 'scope', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
app.setName('Codex Scope');

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
  let recording;
  try { recording = await loadRecording(path.join(__dirname, '..', 'fixtures', 'journal.jsonl')); }
  catch { recording = null; }
  const window = new BrowserWindow({
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
  ipcMain.handle('scope:inspect', (event, id, rows) => {
    if (!trusted(event)) throw new Error('Inspection unavailable.');
    if (!recording) return { error: 'The synthetic recording could not be opened. Restart the app to try again.' };
    return inspect(recording, id, rows);
  });
  let copying = false;
  ipcMain.handle('scope:copy', async (event, id) => {
    if (!trusted(event) || !Number.isSafeInteger(id) || copying || !recording) return false;
    const selected = recording.events.find(item => item.id === id);
    if (!selected) return false;
    copying = true;
    let timer;
    // A timed-out native operation keeps its one slot until it settles.
    const write = Promise.resolve().then(() => clipboard.writeText(selected.text))
      .then(() => true, () => false).finally(() => { copying = false; });
    try {
      return await Promise.race([write, new Promise(resolve => { timer = setTimeout(() => resolve(false), COPY_TIMEOUT_MS); })]);
    } finally { clearTimeout(timer); }
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(PAGE);
}).catch(() => { app.exit(1); });

app.on('window-all-closed', () => app.quit());
