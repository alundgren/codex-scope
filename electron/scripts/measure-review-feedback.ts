import { _electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { sample } from "./process-metrics.ts";
import { FEEDBACK_LIMITS, validateFindings, type ReviewFinding } from "../src/review-feedback.ts";
const root = await mkdtemp("/tmp/scope-feedback-measure-");
const app = await _electron.launch({
  args: [
    path.resolve("dist/app"),
    "--history-test",
    `--scope-test-root=${root}`,
    `--review-test-gh=${path.resolve("test/fixtures/review-gh.cjs")}`,
  ],
  env: process.env as Record<string, string>,
  chromiumSandbox: true,
});
const result: Record<string, unknown> = {
  environment:
    "Linux sandboxed Electron, actual installed Codex CLI with synthetic review discussion; synthetic maximum findings and drafts; no video or screenshots; capture stopped",
  selection: { model: "gpt-6-astra", effort: "low" },
};
const disk = async (dir: string): Promise<number> => {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    bytes += entry.isDirectory()
      ? await disk(file)
      : entry.isFile()
        ? (await stat(file).catch(() => ({ size: 0 }))).size
        : 0;
  }
  return bytes;
};
try {
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  const timer = () => {
    const metric = { last: performance.now(), max: 0 };
    setInterval(() => {
      const now = performance.now();
      metric.max = Math.max(metric.max, now - metric.last - 20);
      metric.last = now;
    }, 20);
    Reflect.set(globalThis, "feedbackTimer", metric);
  };
  await page.evaluate(timer);
  await app.evaluate(timer);
  const measure = async (name: string, work: () => Promise<void>) => {
    await page.evaluate(() => {
      Reflect.get(globalThis, "feedbackTimer").max = 0;
    });
    await app.evaluate(() => {
      Reflect.get(globalThis, "feedbackTimer").max = 0;
    });
    result[name] = await sample(app, 0, work);
    result[name + "Delay"] = {
      renderer: await page.evaluate(() => Reflect.get(globalThis, "feedbackTimer").max),
      main: await app.evaluate(() => Reflect.get(globalThis, "feedbackTimer").max),
    };
    result[name + "DiskBytes"] = await disk(root);
  };
  await page.evaluate(() =>
    window.scope.saveSettings({
      endpoint: "",
      token: "",
      diagnosis: { model: "gpt-6-astra", effort: "low" },
      review: { model: "gpt-6-astra", effort: "low" },
    }),
  );
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="review"]').click();
  await page.locator("#review-address").fill("example/shop #148");
  await page.getByRole("button", { name: "Open PR", exact: true }).click();
  await page.waitForSelector(".review-code-row");
  await page.locator("#review-chat-toggle").click();
  await page
    .locator("#conversation-input")
    .fill(
      "Discuss this synthetic unverified concern briefly without tools: invoice.ts head line 12 returns an invoice without checking account ownership. Middleware is unknown. An agent suggested checking ownership in the service. Verify using another account.",
    );
  await page.locator("#conversation-send").click();
  await page.waitForFunction(
    () => document.querySelector("#conversation-state")?.textContent?.includes("ready"),
    undefined,
    { timeout: 120000 },
  );
  const thread = await app.evaluate(() =>
    Reflect.get(Reflect.get(globalThis, "scopeReviewSession"), "thread"),
  );
  await page.locator("#review-feedback").click();
  const popup = page.locator("#feedback-dialog");
  await measure("generation", async () => {
    await popup.getByRole("button", { name: "Generate feedback", exact: true }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#feedback-dialog [role=status]")
          ?.textContent?.includes("Feedback prepared"),
      undefined,
      { timeout: 120000 },
    );
  });
  assert.equal(
    await app.evaluate(() => Reflect.get(Reflect.get(globalThis, "scopeReviewSession"), "thread")),
    thread,
  );
  result.sameThread = true;
  const f: ReviewFinding = {
    id: "F0",
    area: "correctness",
    impact: "high",
    description: "D".repeat(320),
    evidence: "E".repeat(768),
    reasoning: "R".repeat(512),
    uncertainty: "U".repeat(256),
    verification: "V".repeat(512),
    suggestion: "S".repeat(320),
    attribution: "agent",
    included: true,
    hypothesis: false,
    includeSuggestion: true,
  };
  const findings = Array.from({ length: 8 }, (_, i) => ({
    ...f,
    id: `F${i}`,
    evidence: "",
    reasoning: "",
    verification: "",
  }));
  for (const field of ["evidence", "reasoning", "verification"] as const)
    for (const item of findings) {
      while (
        item[field].length < f[field].length &&
        Buffer.byteLength(JSON.stringify({ findings })) < FEEDBACK_LIMITS.dataBytes
      )
        item[field] += "X";
    }
  validateFindings({ findings });
  result.findingsBytes = Buffer.byteLength(JSON.stringify({ findings }));
  result.findingCount = findings.length;
  await measure("maximumFindings", async () => {
    await popup.getByRole("button", { name: "Close feedback" }).click();
    await app.evaluate(({ ipcMain }, findings) => {
      const original = Reflect.get(ipcMain, "_invokeHandlers").get("scope:conversation");
      ipcMain.removeHandler("scope:conversation");
      ipcMain.handle("scope:conversation", (event, request) => {
        if (request.action !== "feedback") return original(event, request);
        ipcMain.removeHandler("scope:conversation");
        ipcMain.handle("scope:conversation", original);
        const session = Reflect.get(globalThis, "scopeReviewSession");
        const prior = Reflect.get(session, "feedback");
        Reflect.set(session, "feedback", { sequence: prior.sequence + 1, findings, error: null });
        return session.read(256);
      });
    }, findings);
    await page.locator("#review-feedback").click();
    await popup.getByRole("button", { name: "Generate feedback", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".feedback-findings details").length === 8,
    );
    for (let i = 0; i < 12; i++) {
      await popup.getByRole("button", { name: "Copy both", exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector("#feedback-dialog [role=status]")?.textContent?.includes("copied"),
      );
    }
  });
  await measure("maximumDrafts", async () => {
    await page.locator("#feedback-author").fill("A".repeat(FEEDBACK_LIMITS.draftBytes));
    await page.locator("#feedback-agent").fill("B".repeat(FEEDBACK_LIMITS.draftBytes));
    for (let i = 0; i < 12; i++) {
      await popup.getByRole("button", { name: "Copy both", exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector("#feedback-dialog [role=status]")?.textContent?.includes("copied"),
      );
    }
    result.clipboardBytes = await app.evaluate(async ({ clipboard }) =>
      Buffer.byteLength(await clipboard.readText()),
    );
  });
  await measure("multibyteReject", async () => {
    await page.locator("#feedback-author").fill("界".repeat(FEEDBACK_LIMITS.draftBytes));
    await page.locator("#feedback-agent").fill("界".repeat(FEEDBACK_LIMITS.draftBytes));
    await popup.getByRole("button", { name: "Copy both", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#feedback-dialog [role=status]")?.textContent?.includes("byte limit"),
    );
  });
  await popup.getByRole("button", { name: "Close feedback" }).click();
  await page.locator("#review-more").click();
  await page.getByRole("menuitem", { name: "End review", exact: true }).click();
  await popup.getByRole("button", { name: "End without copy" }).click();
  await page.waitForSelector("#review-address", { state: "visible" });
  assert.deepEqual(await readdir(path.join(root, "review-session")), []);
  result.cleaned = true;
  await mkdir("measurements", { recursive: true });
  await writeFile("measurements/review-feedback.json", JSON.stringify(result, null, 2));
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
