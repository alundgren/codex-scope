/** Render recorded native terminal output for visual inspection and PR attachments. */
import { chromium } from "@playwright/test";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(process.argv[2] ?? ".artifacts/visual/native-setup");
mkdirSync(root, { recursive: true });
const casts = readdirSync(root)
  .filter((name) => name.endsWith(".cast"))
  .sort();
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1040 },
  recordVideo: { dir: root, size: { width: 1440, height: 1040 } },
});
const page = await context.newPage();
const video = page.video();
await page.setContent(
  `<html><head><style>body{margin:0;padding:28px;background:#F2EADE;color:#604939;font:16px/1.5 monospace}h1{font:600 28px/1.4 system-ui;margin:0 0 12px}p{font:16px/1.5 system-ui;margin:0 0 18px}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:21px;margin:0;max-height:882px;overflow:hidden}</style></head><body><h1 id="title">Native setup terminal walkthrough</h1><p>Linux VM · 120 columns × 42 rows · Synthetic host services and approvals · Actual native CLI, collector and observer</p><pre id="terminal"></pre></body></html>`,
);
const snapshot = async (name: string) => page.screenshot({ path: join(root, `${name}.png`) });
for (const cast of casts) {
  const rows = readFileSync(join(root, cast), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const name = cast.slice(0, -5);
  let full = "";
  const captured = new Set<string>();
  await page.locator("#title").evaluate((element, value) => {
    element.textContent = `Native setup: ${value}`;
  }, name);
  for (const frame of rows.slice(1)) {
    full += frame[2].replaceAll("\r", "");
    await page.locator("#terminal").evaluate((element, value) => {
      element.textContent = value.split("\n").slice(-42).join("\n");
    }, full);
    await page.waitForTimeout(100);
    for (const [state, trigger] of [
      ["review", "Apply these changes and run the two interactive tests?"],
      ["trust", "Have you approved those hooks?"],
      ["live", "Did the task finish normally?"],
      ["stopped", "Did that task also finish normally?"],
      ["installed", "Installation state: installed"],
    ] as const) {
      if (name === "success" && full.includes(trigger) && !captured.has(state)) {
        captured.add(state);
        await snapshot(`success-${state}`);
        await page.waitForTimeout(450);
      }
    }
  }
  await snapshot(name);
  await page.waitForTimeout(1100);
  writeFileSync(
    join(root, `${name}.html`),
    `<!doctype html><meta charset="utf-8"><title>Native setup: ${escape(name)}</title><style>body{max-width:120ch;padding:24px;background:#F2EADE;color:#604939}pre{white-space:pre-wrap;font:16px/1.5 monospace}</style><pre>${escape(full)}</pre>`,
  );
}
await page.close();
await context.close();
await video?.saveAs(join(root, "native-setup-walkthrough.webm"));
await browser.close();
console.log(`Rendered ${casts.length} actual PTY recordings to ${root}`);
