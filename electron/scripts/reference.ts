import { _electron } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const destination = path.resolve("../.artifacts/visual/reference");
await mkdir(destination, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "scope-reference-"));
const app = await _electron.launch({
  args: [path.resolve("dist/baseline/main.mjs"), `--scope-test-root=${root}`],
  chromiumSandbox: true,
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  await app.evaluate(
    ({ BrowserWindow }, file) => BrowserWindow.getAllWindows()[0].loadFile(file),
    path.resolve("../docs/mockups/tool-call-journal.html"),
  );
  await page.waitForSelector("#rows");
  for (const [name, width, height] of [
    ["desktop", 1400, 900],
    ["narrow", 440, 820],
  ] as const) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]),
      [width, height],
    );
    await page.mouse.move(1, 1);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(destination, `reference-${name}.png`) });
  }
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
