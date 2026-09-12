import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { sample, bytes } from "./process-metrics.ts";
const root = await mkdtemp("/tmp/scope-review-measure-"),
  control = path.join(root, "review-control.json");
const set = async (mode: string) =>
  writeFile(control, JSON.stringify({ large: true, longSource: true, mode }));
await set("");
const app = await _electron.launch({
  args: [
    path.resolve("dist/app"),
    "--history-test",
    `--scope-test-root=${root}`,
    `--review-test-gh=${path.resolve("test/fixtures/review-gh.cjs")}`,
  ],
  chromiumSandbox: true,
});
const child = app.process();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  async function measure(action: () => Promise<unknown>) {
    let temporaryPeakBytes = 0,
      maxFrameResponseMs = 0,
      frameSamples = 0,
      reading: Promise<void> | undefined,
      probing: Promise<void> | undefined;
    const scan = setInterval(() => {
      if (!reading)
        reading = bytes(path.join(root, "review"))
          .then((n) => {
            temporaryPeakBytes = Math.max(temporaryPeakBytes, n);
          })
          .finally(() => {
            reading = undefined;
          });
    }, 250);
    const probe = setInterval(() => {
      if (probing) return;
      const start = performance.now();
      probing = page
        .evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
        .then(() => {
          frameSamples++;
          maxFrameResponseMs = Math.max(maxFrameResponseMs, performance.now() - start);
        })
        .finally(() => {
          probing = undefined;
        });
    }, 100);
    let resources;
    try {
      resources = await sample(app, 0, action);
    } finally {
      clearInterval(scan);
      clearInterval(probe);
      await reading;
      await probing;
    }
    return { ...resources, temporaryPeakBytes, frameSamples, maxFrameResponseMs };
  }
  const menu = async (id: string, text: string) => {
    await page.locator(id).click();
    await page.getByRole("menuitem", { name: text, exact: true }).click();
  };
  const idle = await sample(app, 2000);
  await page.locator("#functions summary").click();
  await page.getByRole("button", { name: "PR review", exact: true }).click();
  await page.locator("#review-address").fill("example/shop #148");
  const open = await measure(async () => {
    await page.getByRole("button", { name: "Open PR", exact: true }).click();
    await expect(page.locator(".review-code-row")).toHaveCount(200);
    await pause(500);
  });
  const largeSource = await measure(async () => {
    await menu("#review-side", "Head source");
    await expect(page.getByRole("button", { name: "head line 1", exact: true })).toBeVisible();
    for (let i = 0; i < 15; i++) {
      await page.locator("#review-next").click();
      await expect(page.locator("#review-cancel")).toBeHidden();
    }
    expect(await page.locator(".review-code-row").count()).toBe(200);
    await pause(700);
  });
  const browse = await measure(async () => {
    for (let i = 0; i < 20; i++) {
      await menu("#review-files", "Next files");
      await page
        .getByRole("menuitem")
        .filter({ hasText: /src\/file-/ })
        .first()
        .click();
      await expect(page.locator("#review-cancel")).toBeHidden();
      await expect(page.locator(".review-code-row")).toHaveCount(200);
    }
    await pause(700);
  });
  const calls = (await readFile(path.join(root, "review-requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).args[3] as string);
  assert.equal(calls.filter((x) => x.includes("/contents/")).length, 1);
  assert.equal(calls.filter((x) => x.includes("/files?")).length, 21);
  const chunk = (name: string, body: Buffer) => {
    const b = Buffer.alloc(body.length + 12);
    b.writeUInt32BE(body.length);
    b.write(name, 4);
    body.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4);
    return b;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2048);
  header.writeUInt32BE(2048, 4);
  header[8] = 8;
  header[9] = 6;
  const basic = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((2048 * 4 + 1) * 2048))),
    chunk("IEND", Buffer.alloc(0)),
  ];
  const pad = Buffer.alloc(4 * 1024 * 1024 - basic.reduce((n, b) => n + b.length, 0) - 12, 65);
  pad[1] = 0;
  const png = Buffer.concat([...basic.slice(0, 3), chunk("tEXt", pad), basic[3]]);
  assert.equal(png.length, 4 * 1024 * 1024);
  const image = path.join(root, "maximum.png");
  await writeFile(image, png);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, image);
  await menu("#review-view", "Visual evidence");
  const screenshots = await measure(async () => {
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Add screenshot", exact: true }).click();
      await expect(page.locator("#review-cancel")).toBeHidden();
    }
    await page.getByRole("button", { name: "maximum.png", exact: true }).first().click();
    await expect(page.locator("#review-content img")).toBeVisible();
    expect(
      await page
        .locator("#review-content img")
        .evaluate((n: HTMLImageElement) => [n.naturalWidth, n.naturalHeight]),
    ).toEqual([2048, 2048]);
    await pause(1500);
    await page.getByRole("button", { name: "Add screenshot", exact: true }).click();
    await expect(page.locator("#review-status")).toContainText("Four screenshots");
  });
  await set("hang");
  let cancellationMs = 0;
  const cancellation = await measure(async () => {
    await menu("#review-more", "Refresh PR");
    await pause(700);
    const start = performance.now();
    await page.locator("#review-cancel").click();
    await expect(page.locator("#review-status")).toContainText("cancelled");
    cancellationMs = performance.now() - start;
    await pause(500);
  });
  await set("oversized");
  const pressure = await measure(async () => {
    await menu("#review-more", "Refresh PR");
    await expect(page.locator("#review-status")).toContainText("limit");
    await pause(500);
  });
  await set("");
  const recovery = await measure(async () => {
    await menu("#review-more", "Refresh PR");
    await expect(page.locator("#review-status")).toContainText("still matches");
    await pause(500);
  });
  await menu("#review-more", "End review");
  await page.getByRole("button", { name: "End review", exact: true }).click();
  await expect(page.locator("#review-open")).toBeVisible();
  assert.deepEqual(await readdir(path.join(root, "review")), []);
  const settled = await sample(app, 2000);
  const start = performance.now();
  await app.close();
  const quitMs = performance.now() - start;
  const result = {
    environment: "Linux sandboxed Electron; no recording",
    limits: {
      paths: 3000,
      manifest: 3010,
      filePagesRead: 21,
      sourceRequests: 1,
      sourceLines: 19000,
      rendererRows: 200,
      screenshots: 4,
      imageBytes: png.length,
      imagePixels: 2048 * 2048,
    },
    idle,
    open,
    largeSource,
    browse,
    screenshots,
    cancellation,
    cancellationMs,
    pressure,
    recovery,
    settled,
    quitMs,
  };
  await mkdir("measurements", { recursive: true });
  await writeFile("measurements/review.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (child.exitCode === null) await app.close();
  await rm(root, { recursive: true, force: true });
}
