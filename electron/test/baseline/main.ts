import { app, BrowserWindow, Menu, protocol, session } from "electron";

app.enableSandbox();
Menu.setApplicationMenu(null);
const ownerRoot = process.argv
  .find((value) => value.startsWith("--scope-test-root="))
  ?.slice("--scope-test-root=".length);
if (ownerRoot) app.setPath("userData", ownerRoot);
protocol.registerSchemesAsPrivileged([
  { scheme: "scope", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
void app.whenReady().then(async () => {
  const isolated = session.fromPartition("baseline");
  isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.protocol.handle(
    "scope",
    () =>
      new Response(
        '<!doctype html><html data-ready="true"><title>Codex Scope baseline</title><body></body></html>',
        {
          headers: { "content-type": "text/html", "content-security-policy": "default-src 'none'" },
        },
      ),
  );
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    useContentSize: true,
    show: false,
    backgroundColor: "#F2EADE",
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
      backgroundThrottling: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  await window.loadURL("scope://app/index.html");
});
app.on("window-all-closed", () => app.quit());
