import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { sample } from "./process-metrics.ts";
import { fakeCollector, fixtureEvent, wait } from "../test/fake-collector.ts";
const live = process.argv.includes("--live"),
  visual = process.argv.includes("--visual");
const root = await mkdtemp("/tmp/scope-integrated-");
const output = path.resolve("../.artifacts/visual/review-integrated" + (live ? "-live" : ""));
if (visual) await mkdir(output, { recursive: true });
await mkdir(root + "/auth");
await writeFile(root + "/auth/auth.json", "{}", { mode: 0o600 });
await writeFile(root + "/review-control.json", JSON.stringify({ large: true, longSource: true }));
const server = await fakeCollector();
const app = await _electron.launch({
  args: [
    path.resolve("dist/app"),
    "--history-test",
    `--scope-test-root=${root}`,
    `--review-test-gh=${path.resolve("test/fixtures/review-gh.cjs")}`,
    `--analysis-test-cli=${path.resolve("test/fixtures/analysis-view-cli.cjs")}`,
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
const report: Record<string, any> = {
  environment: `Linux sandboxed Electron/GPU under isolated Xvfb; ${live ? "actual installed CLI gpt-6-astra/low" : "fixture CLI"}; synthetic source, supplied images, long retained transcript, artifacts and collector; ${visual ? "visual walkthrough, no accepted resource metrics" : "whole Electron plus descendants, no recording"}`,
  phases: {},
  workload: {
    imageCount: 4,
    imageBytesEach: 4194304,
    imagePixelsEach: 4194304,
    sourceLines: 19000,
    retainedSyntheticEntries: 220,
    artifacts: 24,
    drawingPoints: 1248,
    diagrams: 23,
    messagesPerDiagram: 20,
    nodesPerDiagram: 8,
    capturePayloadBytes: 60168,
  },
  copyResponseMs: [],
};
const disk = async (dir: string): Promise<number> => {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory()
      ? await disk(p)
      : e.isFile()
        ? (await stat(p).catch(() => ({ size: 0 }))).size
        : 0;
  }
  return total;
};
let incoming: ReturnType<typeof setInterval> | undefined;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  const timer = () => {
    const m = { last: performance.now(), max: 0 };
    setInterval(() => {
      const now = performance.now();
      m.max = Math.max(m.max, now - m.last - 20);
      m.last = now;
    }, 20);
    Reflect.set(globalThis, "integratedTimer", m);
  };
  if (!visual) {
    await page.evaluate(timer);
    await app.evaluate(timer);
  }
  const measure = async (name: string, work: () => Promise<unknown>) => {
    if (visual) {
      await work();
      await page.screenshot({ path: path.join(output, name + ".png") });
      return;
    }
    await page.evaluate(() => {
      Reflect.get(globalThis, "integratedTimer").max = 0;
    });
    await app.evaluate(() => {
      Reflect.get(globalThis, "integratedTimer").max = 0;
    });
    report.phases[name] = await sample(app, 0, work);
    report.phases[name].rendererDelayMs = await page.evaluate(
      () => Reflect.get(globalThis, "integratedTimer").max,
    );
    report.phases[name].mainDelayMs = await app.evaluate(
      () => Reflect.get(globalThis, "integratedTimer").max,
    );
    report.phases[name].temporaryBytes = await disk(root);
  };
  await measure("01-idle", () => wait(3000));
  await page.evaluate(
    ({ endpoint, model }) =>
      window.scope.saveSettings({
        endpoint,
        token: "synthetic-test-token",
        diagnosis: { model: "test-success", effort: "low" },
        review: { model, effort: "low" },
      }),
    { endpoint: server.endpoint, model: live ? "gpt-6-astra" : "test-success" },
  );
  await page.locator("#capture").click();
  await wait(300);
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "synthetic-session-a",
    tool_name: "Bash",
    tool_input: { command: "echo synthetic" },
    padding: "X".repeat(60000),
  });
  report.workload.capturePayloadBytes = Buffer.byteLength(payload);
  incoming = setInterval(
    () => server.event({ ...fixtureEvent, payload, payload_bytes: Buffer.byteLength(payload) }),
    40,
  );
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="review"]').click();
  await page.locator("#review-address").fill("example/shop #148");
  await page.getByRole("button", { name: "Open PR", exact: true }).click();
  await expect(page.locator(".review-code-row")).toHaveCount(200);
  await page.locator("#review-chat-toggle").click();
  await page
    .locator("#conversation-input")
    .fill(live ? "Reply Ready briefly without tools." : "Ready");
  await page.locator("#conversation-send").click();
  await expect(page.locator("#conversation-state")).toContainText("ready", { timeout: 120000 });
  const id = await app.evaluate(() => Reflect.get(globalThis, "scopeReviewSession").reviewId);
  await measure("02-retain-large-inputs", async () => {
    await page.evaluate(
      (id) =>
        window.scope.review({
          action: "content",
          id,
          path: "src/checkout/submit.ts",
          mode: "head",
          offset: 10000,
        }),
      id,
    );
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
    const padding = Buffer.alloc(4194304 - basic.reduce((n, b) => n + b.length, 0) - 12, 65);
    padding[1] = 0;
    await writeFile(
      root + "/maximum.png",
      Buffer.concat([...basic.slice(0, 3), chunk("tEXt", padding), basic[3]]),
    );
    const agentPadding = Buffer.alloc(524288 - basic.reduce((n, b) => n + b.length, 0) - 12, 65);
    agentPadding[1] = 0;
    await writeFile(
      root + "/agent-maximum.png",
      Buffer.concat([...basic.slice(0, 3), chunk("tEXt", agentPadding), basic[3]]),
    );
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, root + "/maximum.png");
    for (let i = 0; i < 4; i++)
      assert.ok(
        (await page.evaluate((id) => window.scope.review({ action: "attach", id }), id)).images
          ?.length ===
          i + 1,
      );
    await app.evaluate(async () => {
      const s = Reflect.get(globalThis, "scopeReviewSession"),
        tools = s.tools;
      for (let i = 0; i < 220; i++)
        s.add(
          i % 2 ? "assistant" : "user",
          "Retained synthetic context. " + "X".repeat(1800),
          "pressure-" + i,
        );
      const signal = new AbortController().signal;
      const entries = JSON.parse(
        (await tools.call("scope_evidence", { action: "list", id: "root" }, signal)).contentItems[0]
          .text,
      ).entries;
      const entry = entries.find((e: any) => e.path === "deleted.ts");
      const anchor = {
        id: entry.id,
        revision: entry.revision,
        path: entry.path,
        side: entry.side,
        line: 2,
        endLine: 4,
      };
      const images = JSON.parse(
        (await tools.call("scope_evidence", { action: "images", id: "root" }, signal))
          .contentItems[0].text,
      ).images;
      const outcome = await tools.call(
        "scope_guide",
        {
          action: "image",
          data: {
            image: images[0].id,
            revision: images[0].head,
            marks: Array.from({ length: 10 }, (_, mark) => ({
              kind: "stroke",
              points: Array.from({ length: mark === 9 ? 96 : 128 }, (_, i) => [i % 10, i % 10]),
              text: "",
            })),
          },
        },
        signal,
      );
      if (!outcome.success) throw Error(outcome.contentItems[0].text);
      for (let i = 1; i < 24; i++) {
        const r = await tools.call(
          "scope_guide",
          {
            action: "diagram",
            data: {
              nodes: Array.from({ length: 8 }, (_, j) => `${j} ` + "node ".repeat(40)),
              messages: Array.from({ length: 20 }, (_, j) => ({
                from: j % 8,
                to: (j + 1) % 8,
                text: "message ".repeat(20),
              })),
              sources: [anchor],
            },
          },
          signal,
        );
        if (!r.success) throw Error(r.contentItems[0].text);
      }
    });
    await page.locator("#review-feedback").click();
    await page.locator("#feedback-author").fill("A".repeat(32768));
    await page.locator("#feedback-agent").fill("B".repeat(32768));
    await page
      .locator("#feedback-dialog")
      .getByRole("button", { name: "Copy both", exact: true })
      .click();
    await expect(page.locator("#feedback-dialog")).toContainText("Both handoffs copied");
    report.retained = await app.evaluate(() => {
      const s = Reflect.get(globalThis, "scopeReviewSession");
      return {
        entries: s.read(0).total,
        transcriptBytes: s.bytes,
        artifacts: s.tools.guidance?.read?.().length,
      };
    });
  });
  await measure("03-active-capture-review-feedback", async () => {
    await page.locator("#feedback-dialog").getByRole("button", { name: "Close feedback" }).click();
    await page
      .locator("#conversation-input")
      .fill(
        live
          ? "Without tools, discuss eight distinct hypothetical failure cases in a comment-posting workflow in about 600 words. Keep every claim hypothetical."
          : "slow",
      );
    await page.locator("#conversation-send").click();
    await expect(page.locator("#conversation-state")).toContainText("running", { timeout: 120000 });
    await page.locator("#review-feedback").click();
    for (let i = 0; i < 12; i++) {
      await page
        .locator("#feedback-dialog")
        .getByRole("button", { name: "Copy both", exact: true })
        .click();
      await expect(page.locator("#feedback-dialog")).toContainText("Both handoffs copied");
      await wait(100);
    }
    const busy = await page.evaluate(async () => {
      const s = await window.scope.status();
      try {
        return await window.scope.analysisStart(
          s.generation,
          "synthetic-session-a",
          "test-success",
          "low",
          null,
        );
      } catch (error) {
        return String(error);
      }
    });
    assert.match(JSON.stringify(busy), /End review/);
    report.diagnosisBusy = true;
    await page.locator("#feedback-dialog").getByRole("button", { name: "Close feedback" }).click();
    await page.locator("#functions summary").click();
    await page.locator('[data-tool="journal"]').click();
    for (let i = 0; i < 12; i++) {
      await page.locator("#search").fill(i % 2 ? "synthetic" : "padding");
      await wait(200);
      await page.locator('[role="slider"]').press(i % 2 ? "Home" : "End");
    }
    report.capture = await page.evaluate(() => window.scope.status());
    await page.locator("#functions summary").click();
    await page.locator('[data-tool="review"]').click();
    await wait(3000);
    if (!live) await page.locator("#conversation-stop").click();
    await expect(page.locator("#conversation-state")).toContainText("ready", { timeout: 120000 });
  });
  await measure("04-max-posting-copy", async () => {
    await page.locator("#review-feedback").click();
    await page.locator("#feedback-author").fill("A".repeat(32000));
    await page.locator("#feedback-agent").fill("B".repeat(32000));
    await page
      .locator("#feedback-dialog")
      .getByRole("button", { name: "Post comment…", exact: true })
      .click();
    const editor = page.locator("#posting-body");
    await expect(editor).toBeEnabled();
    const body = await editor.inputValue();
    const maximum = "C".repeat(65536 - Buffer.byteLength(body)) + body;
    await editor.fill(maximum);
    for (let i = 0; i < 12; i++) {
      const started = performance.now();
      await page
        .locator("#posting-dialog")
        .getByRole("button", { name: "Copy exact preview" })
        .click();
      await expect(page.locator("#posting-dialog")).toContainText("Exact preview copied");
      report.copyResponseMs.push(performance.now() - started);
    }
    assert.equal(
      await app.evaluate(async ({ clipboard }) => Buffer.byteLength(await clipboard.readText())),
      65536,
    );
    await page
      .locator("#posting-dialog")
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(
      page.locator("#posting-dialog").getByRole("link", { name: "View posted comment" }),
    ).toBeVisible();
    report.maximumSyntheticCommentBytes = 65536;
    await editor.fill("界".repeat(65536));
    await expect(page.locator("#posting-dialog")).toContainText("exceeds 65,536");
    await page.locator("#posting-dialog").getByRole("button", { name: "Back to feedback" }).click();
    await page.locator("#feedback-dialog").getByRole("button", { name: "Close feedback" }).click();
  });
  if (!live)
    await measure("04b-image-omission", async () => {
      await page.locator("#conversation-input").fill("agent-image");
      await page.locator("#conversation-send").click();
      await expect(page.locator("#conversation-state")).toContainText("ready");
      const state = await page.evaluate(
        (id) => window.scope.conversation({ action: "read", review: id, offset: 256 }),
        id,
      );
      assert.ok(
        state!.entries.some((entry) => entry.text.includes("512 KiB")),
        "Visible agent image omission missing",
      );
      report.imageOmissionPreservedReview = true;
    });
  if (live)
    await measure("04b-live-image-source-tools", async () => {
      await app.evaluate(() => {
        const s = Reflect.get(globalThis, "scopeReviewSession"),
          original = s.tools.call.bind(s.tools);
        Reflect.set(globalThis, "integratedTools", []);
        s.tools.call = async (...args: any[]) => {
          const result = await original(...args);
          const records = Reflect.get(globalThis, "integratedTools");
          if (records.length < 8)
            records.push({
              action: args[1]?.action,
              success: result.success,
              imageChars:
                result.contentItems?.find((item: any) => item.type === "inputImage")?.imageUrl
                  ?.length ?? 0,
            });
          return result;
        };
      });
      await page
        .locator("#conversation-input")
        .fill(
          "Use scope_evidence to list root, then read the first small bounded page of deleted.ts using its issued source ID. State one source fact in one sentence. Do not call image or guidance tools yet.",
        );
      await page.locator("#conversation-send").click();
      await expect(page.locator("#conversation-state")).toContainText("running", {
        timeout: 120000,
      });
      await expect(page.locator("#conversation-state")).toContainText("ready", { timeout: 120000 });
      assert.ok(
        await app.evaluate(() =>
          Reflect.get(globalThis, "integratedTools").some(
            (call: any) => call.action === "read" && call.success,
          ),
        ),
        "Actual source transfer missing",
      );
      const images = await app.evaluate(() => {
        const session = Reflect.get(globalThis, "scopeReviewSession");
        return session.tools.review.toolImages(session.reviewId);
      });
      const thread = await app.evaluate(() => Reflect.get(globalThis, "scopeReviewSession").thread);
      await page
        .locator("#conversation-input")
        .fill(
          `Call scope_evidence action image with id ${images[0].id} exactly once. This is a deliberate size-limit test; report the tool omission honestly without another image request.`,
        );
      await page.locator("#conversation-send").click();
      await expect(page.locator("#conversation-state")).toContainText("running", {
        timeout: 120000,
      });
      await expect(page.locator("#conversation-state")).toContainText("ready", { timeout: 120000 });
      assert.ok(
        await app.evaluate(() =>
          Reflect.get(globalThis, "integratedTools").some(
            (call: any) => call.action === "image" && !call.success && call.imageChars === 0,
          ),
        ),
        "Oversize omission missing",
      );
      await page.evaluate(
        ({ id, image }) => window.scope.review({ action: "remove-image", id, image }),
        { id, image: images.at(-1).id },
      );
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, root + "/agent-maximum.png");
      const attached = await page.evaluate(
        (id) => window.scope.review({ action: "attach", id }),
        id,
      );
      const supported = attached.images!.at(-1)!;
      await page
        .locator("#conversation-input")
        .fill(
          `Call scope_evidence action image with id ${supported.id} exactly once, then describe what is visible in one sentence.`,
        );
      await page.locator("#conversation-send").click();
      await expect(page.locator("#conversation-state")).toContainText("running", {
        timeout: 120000,
      });
      await expect(page.locator("#conversation-state")).toContainText("ready", { timeout: 120000 });
      assert.equal(
        await app.evaluate(() => Reflect.get(globalThis, "scopeReviewSession").thread),
        thread,
      );
      report.sameThreadAfterImageOmission = true;
      report.liveTools = await app.evaluate(() => ({
        calls: Reflect.get(globalThis, "integratedTools"),
        status: Reflect.get(globalThis, "scopeReviewSession").read(256).status,
        error: Reflect.get(globalThis, "scopeReviewSession").read(256).error,
      }));
      assert.ok(
        report.liveTools.calls.some(
          (call: any) => call.action === "image" && call.success && call.imageChars > 699000,
        ),
        "Actual CLI did not consume the largest supported agent PNG",
      );
      if (report.liveTools.status === "ready")
        assert.ok(
          report.liveTools.calls.some((call: any) => call.action === "read" && call.success),
          "Actual CLI source round trip missing",
        );
      else assert.match(report.liveTools.error ?? "", /resource|storage|capacity|limit/);
    });
  await measure("05-minimized-capture", async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await wait(3000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  });
  await measure("06-visible-capacity-recovery", async () => {
    await app.evaluate(() => {
      const s = Reflect.get(globalThis, "scopeReviewSession");
      s.add("assistant", "X".repeat(524288), "overflow");
    });
    await expect(page.locator("#conversation-state")).toContainText(
      report.liveTools?.status === "failed" ? "failed" : "capacity",
    );
    await page.locator("#review-more").click();
    await page.getByRole("menuitem", { name: "End review", exact: true }).click();
    await page
      .locator("#feedback-dialog")
      .getByRole("button", { name: "End without copy" })
      .click();
    await expect(page.locator("#review-address")).toBeVisible();
    const generation = (await page.evaluate(() => window.scope.status())).generation;
    const diagnosis = await page.evaluate(
      (generation) =>
        window.scope.analysisStart(generation, "synthetic-session-a", "test-success", "low", null),
      generation,
    );
    assert.ok(diagnosis.activeRunId || diagnosis.runs.length);
    report.diagnosisAfterEnd = true;
    await page.evaluate((generation) => window.scope.analysisCancel(generation), generation);
  });
  clearInterval(incoming);
  incoming = undefined;
  await page.evaluate(() => window.scope.capture(false));
  await measure("07-settled-idle", () => wait(3000));
  assert.deepEqual(await readdir(root + "/review-session"), []);
  assert.deepEqual(await readdir(root + "/review"), []);
  assert.deepEqual(await readdir(root + "/comment"), []);
  report.cleaned = true;
  if (!visual) {
    for (const [name, phase] of Object.entries(report.phases) as [string, any][]) {
      assert.ok(
        phase.peakRssBytes <= 1152 * 1024 * 1024,
        `${name}: whole-app RSS exceeds 1152 MiB`,
      );
      assert.ok(
        phase.rendererDelayMs <= 100 && phase.mainDelayMs <= 100,
        `${name}: timer delay exceeds 100 ms`,
      );
      assert.ok(
        phase.meanCpuPercentOneCore <=
          (name.includes("idle") ? 8 : name.includes("minimized") ? 25 : 140),
        `${name}: mean CPU exceeds workload ceiling`,
      );
      assert.ok(
        phase.temporaryBytes <= 56 * 1024 * 1024,
        `${name}: temporary files exceed combined ceiling`,
      );
    }
    report.accepted = true;
  }

  await mkdir("measurements", { recursive: true });
  await writeFile(
    `measurements/review-integrated${live ? "-live" : ""}${visual ? "-visual" : ""}.json`,
    JSON.stringify(report, null, 2),
  );
} finally {
  clearInterval(incoming);
  await app.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
