import { test, expect, _electron, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { append, frame } from "./navigation-helpers.ts";
async function setup(info: TestInfo, root?: string, missing = false) {
  root ??= await mkdtemp("/tmp/scope-model-ui-");
  const control = path.join(root, "catalog-mode");
  await writeFile(control, "success");
  const log = path.join(root, "catalog-requests");
  const app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      "--fixtures-only",
      `--scope-test-root=${root}`,
      `--catalog-test-cli=${missing ? "/missing/catalog-cli" : path.resolve("test/fixtures/catalog-cli.cjs")}`,
      `--analysis-test-cli=${path.resolve("test/fixtures/analysis-view-cli.cjs")}`,
    ],
    env: { ...process.env, SCOPE_CATALOG_FIXTURE_CONTROL: control, SCOPE_CATALOG_FIXTURE_LOG: log },
    chromiumSandbox: true,
    recordVideo: { dir: info.outputPath("video"), size: { width: 1180, height: 760 } },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-ready="true"]');
  return { root, control, log, app, page };
}
async function tool(page: Page, name: string) {
  await page.locator("#functions summary").click();
  await page.locator(`[data-tool="${name}"]`).click();
}
async function refresh(page: Page, expected = "10 models") {
  await page.locator("#model-refresh").click();
  await expect(page.locator("#model-status")).toContainText(expected);
}
async function pair(page: Page, role: string, model: string, effort: string) {
  await page.locator(`#${role}-model`).selectOption(model);
  await expect(page.locator("#model-refresh")).toBeEnabled();
  await page.locator(`#${role}-effort`).selectOption(effort);
}

test("empty selectors, hidden catalog, explicit persistence and stale invocation recovery", async ({}, info) => {
  let f = await setup(info);
  try {
    await tool(f.page, "settings");
    for (const id of ["analysis-model", "analysis-effort"])
      await expect(f.page.locator(`#${id}`)).toHaveValue("");
    await expect
      .poll(async () => {
        try {
          return await readFile(f.log, "utf8");
        } catch {
          return "";
        }
      })
      .toBe("");
    await f.page.screenshot({ path: info.outputPath("01-empty.png") });
    await f.page.locator("#analysis-model").focus();
    await expect(f.page.locator("#model-status")).toContainText("10 models");
    await expect(f.page.locator('#analysis-model option[value="hidden-model"]')).toContainText(
      "hidden",
    );
    await pair(f.page, "analysis", "hidden-model", "low");
    await f.page.locator("#settings-save").click();
    await expect(f.page.locator("#settings-status")).toHaveText("Settings saved.");
    await f.page.screenshot({ path: info.outputPath("02-explicit-hidden.png") });
    const root = f.root;
    await f.app.close();
    f = await setup(info, root);
    await tool(f.page, "settings");
    await expect(f.page.locator("#analysis-model")).toHaveValue("hidden-model");
    await expect(f.page.locator("#analysis-effort")).toHaveValue("low");
    await refresh(f.page);
    await f.page.screenshot({ path: info.outputPath("03-persisted.png") });
    const event = frame({ index: 130 });
    const input = JSON.parse(event.payload);
    input.session_id = "catalog-session";
    input.hook_event_name = "PostToolUse";
    input.tool_name = "exec_command";
    input.tool_input = { cmd: "rg synthetic src" };
    input.tool_response = "synthetic result";
    event.session_id = input.session_id;
    event.hook_type = input.hook_event_name;
    event.tool_name = input.tool_name;
    event.payload = JSON.stringify(input);
    event.payload_bytes = Buffer.byteLength(event.payload);
    await append(f.app, [event]);
    await writeFile(f.control, "stale");
    await tool(f.page, "analysis");
    await expect(
      f.page.locator("#analysis-session option").filter({ hasText: "catalog-session" }),
    ).toHaveCount(1);
    await f.page.locator("#analysis-session").selectOption(JSON.stringify("catalog-session"));
    await f.page.locator("#analysis-start").click();
    await expect(f.page.locator("#analysis-status")).toContainText("unavailable");
    await expect(f.page.locator("#analysis-session")).toHaveValue(
      JSON.stringify("catalog-session"),
    );
    await f.page.screenshot({ path: info.outputPath("04-stale-invocation.png") });
    await tool(f.page, "settings");
    await refresh(f.page, "unavailable");
    await expect(f.page.locator("#analysis-model option:checked")).toContainText("unavailable");
    await f.page.screenshot({ path: info.outputPath("05-stale-selection.png") });
    await writeFile(f.control, "success");
    await refresh(f.page);
    await tool(f.page, "analysis");
    await f.page.locator("#analysis-start").click();
    await expect(f.page.locator("#analysis-run option").last()).toContainText("completed");
    await f.page.screenshot({ path: info.outputPath("06-recovered.png") });
    const requests = (await readFile(f.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.every((request) =>
        ["initialize", "initialized", "model/list"].includes(request.method),
      ),
    ).toBe(true);
    expect(await readdir(path.join(f.root, "catalog"))).toEqual([]);
  } finally {
    await f.app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("catalog errors and cancellation keep Settings drafts and allow explicit retry", async ({}, info) => {
  const f = await setup(info);
  try {
    await tool(f.page, "settings");
    await f.page.locator("#collector-url").fill("https://draft.example");
    await f.page.locator("#collector-token").fill("synthetic-private-draft");
    for (const [mode, expected] of [
      ["auth", "authentication"],
      ["loop", "incomplete"],
      ["empty", "no models"],
    ]) {
      await writeFile(f.control, mode);
      await refresh(f.page, expected);
      await expect(f.page.locator("#collector-url")).toHaveValue("https://draft.example");
      await expect(f.page.locator("#collector-token")).toHaveValue("synthetic-private-draft");
      await f.page.screenshot({ path: info.outputPath(`${mode}.png`) });
    }
    await writeFile(f.control, "slow");
    await f.page.locator("#model-refresh").click();
    await expect(f.page.locator("#model-cancel")).toBeVisible();
    await f.page.locator("#model-cancel").click();
    await expect(f.page.locator("#model-status")).toContainText("cancelled");
    await expect(f.page.locator("#model-refresh")).toBeEnabled();
    await f.page.screenshot({ path: info.outputPath("cancelled.png") });
    await writeFile(f.control, "success");
    await refresh(f.page);
    await pair(f.page, "analysis", "gpt-5.6-luna", "low");
    await f.page.setViewportSize({ width: 390, height: 700 });
    await f.page.screenshot({ path: info.outputPath("narrow.png") });
    await f.page.locator("#settings-save").scrollIntoViewIfNeeded();
    await f.page.screenshot({ path: info.outputPath("narrow-settings.png") });
  } finally {
    await f.app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("missing CLI leaves both choices empty and retains connection input", async ({}, info) => {
  const f = await setup(info, undefined, true);
  try {
    await tool(f.page, "settings");
    await f.page.locator("#collector-url").fill("https://draft.example");
    await refresh(f.page, "not found");
    await expect(f.page.locator("#analysis-model")).toHaveValue("");
    await f.page.screenshot({ path: info.outputPath("missing-cli.png") });
  } finally {
    await f.app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("maximum catalog remains usable with long identifiers and supported efforts at narrow widths", async ({}, info) => {
  const f = await setup(info);
  try {
    await writeFile(f.control, "maximum");
    await tool(f.page, "settings");
    await refresh(f.page, "256 models.");
    await expect(f.page.locator("#analysis-model option")).toHaveCount(257);
    await pair(f.page, "analysis", `model-255-${"x".repeat(110)}`, "effort-31");
    await expect(f.page.locator("#analysis-effort option")).toHaveCount(33);
    await f.page.screenshot({ path: info.outputPath("maximum-desktop.png") });
    await f.page.locator("#analysis-model").click();
    await expect(f.page.locator("#model-refresh")).toBeEnabled();
    await f.page.screenshot({ path: info.outputPath("maximum-picker.png") });
    await f.page.locator("#analysis-model").press("Home");
    await f.page.locator("#analysis-model").press("ArrowDown");
    await f.page.locator("#analysis-model").press("Enter");
    await expect(f.page.locator("#analysis-model")).toHaveValue(`model-0-${"x".repeat(110)}`);
    await expect(f.page.locator("#model-refresh")).toBeEnabled();
    await f.page.locator("#analysis-effort").selectOption("effort-0");
    await f.page.setViewportSize({ width: 390, height: 700 });
    await pair(f.page, "analysis", `model-254-${"x".repeat(110)}`, "effort-30");
    await f.page.locator("#settings-save").scrollIntoViewIfNeeded();
    await f.page.screenshot({ path: info.outputPath("maximum-narrow.png") });
  } finally {
    await f.app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
