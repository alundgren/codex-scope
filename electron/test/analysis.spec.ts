import { test, expect, _electron, type TestInfo, type Page } from "@playwright/test";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fakeCollector, fixtureHello, until } from "./fake-collector.ts";
import { append, capture, state, source, frame, fault } from "./navigation-helpers.ts";

async function launch(info: TestInfo, missing = false) {
  const root = await mkdtemp("/tmp/scope-analysis-ui-");
  const app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      "--fixtures-only",
      `--scope-test-root=${root}`,
      `--analysis-test-cli=${missing ? "/missing/synthetic-codex" : path.resolve("test/fixtures/analysis-view-cli.cjs")}`,
    ],
    chromiumSandbox: true,
    recordVideo: { dir: info.outputPath("video"), size: { width: 1180, height: 820 } },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  return { app, page, root };
}
function calls(session = "analysis-session") {
  return Array.from({ length: 12 }, (_, index) => {
    const command =
      index === 0
        ? 'rg -n "timeout" .'
        : index === 1
          ? "cat src/inventory/*.ts"
          : index === 2
            ? 'rg -n "fetchInventory" src/inventory'
            : `rg -n "request${index}" src/network`;
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: session,
      tool_name: "exec_command",
      tool_input: { cmd: command },
      ...(index === 3 ? {} : { model: index < 2 ? "main-model-reported" : "gpt-5.6-luna" }),
      agent_id: index < 2 ? "agent-a" : "agent-b",
      tool_response:
        index === 3
          ? { unsupported: true }
          : "Synthetic response line.\n".repeat(index === 0 ? 850 : index === 1 ? 500 : 30),
      cwd: "/workspace/inventory",
    });
    return {
      type: "event",
      hook_type: "PostToolUse",
      session_id: session,
      tool_name: "exec_command",
      received_at: new Date(Date.UTC(2026, 8, 12, 14, 0, index)).toISOString(),
      payload,
      payload_bytes: Buffer.byteLength(payload),
    };
  });
}
async function openSession(page: Page, session = "analysis-session") {
  await page.locator("#functions summary").click();
  await page.locator("#open-analysis").click();
  await expect(
    page.locator(`#analysis-session option[value='${JSON.stringify(session)}']`),
  ).toHaveCount(1);
  await page.locator("#analysis-session").selectOption(JSON.stringify(session));
}
async function selectModel(page: Page, model: string) {
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="settings"]').click();
  await page.locator("#analysis-model").fill(model);
  await page.locator("#functions summary").click();
  await page.locator("#open-analysis").click();
}
async function analyze(page: Page, model = "gpt-5.6-luna") {
  await selectModel(page, model);
  await page.locator("#analysis-start").click();
  await expect(page.locator("#analysis-run option").last()).toContainText("completed");
}
const tab = (page: Page, view: string) => page.locator(`[data-analysis-view="${view}"]`);

test("one session keeps call focus, per-view filters, decisions and journal position", async ({}, info) => {
  const { app, page, root } = await launch(info);
  try {
    await append(app, calls());
    await page.locator(".event").first().click();
    const journalSelection = await page.locator("#payload").getAttribute("data-event");
    await page.locator("#capture").click();
    await expect(page.locator(".connection")).toHaveText("Stopped");
    await openSession(page);
    await expect(page.locator("#analysis-start")).toBeEnabled();
    await capture(page, info, "01-model-choice");
    await analyze(page);
    await expect(page.locator(".analysis-call")).toHaveCount(12);
    await page.locator(".analysis-call").first().click();
    const focused = await page
      .locator('.analysis-call[aria-pressed="true"]')
      .getAttribute("data-call");
    await page.getByRole("button", { name: "Load original payload", exact: true }).click();
    await expect(page.locator(".analysis-payload")).toContainText('"tool_response"');
    await page.locator("#analysis-detail").evaluate((element) => {
      element.scrollTop = 350;
    });
    const payloadOffset = await page
      .locator("#analysis-detail")
      .evaluate((element) => element.scrollTop);
    await append(app, [frame({ session: "quiet-arrival" })]);
    await expect
      .poll(() => page.locator("#analysis-detail").evaluate((element) => element.scrollTop))
      .toBe(payloadOffset);
    await capture(page, info, "02-results-original");
    await page.locator("#analysis-search").fill("no such command");
    await expect(page.locator("#analysis-content")).toContainText("No matching calls");
    await expect(page.getByRole("button", { name: "Show selected call" })).toBeVisible();
    await capture(page, info, "03-filtered-focus");
    await tab(page, "trail").click();
    await expect(page.locator("#analysis-search")).toHaveValue("");
    await expect(page.locator(`.analysis-call[data-call="${focused}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect
      .poll(() => page.locator("#analysis-detail").evaluate((element) => element.scrollTop))
      .toBe(payloadOffset);
    await capture(page, info, "04-search-trail");
    await tab(page, "routing").click();
    await expect(page.locator(".analysis-model-group")).toHaveCount(3);
    await expect(page.locator("#analysis-content")).toContainText(
      "does not establish parent/scout relationships",
    );
    await capture(page, info, "05-agent-routing");
    await tab(page, "recommendations").click();
    await expect(page.locator(".analysis-finding.focused")).toHaveCount(1);
    await page.getByRole("button", { name: "Keep suggestion", exact: true }).first().click();
    await expect(page.locator(".analysis-decision").first()).toContainText("Kept for handoff");
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(page.locator(".analysis-decision").last()).toContainText("Dismissed");
    await page.locator(".analysis-decision").last().getByRole("button", { name: "Undo" }).click();
    await expect(
      page.locator(".analysis-decision").last().getByRole("button", { name: "Keep suggestion" }),
    ).toBeVisible();
    await page
      .locator(".analysis-finding.focused")
      .evaluate((node) => node.scrollIntoView({ block: "nearest" }));
    await capture(page, info, "06-recommendations");
    const controls = await page.locator(".analysis-workspace").boundingBox();
    expect(controls!.y).toBeLessThan(300);
    await page.locator("#analysis-export").click();
    await expect(page.locator("#analysis-status")).toContainText("Preparing a handoff");
    await capture(page, info, "06c-preparing-handoff");
    await expect(page.locator("#analysis-status")).toHaveText(
      "Handoff copied. Paste it into the source session.",
    );
    const exported = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(exported).toContain("Session analysis handoff for analysis-session");
    expect(exported).toContain("Try a narrower discovery query");
    await capture(page, info, "06d-copied-handoff");
    expect(exported).not.toContain("Consider a scout before reading many files");
    await tab(page, "results").click();
    await expect(page.locator("#analysis-search")).toHaveValue("no such command");
    await page.getByRole("button", { name: "Show selected call" }).click();
    await expect(page.locator("#analysis-search")).toHaveValue("");
    await page.locator("#analysis-group").selectOption("main-model-reported");
    await expect(page.locator(".analysis-call")).toHaveCount(2);
    await tab(page, "trail").click();
    await expect(page.locator("#analysis-group")).toHaveValue("");
    await page.locator("#analysis-group").selectOption("gpt-5.6-luna");
    await expect(page.locator(".analysis-call")).toHaveCount(9);
    for (let iteration = 0; iteration < 2; iteration++) {
      await tab(page, "results").click();
      await expect(page.locator("#analysis-group")).toHaveValue("main-model-reported");
      await expect(page.locator(".analysis-call")).toHaveCount(2);
      await tab(page, "trail").click();
      await expect(page.locator("#analysis-group")).toHaveValue("gpt-5.6-luna");
      await expect(page.locator(".analysis-call")).toHaveCount(9);
    }
    await capture(page, info, "06b-independent-model-filters");
    await tab(page, "results").click();
    const runs = await page.evaluate(async () => {
      const value = await window.scope.status();
      return window.scope.analysisList(value.generation);
    });
    expect(runs.runs).toHaveLength(1);
    await page.locator("#functions summary").click();
    await page.locator('[data-tool="journal"]').click();
    await expect(page.locator("#payload")).toHaveAttribute("data-event", journalSelection!);
    await page.locator("#functions summary").click();
    await page.locator("#open-analysis").click();
    await expect(page.locator(`.analysis-call[data-call="${focused}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 860));
    await capture(page, info, "07-narrow-results");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await tab(page, "recommendations").click();
    await page
      .locator(".analysis-finding.focused")
      .evaluate((node) => node.scrollIntoView({ block: "nearest" }));
    await capture(page, info, "08-narrow-recommendations");
    await page.locator("#analysis-settings-toggle").click();
    await expect(page.locator("#analysis-session")).toBeVisible();
    await capture(page, info, "08b-narrow-model-controls");
    await page.locator("#analysis-settings-toggle").click();
    await expect(page.locator("#analysis-session")).not.toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("model comparison preserves the old run and snapshot with failure, cancel and recovery", async ({}, info) => {
  const { app, page, root } = await launch(info);
  try {
    await append(app, calls());
    await openSession(page);
    await analyze(page);
    const firstRun = await page.locator("#analysis-run").inputValue();
    await page.locator(".analysis-call").first().click();
    const originalFocus = await page
      .locator('.analysis-call[aria-pressed="true"]')
      .getAttribute("data-call");
    await selectModel(page, "test-slow");
    await page.locator("#analysis-start").click();
    await expect(page.locator("#analysis-status")).toContainText("Your selected run remains open");
    await expect(page.locator("#analysis-run")).toHaveValue(firstRun);
    await expect(page.locator(`.analysis-call[data-call="${originalFocus}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await capture(page, info, "09-running-preserves-run");
    await page.locator("#analysis-cancel").click();
    await expect(
      page.locator("#analysis-run option").filter({ hasText: "test-slow" }),
    ).toContainText("cancelled");
    const cancelled = await page
      .locator("#analysis-run option")
      .filter({ hasText: "test-slow" })
      .getAttribute("value");
    await page.locator("#analysis-run").selectOption(cancelled!);
    await expect(page.locator("#analysis-status")).toContainText("cancelled");
    await capture(page, info, "10-cancelled");
    await selectModel(page, "test-fail");
    await page.locator("#analysis-start").click();
    await expect(
      page.locator("#analysis-run option").filter({ hasText: "test-fail" }),
    ).toContainText("failed");
    const failed = await page
      .locator("#analysis-run option")
      .filter({ hasText: "test-fail" })
      .getAttribute("value");
    await page.locator("#analysis-run").selectOption(failed!);
    await expect(page.locator("#analysis-status")).not.toBeEmpty();
    await capture(page, info, "11-failed");
    await append(app, calls("another-session"));
    await append(app, calls().slice(0, 1));
    await page.locator("#analysis-run").selectOption(firstRun);
    await selectModel(page, "test-success");
    await page.locator("#analysis-start").click();
    await expect(
      page.locator("#analysis-run option").filter({ hasText: "test-success" }),
    ).toContainText("completed");
    const successful = await page
      .locator("#analysis-run option")
      .filter({ hasText: "test-success" })
      .getAttribute("value");
    await page.locator("#analysis-run").selectOption(successful!);
    await expect(page.locator(".analysis-call")).toHaveCount(12);
    await page.locator("#analysis-fresh").check();
    await selectModel(page, "test-fresh");
    await page.locator("#analysis-start").click();
    await expect(
      page.locator("#analysis-run option").filter({ hasText: "test-fresh" }),
    ).toContainText("completed");
    const freshRun = await page
      .locator("#analysis-run option")
      .filter({ hasText: "test-fresh" })
      .getAttribute("value");
    await page.locator("#analysis-run").selectOption(freshRun!);
    await expect(page.locator(".analysis-call")).toHaveCount(13);
    await expect(page.locator("#analysis-run option")).toHaveCount(4);
    await capture(page, info, "12-fresh-snapshot-recovery");
    await page.locator("#analysis-session").dispatchEvent("pointerdown");
    await expect(
      page.locator(`#analysis-session option[value='${JSON.stringify("another-session")}']`),
    ).toHaveCount(1);
    await page.locator("#analysis-session").selectOption(JSON.stringify("another-session"));
    await expect(page.locator("#analysis-run")).toContainText("No analysis yet");
    await expect(page.locator("#analysis-content")).not.toContainText("rg -n");
    const current = await state(app);
    await page.evaluate(async (generation) => window.scope.clear(generation), current.generation);
    await expect(page.locator("#analysis-run")).toContainText("No analysis yet");
    await expect(page.locator("#analysis-session")).toHaveValue("");
    await capture(page, info, "13-cleared");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing CLI gives a visible recoverable failure without losing evidence", async ({}, info) => {
  const { app, page, root } = await launch(info, true);
  try {
    await append(app, calls().slice(0, 4));
    await openSession(page);
    await page.locator("#analysis-start").click();
    await expect(page.locator("#analysis-run option")).toContainText("failed");
    await expect(page.locator("#analysis-status")).toContainText(/Codex|CLI|start|installed/);
    await expect(page.locator("#analysis-start")).toBeEnabled();
    await expect(page.locator(".analysis-call")).toHaveCount(4);
    await page.locator(".analysis-call").last().click();
    await expect(page.locator("#analysis-detail")).toContainText("Response size unknown");
    await page.locator("#analysis-coverage summary").click();
    await capture(page, info, "14-missing-cli-and-unknown-evidence");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("session choices stay bounded and eviction never substitutes another payload", async ({}, info) => {
  const { app, page, root } = await launch(info);
  try {
    await append(app, calls().slice(0, 4));
    await append(
      app,
      Array.from({ length: 70 }, (_, index) =>
        frame({ session: `paged-session-${String(index).padStart(3, "0")}` }),
      ),
    );
    await openSession(page);
    await analyze(page);
    await page.locator(".analysis-call").first().click();
    const focused = await page
      .locator('.analysis-call[aria-pressed="true"]')
      .getAttribute("data-call");
    await page.getByRole("button", { name: "Load original payload", exact: true }).click();
    await expect(page.locator(".analysis-payload")).toContainText('"tool_response"');
    await page.locator("#analysis-session").selectOption("@next");
    await expect(page.locator('#analysis-session option[value="@previous"]')).toHaveCount(1);
    const secondPage = await page.locator("#analysis-session option").allTextContents();
    expect(secondPage.length).toBeLessThanOrEqual(36);
    await page.locator("#analysis-session").dispatchEvent("pointerdown");
    await expect
      .poll(() => page.locator("#analysis-session option").allTextContents())
      .toEqual(secondPage);
    await expect(page.locator("#analysis-session")).toHaveValue(JSON.stringify("analysis-session"));
    await capture(page, info, "15-paged-session-selection");
    await append(
      app,
      Array.from({ length: 160 }, () => ({ ...source[4] })),
      40,
    );
    await expect(page.locator("#analysis-detail")).toContainText("original event has been evicted");
    await expect(page.locator(".analysis-payload")).not.toContainText('"tool_response"');
    await expect(
      page.getByRole("button", { name: "Load original payload", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(`.analysis-call[data-call="${focused}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await capture(page, info, "16-original-evicted");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe analysis storage preserves evidence and recovers after cleanup", async ({}, info) => {
  const { app, page, root } = await launch(info);
  try {
    await append(app, calls().slice(0, 4));
    await openSession(page);
    const storage = path.join(root, "analysis");
    await mkdir(storage, { mode: 0o700 });
    const unexpected = path.join(storage, "unexpected.txt");
    await writeFile(unexpected, "synthetic file to preserve");
    await page.locator("#analysis-start").click();
    await expect(page.locator("#analysis-run option")).toContainText("failed");
    await expect(page.locator("#analysis-status")).toContainText("could not be safely reused");
    await expect(page.locator(".analysis-call")).toHaveCount(4);
    expect(await readFile(unexpected, "utf8")).toBe("synthetic file to preserve");
    await capture(page, info, "17-analysis-storage-blocked");
    await rm(unexpected);
    await analyze(page);
    await expect(page.locator("#analysis-run option:checked")).toContainText("completed");
    await expect(page.locator("#analysis-status")).toBeEmpty();
    await expect(page.locator(".analysis-call")).toHaveCount(4);
    await capture(page, info, "18-analysis-storage-recovered");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("expanded narrow analysis contains long payloads above the footer during failure", async ({}, info) => {
  const { app, page, root } = await launch(info);
  try {
    await append(app, calls().slice(0, 4));
    await openSession(page);
    await selectModel(page, "test-fail");
    await page.locator("#analysis-start").click();
    await expect(page.locator("#analysis-run option:checked")).toContainText("failed");
    await page.locator(".analysis-call").first().click();
    await page.getByRole("button", { name: "Load original payload", exact: true }).click();
    await expect(page.locator(".analysis-payload")).toContainText('"tool_response"');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 860));
    await page.locator("#analysis-settings-toggle").click();
    await expect(page.locator("#analysis-session")).toBeVisible();
    await expect(page.locator("#analysis-status")).not.toBeEmpty();
    await page.locator("#analysis-detail").evaluate((element) => {
      element.scrollTop = 350;
    });
    const layout = await page.evaluate(() => {
      const footer = document.querySelector("footer")!.getBoundingClientRect();
      const detail = document.querySelector("#analysis-detail")!.getBoundingClientRect();
      const content = document.querySelector("#analysis-content")!.getBoundingClientRect();
      return {
        footerTop: footer.top,
        footerBottom: footer.bottom,
        detailBottom: detail.bottom,
        contentBottom: content.bottom,
        viewport: innerHeight,
        footerOwnsPoint: !!document.elementFromPoint(200, footer.top + 10)?.closest("footer"),
      };
    });
    expect(layout.detailBottom).toBeLessThanOrEqual(layout.footerTop);
    expect(layout.contentBottom).toBeLessThanOrEqual(layout.footerTop);
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.viewport);
    expect(layout.footerOwnsPoint).toBe(true);
    await capture(page, info, "19-narrow-expanded-failure-long-payload");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(360, 640),
    );
    await page.locator("#analysis-controls-region").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const smallLayout = await page.evaluate(() => ({
      panel: document.querySelector("#analysis-detail")!.getBoundingClientRect().height,
      bottom: document.querySelector("#analysis-detail")!.getBoundingClientRect().bottom,
      footer: document.querySelector("footer")!.getBoundingClientRect().top,
    }));
    expect(smallLayout.panel).toBeGreaterThan(60);
    expect(smallLayout.bottom).toBeLessThanOrEqual(smallLayout.footer);
    await capture(page, info, "19b-minimum-expanded-failure-long-payload");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 860));
    await page.locator("#analysis-controls-region").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.locator("#analysis-settings-toggle").click();
    await capture(page, info, "20-narrow-collapsed-failure-long-payload");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("analysis coverage retains worker drops after storage recovery", async ({}, info) => {
  const { app, page, root } = await launch(info);
  try {
    await append(app, calls().slice(0, 4));
    await fault(app, { write: true });
    await append(app, [frame({ session: "storage-pressure" })]);
    await expect.poll(async () => (await state(app)).drops.storage).toBeGreaterThan(0);
    await fault(app, { write: false });
    await append(app, [frame({ session: "storage-recovered" })]);
    await expect(page.locator("#notice")).not.toContainText("Storage pressure");
    const recorded = await state(app);
    const expectedDrops =
      Object.values(recorded.drops).reduce((sum, count) => sum + count, 0) +
      (recorded.localDrops ?? 0) +
      (recorded.rateDrops ?? 0);
    await openSession(page);
    await analyze(page);
    const snapshot = await page.evaluate(async () => {
      const history = await window.scope.status();
      const list = await window.scope.analysisList(history.generation);
      return (await window.scope.analysisRun(history.generation, list.runs[0].id))!.snapshot;
    });
    expect(snapshot.localDrops).toBe(expectedDrops);
    await page.locator("#analysis-coverage summary").click();
    await expect(page.locator("#analysis-limits")).toContainText(
      `Recording-wide drops: ${expectedDrops} local`,
    );
    await capture(page, info, "21-worker-drop-after-recovery");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("narrow journal keeps connection transitions visible", async ({}, info) => {
  const server = await fakeCollector({ hello: false, health: false });
  const root = await mkdtemp("/tmp/scope-analysis-connection-");
  await writeFile(path.join(root, "token"), "synthetic-test-token", { mode: 0o600 });
  await writeFile(
    path.join(root, "connection.json"),
    JSON.stringify({ endpoint: server.endpoint, tokenFile: path.join(root, "token") }),
    { mode: 0o600 },
  );
  const app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      `--scope-test-root=${root}`,
      `--connection-config=${root}/connection.json`,
    ],
    chromiumSandbox: true,
    recordVideo: { dir: info.outputPath("video"), size: { width: 1180, height: 820 } },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('html[data-ready="true"]');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await page.locator("#capture").click();
    await expect(page.locator(".connection")).toHaveText("Connecting…");
    await expect(page.locator(".connection")).toBeVisible();
    await capture(page, info, "22-narrow-connecting");
    await until(() => server.state.stream);
    server.raw(
      JSON.stringify({ ...fixtureHello, connection_id: server.state.connectionId }) + "\n",
    );
    await expect(page.locator(".connection")).toHaveText("Connected");
    await expect(page.locator(".connection")).toBeVisible();
    await capture(page, info, "23-narrow-connected");
    server.state.status = 503;
    server.disconnect();
    await expect(page.locator(".connection")).toHaveText("Disconnected");
    await expect(page.locator(".connection")).toBeVisible();
    await capture(page, info, "24-narrow-disconnected");
    server.state.status = 200;
    await until(() => server.state.stream && !server.state.stream.destroyed);
    server.raw(
      JSON.stringify({ ...fixtureHello, connection_id: server.state.connectionId }) + "\n",
    );
    await expect(page.locator(".connection")).toHaveText("Connected");
    await expect(page.locator(".connection")).toBeVisible();
    await capture(page, info, "25-narrow-reconnected");
  } finally {
    await app.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff failure and cancellation preserve results and clipboard, then allow retry", async ({}, info) => {
  const { app, page, root } = await launch(info);
  try {
    await append(app, calls());
    await openSession(page);
    await analyze(page, "test-handoff-invalid");
    await tab(page, "recommendations").click();
    await page.getByRole("button", { name: "Keep suggestion", exact: true }).first().click();
    await app.evaluate(({ clipboard }) => clipboard.writeText("Existing clipboard"));
    await page.locator("#analysis-export").click();
    await expect(page.locator("#analysis-status")).toHaveText(
      "Codex returned an invalid handoff. Try again.",
    );
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("Existing clipboard");
    await capture(page, info, "handoff-invalid");
    await analyze(page, "test-handoff-slow");
    await page.locator("#analysis-run").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Keep suggestion", exact: true }).first().click();
    await page.locator("#analysis-export").click();
    await expect(page.locator("#analysis-start")).toBeDisabled();
    await expect(page.locator("#analysis-export")).toBeDisabled();
    await capture(page, info, "handoff-cancellable");
    await page.locator("#analysis-cancel").click();
    await expect(page.locator("#analysis-export")).toBeEnabled();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("Existing clipboard");
    await expect(page.locator(".analysis-finding")).toHaveCount(2);
    await capture(page, info, "handoff-cancelled");
    await analyze(page);
    await page.locator("#analysis-run").selectOption({ index: 2 });
    await page.getByRole("button", { name: "Keep suggestion", exact: true }).first().click();
    await page.locator("#analysis-export").click();
    await expect(page.locator("#analysis-status")).toContainText("Handoff copied");
    await capture(page, info, "handoff-recovered");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("clipboard failure and delayed completion remain bounded and recoverable", async ({}, info) => {
  const { app, page, root } = await launch(info);
  try {
    await append(app, calls());
    await openSession(page);
    await analyze(page);
    await tab(page, "recommendations").click();
    await page.getByRole("button", { name: "Keep suggestion", exact: true }).first().click();
    await app.evaluate(({ clipboard }) => clipboard.writeText("Existing clipboard"));
    await app.evaluate(({ clipboard }) => {
      const write = clipboard.writeText;
      clipboard.writeText = async () => {
        clipboard.writeText = write;
        throw new Error("Synthetic clipboard failure");
      };
    });
    await page.locator("#analysis-export").click();
    await expect(page.locator("#analysis-status")).toHaveText(
      "The handoff could not be copied. Try again.",
    );
    await capture(page, info, "clipboard-failed");
    await app.evaluate(({ clipboard }) => {
      const write = clipboard.writeText;
      clipboard.writeText = (text) =>
        new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            clipboard.writeText = write;
            write(text).then(resolve, reject);
          }, 4000);
        });
    });
    await page.locator("#analysis-export").click();
    await expect(page.locator("#analysis-status")).toHaveText(
      "The clipboard has not confirmed the copy. It may still finish.",
    );
    await page.locator("#analysis-export").click();
    await expect(page.locator("#analysis-status")).toHaveText(
      "A handoff is still being prepared or copied.",
    );
    await capture(page, info, "clipboard-pending");
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain("Session analysis handoff");
    await page.locator("#analysis-export").click();
    await expect(page.locator("#analysis-status")).toContainText("Handoff copied");
    await capture(page, info, "clipboard-recovered");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
