import { _electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { sample } from "./process-metrics.ts";
const visual = process.argv.includes("--visual");
const live = process.argv.includes("--live");
const root = await mkdtemp("/tmp/scope-guidance-measure-");
const output = path.resolve("../.artifacts/visual/issue-34-pressure");
if (visual) await mkdir(output, { recursive: true });
await mkdir(root + "/auth");
await writeFile(root + "/auth/auth.json", "{}", { mode: 0o600 });
const app = await _electron.launch({
  args: [
    path.resolve("dist/app"),
    "--history-test",
    `--scope-test-root=${root}`,
    `--review-test-gh=${path.resolve("test/fixtures/review-gh.cjs")}`,
    ...(live
      ? []
      : [
          `--review-test-cli=${path.resolve("test/fixtures/review-cli.cjs")}`,
          `--catalog-test-cli=${path.resolve("test/fixtures/catalog-cli.cjs")}`,
        ]),
  ],
  env: { ...process.env, ...(live ? {} : { CODEX_HOME: root + "/auth" }) } as Record<
    string,
    string
  >,
  chromiumSandbox: true,
  ...(visual ? { recordVideo: { dir: output, size: { width: 1280, height: 800 } } } : {}),
});
const results: Record<string, unknown> = {
  environment: `Linux sandboxed Electron under Xvfb; synthetic dispatcher action workload and ${live ? "actual installed" : "fixture"} idle Codex child; whole app and descendants; no recording during measurements`,
};
try {
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  const measure = async (name: string, run: () => Promise<void>) => {
    if (visual) {
      await run();
      await page.screenshot({ path: path.join(output, name + ".png") });
    } else {
      await page.evaluate(() => {
        Reflect.get(globalThis, "guideTimer").max = 0;
      });
      await app.evaluate(() => {
        Reflect.get(globalThis, "guideTimer").max = 0;
      });
      results[name] = await sample(app, 0, run);
      results[`${name}-timerDelayMs`] = {
        main: await app.evaluate(() => Reflect.get(globalThis, "guideTimer").max),
        renderer: await page.evaluate(() => Reflect.get(globalThis, "guideTimer").max),
      };
    }
  };
  await page.evaluate(
    (model) =>
      window.scope.saveSettings({
        endpoint: "",
        token: "",
        diagnosis: { model, effort: "low" },
        review: { model, effort: "low" },
      }),
    live ? "gpt-6-astra" : "test-success",
  );
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="review"]').click();
  await page.locator("#review-address").fill("example/shop #148");
  await page.getByRole("button", { name: "Open PR", exact: true }).click();
  await page.waitForSelector(".review-code-row");
  await page.locator("#review-chat-toggle").click();
  await page
    .locator("#conversation-input")
    .fill(live ? "Reply Ready briefly. Do not call tools for this message." : "guide source");
  await page.locator("#conversation-send").click();
  await page.waitForFunction(() =>
    document.querySelector("#conversation-state")?.textContent?.includes("ready"),
  );
  const reviewId = await app.evaluate(() => Reflect.get(globalThis, "scopeReviewSession").reviewId);
  const png = await app.evaluate(({ nativeImage }) => {
    const bytes = Buffer.alloc(2048 * 2048 * 4, 180);
    for (let i = 3; i < bytes.length; i += 4) bytes[i] = 255;
    return nativeImage
      .createFromBitmap(bytes, { width: 2048, height: 2048 })
      .toPNG()
      .toString("base64");
  });
  await writeFile(root + "/large.png", Buffer.from(png, "base64"));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, root + "/large.png");
  if (!visual) {
    const timer = () => {
      const metric = { last: performance.now(), max: 0, maximum: 0 };
      setInterval(() => {
        const now = performance.now();
        metric.max = Math.max(metric.max, now - metric.last - 20);
        metric.maximum = Math.max(metric.maximum, metric.max);
        metric.last = now;
      }, 20);
      Reflect.set(globalThis, "guideTimer", metric);
    };
    await page.evaluate(timer);
    await app.evaluate(timer);
  }
  await measure("00-attach-image", async () => {
    await page.evaluate((id) => window.scope.review({ action: "attach", id }), reviewId);
  });
  const clear = () =>
    page.evaluate((id) => window.scope.guidance({ action: "clear", review: id }), reviewId);
  const call = async (kind: string, index = 0) =>
    app.evaluate(
      async (_electron, { kind, index }) => {
        const session = Reflect.get(globalThis, "scopeReviewSession"),
          tools = session.tools;
        const list = JSON.parse(
          (
            await tools.call(
              "scope_evidence",
              { action: "list", id: "root" },
              new AbortController().signal,
            )
          ).contentItems[0].text,
        );
        const e = list.entries.find((e: any) => e.path === "deleted.ts");
        const anchor = {
          id: e.id,
          revision: e.revision,
          path: e.path,
          side: e.side,
          line: 2,
          endLine: 4,
        };
        const images = JSON.parse(
          (
            await tools.call(
              "scope_evidence",
              { action: "images", id: "root" },
              new AbortController().signal,
            )
          ).contentItems[0].text,
        ).images;
        const data = ["image", "text", "arrows"].includes(kind)
          ? {
              image: images[0].id,
              revision: images[0].head,
              marks:
                kind === "text" || kind === "arrows"
                  ? Array.from({ length: 16 }, (_, i) => ({
                      kind: kind === "text" ? "text" : "arrow",
                      points:
                        kind === "text"
                          ? [[100, (i + index + 1) * 20]]
                          : [
                              [100, (i + index + 1) * 20],
                              [700, (i + index + 1) * 20 + 40],
                            ],
                      text: kind === "text" ? "annotation ".repeat(23) : "",
                    }))
                  : Array.from({ length: index ? 1 : 10 }, (_, mark) => ({
                      kind: "stroke",
                      points: Array.from({ length: index ? 32 : mark === 9 ? 96 : 128 }, (_, i) => [
                        i % 10,
                        (i + index) % 10,
                      ]),
                      text: "",
                    })),
            }
          : {
              nodes: Array.from({ length: 8 }, (_, i) => `${i} ` + "node label ".repeat(23)),
              messages: Array.from({ length: 20 }, (_, i) => ({
                from: i % 8,
                to: i % 8,
                text: "local message ".repeat(12),
              })),
              sources: [anchor],
            };
        const result = await tools.call(
          "scope_guide",
          { action: ["text", "arrows"].includes(kind) ? "image" : kind, data },
          new AbortController().signal,
        );
        return {
          success: result.success,
          result: result.contentItems[0].text,
          bytes: Buffer.byteLength(JSON.stringify(data)),
        };
      },
      { kind, index },
    );
  results.model = live ? "installed Codex gpt-6-astra/low" : "fixture Codex";
  await clear();
  if (!visual) results.idle = await sample(app, 3000);
  await measure("01-maximum-drawing", async () => {
    for (let i = 0; i < 24; i++) {
      const result = await call("image", i);
      assert.ok(result.success, result.result);
      results.actionBytes = Math.max(Number(results.actionBytes ?? 0), result.bytes);
    }
  });
  assert.equal((await call("image")).success, false);
  const count = await page.evaluate(
    (id) => window.scope.guidance({ action: "read", review: id }),
    reviewId,
  );
  results.artifacts = count.artifacts!.length;
  assert.equal(count.artifacts!.length, 24);
  results.retainedSerializedBytes = Buffer.byteLength(JSON.stringify(count));
  results.drawingElements = await page.locator(".review-drawing polyline").count();
  results.imageWidthBefore = await page
    .locator(".review-image-marked img")
    .evaluate((i) => i.getBoundingClientRect().width);
  await measure("02-resize-and-pause", async () => {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(600, 700),
    );
    const error = await page.locator(".review-image-marked").evaluate((w) => {
      const a = w.querySelector("img")!.getBoundingClientRect(),
        b = w.querySelector("svg")!.getBoundingClientRect();
      return Math.max(Math.abs(a.width - b.width), Math.abs(a.height - b.height));
    });
    results.imageWidthAfter = await page
      .locator(".review-image-marked img")
      .evaluate((i) => i.getBoundingClientRect().width);
    assert.notEqual(results.imageWidthBefore, results.imageWidthAfter);
    assert.ok(error < 1);
    results.alignmentErrorPixels = error;
    if (visual) {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25),
      );
      const zoomError = await page.locator(".review-image-marked").evaluate((w) => {
        const a = w.querySelector("img")!.getBoundingClientRect(),
          b = w.querySelector("svg")!.getBoundingClientRect();
        return Math.max(Math.abs(a.width - b.width), Math.abs(a.height - b.height));
      });
      assert.ok(zoomError < 1);
      await page.screenshot({ path: path.join(output, "02-zoom-alignment.png") });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
      );
    }
    await page.locator("#review-follow").click();
  });
  await clear();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  await measure("03-paused-diagram-burst", async () => {
    for (let i = 0; i < 24; i++) {
      const result = await call("diagram");
      assert.ok(result.success, result.result);
      results.diagramBytes = result.bytes;
    }
  });
  await measure("04-long-labels-self-messages", async () => {
    await page.locator("#review-latest-target").click();
    await page.waitForSelector(".review-sequence");
    assert.equal(await page.locator(".review-sequence tspan").count(), 256);
    await page.locator("#review-content").evaluate((e) => {
      e.scrollTop = e.scrollHeight;
    });
  });
  if (!visual) results.retainedIdle = await sample(app, 3000);
  await measure("05-clear", async () => {
    await page.locator("#review-artifacts").click();
    await page.getByRole("button", { name: "Clear marks and diagrams", exact: true }).click();
    assert.equal(await page.locator(".review-sequence,.review-drawing").count(), 0);
  });
  await page.locator("#review-follow").click();
  for (const kind of ["text", "arrows"]) {
    await clear();
    await measure(`06-maximum-${kind}`, async () => {
      for (let i = 0; i < 24; i++) {
        const result = await call(kind, i);
        assert.ok(result.success, result.result);
      }
      assert.equal(
        await page
          .locator(kind === "text" ? ".review-drawing text" : ".review-drawing line")
          .count(),
        384,
      );
    });
  }
  if (!visual) {
    results.mainTimerDelayMs = await app.evaluate(
      () => Reflect.get(globalThis, "guideTimer").maximum,
    );
    results.rendererTimerDelayMs = await page.evaluate(
      () => Reflect.get(globalThis, "guideTimer").maximum,
    );
  }
  await app.close();
  results.temporarySessionFiles = await readdir(root + "/review-session");
  results.temporaryImages = await readdir(root + "/review");
  if (!visual) {
    await mkdir("measurements", { recursive: true });
    await writeFile(
      `measurements/review-guidance${live ? "-live" : ""}.json`,
      JSON.stringify(results, null, 2),
    );
  }
} finally {
  await app.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
