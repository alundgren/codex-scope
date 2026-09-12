import assert from "node:assert/strict";
import { test, expect } from "@playwright/test";
import {
  source,
  state,
  fault,
  launch,
  capture,
  frame,
  append,
  selected,
  expectSelected,
  search,
  touchDrag,
} from "./navigation-helpers.ts";

const sessionA = `same-visible-prefix-${"a".repeat(165)}-A`;
const sessionB = `same-visible-prefix-${"a".repeat(165)}-B`;
const hooks = ["PreToolUse", "PostToolUse", "Stop"];
const events = Array.from({ length: 18 }, (_, index) =>
  frame({
    index,
    session: index % 2 ? sessionB : sessionA,
    hook: hooks[index % 3],
    message: `Synthetic navigation ${index} ${"plain ".repeat(40)}`,
    tail: index === 0 ? "CAFÉ [a.*]%_ outside the preview" : `payload tail ${index}`,
  }),
);

test("recorded filters: literal full text, full session IDs, several hooks, held offsets, identical counters and reset", async ({}, info) => {
  const { app, page, video } = await launch(info);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.locator('button[data-event="3"]').click();
    await expectSelected(page, 3);
    await capture(page, info, "navigation-desktop");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await capture(page, info, "navigation-narrow");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1180, 760),
    );
    await append(app, events);
    await search(page, "café [a.*]%_");
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "1");
    await expectSelected(page, 6);
    await expect(page.locator("#oldest")).toHaveText("16:00:00");
    await expect(page.locator("#json")).toContainText("CAFÉ [a.*]%_");
    await expect(page.locator(".preview")).not.toContainText("[a.*]%_");
    await capture(page, info, "literal-outside-preview");
    await search(page, "2026-09-11T15:59:59");
    await expectSelected(page, 7);
    await capture(page, info, "metadata-search");
    await search(page, "^.*$");
    await expect(page.locator("#entries")).toContainText("No matching events");
    await expect(page.locator("#json")).toBeEmpty();
    await capture(page, info, "no-matches");
    await page.getByRole("button", { name: "Reset filters", exact: true }).click();
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "23");
    await page.locator("#session").focus();
    await expect(page.locator("#session option").filter({ hasText: sessionA })).toHaveCount(1);
    await page.locator("#session").selectOption(JSON.stringify(sessionA));
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "9");
    await page.locator("#hooks summary").click();
    await page.getByRole("checkbox", { name: "PreToolUse", exact: true }).check();
    await page.getByRole("checkbox", { name: "Stop", exact: true }).check();
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "6");
    await capture(page, info, "multiple-hooks");
    await page.locator("#hooks summary").click();
    await page.locator("#session").selectOption(JSON.stringify(sessionB));
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "6");
    await expect(page.locator("#json")).toContainText(sessionB);
    await expectSelected(page, 9);
    await capture(page, info, "full-session-identity");
    const heldRows = await page.locator("#entries").textContent();
    await append(app, [events[3], events[5], events[4], events[0]]);
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "2");
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "8");
    await expectSelected(page, 9);
    expect(await page.locator("#entries").textContent()).toBe(heldRows);
    await capture(page, info, "multiple-hook-arrivals");
    await page.locator("#session").selectOption("");
    await page.locator("#hooks summary").click();
    await page.getByRole("button", { name: "All hooks", exact: true }).click();
    await page.locator("#hooks summary").click();
    await search(page, "maximum accepted payload");
    await expectSelected(page, 4);
    await page.locator("#scrollbar").press("PageDown");
    const offset = await page.locator("#payload").evaluate((node) => node.scrollTop);
    expect(offset).toBeGreaterThan(0);
    await page.locator("#session").selectOption(JSON.stringify(source[4].session_id));
    await expectSelected(page, 4);
    await expect(page.locator("#notice")).not.toContainText("Searching…");
    expect(await page.locator("#payload").evaluate((node) => node.scrollTop)).toBe(offset);
    const rows = await page.locator("#entries").textContent();
    const text = await page.locator("#json").textContent();
    await append(app, [source[4], source[1], source[4], source[2], source[4]], 100);
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "3");
    await expectSelected(page, 4);
    expect(await page.locator("#entries").textContent()).toBe(rows);
    expect(await page.locator("#json").textContent()).toBe(text);
    expect(await page.locator("#payload").evaluate((node) => node.scrollTop)).toBe(offset);
    await capture(page, info, "held-filtered-arrivals");
    await page.locator("#scrubber").press("ArrowDown");
    await expect(page.locator("#payload")).not.toHaveAttribute("data-event", "4");
    await page.locator('.event[aria-pressed="true"]').click();
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "3");
    await page.locator("#live").click();
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "0");
    await expect(page.locator("#mode")).toHaveText("Live");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("filters-walkthrough.webm"));
  }
});

test("recorded scrubber: every input, newest history, frozen arrivals, eviction and pressure recovery", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await append(app, events);
    const slider = page.getByRole("slider", { name: /Scrub retained events/ });
    await expect(slider).toHaveAttribute("aria-valuemax", "23");
    await slider.press("Home");
    await expectSelected(page, 1);
    for (const [key, id] of [
      ["ArrowDown", 2],
      ["ArrowRight", 3],
      ["ArrowUp", 2],
      ["ArrowLeft", 1],
      ["PageDown", 6],
      ["PageUp", 1],
    ] as const) {
      await slider.press(key);
      await expectSelected(page, id);
    }
    await slider.press("End");
    await expect(page.locator("#mode")).toHaveText("Live");
    await slider.press("ArrowUp");
    await expectSelected(page, 23);
    await expect(page.locator("#mode")).toContainText("History");
    await capture(page, info, "newest-history");
    await slider.press("ArrowDown");
    await expect(page.locator("#mode")).toHaveText("Live");
    await page.locator("#entries").hover();
    await page.mouse.wheel(0, -120);
    await expectSelected(page, 23);
    await page.waitForTimeout(100);
    await page.mouse.wheel(0, -120);
    await expectSelected(page, 22);
    await page.waitForTimeout(100);
    await page.mouse.wheel(0, 120);
    await expectSelected(page, 23);
    let bounds = await slider.boundingBox();
    assert(bounds);
    assert(bounds, "The tested control must be visible.");
    await page.mouse.move(bounds.x + 22, bounds.y + bounds.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 22, bounds.y + bounds.height * 0.6, { steps: 12 });
    await expectSelected(page, 15);
    const frozen = await slider.getAttribute("aria-valuemax");
    await append(app, events.slice(0, 3));
    await expect(slider).toHaveAttribute("aria-valuemax", frozen!);
    await page.mouse.move(bounds.x + 22, bounds.y + bounds.height * 0.6);
    await expectSelected(page, 15);
    await page.screenshot({ path: info.outputPath("gesture-arrivals.png") });
    await page.mouse.up();
    await expect(slider).toHaveAttribute("aria-valuemax", "26");
    await expectSelected(page, 15);
    bounds = await slider.boundingBox();
    assert(bounds);
    await touchDrag(
      page,
      bounds.x + 22,
      bounds.y + bounds.height * 0.8,
      bounds.y + bounds.height * 0.1,
    );
    await expectSelected(page, 4);
    await touchDrag(
      page,
      bounds.x + 22,
      bounds.y + bounds.height * 0.1,
      bounds.y + bounds.height * 0.75,
    );
    await expectSelected(page, 21);
    await capture(page, info, "touch-scrub");
    await slider.press("End");
    await append(
      app,
      Array.from({ length: 130 }, () => source[4]),
      75,
    );
    bounds = await slider.boundingBox();
    assert(bounds);
    await page.mouse.move(bounds.x + 22, bounds.y + bounds.height * 0.3);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await append(
      app,
      Array.from({ length: 16 }, () => source[4]),
      75,
    );
    await expect(page.locator("#notice")).toContainText("drag was evicted");
    await page.mouse.up();
    await capture(page, info, "gesture-evicted");
    expect(await slider.locator(".tick").count()).toBeLessThanOrEqual(64);
    await slider.press("Home");
    const first = await selected(page);
    await append(
      app,
      Array.from({ length: 6 }, () => source[4]),
      75,
    );
    await expect(page.locator("#notice")).toContainText("selected event was evicted");
    await expect(page.locator("#payload")).not.toHaveAttribute("data-event", first!);
    await capture(page, info, "selection-evicted");
    await fault(app, { disk: true });
    await append(app, [source[4]], 80);
    await expect(page.locator("#notice")).toContainText("Storage pressure");
    await slider.press("End");
    await slider.press("ArrowUp");
    await capture(page, info, "pressure-navigation");
    await fault(app, { disk: false });
    await append(app, [source[4]], 80);
    await expect(page.locator("#notice")).not.toContainText("Storage pressure");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    await slider.press("Home");
    await slider.press("PageDown");
    await slider.press("End");
    bounds = await slider.boundingBox();
    assert(bounds);
    await touchDrag(
      page,
      bounds.x + 22,
      bounds.y + bounds.height * 0.9,
      bounds.y + bounds.height * 0.4,
    );
    await expect(page.locator("#mode")).toContainText("History");
    await capture(page, info, "narrow-scrub-recovery");
    expect(await page.locator(".event").count()).toBeLessThanOrEqual(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("scrubber-walkthrough.webm"));
  }
});

test("recorded delayed queries, cancellation, timeout, Clear generations and bounded option paging recover", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await append(app, events);
    await fault(app, { delay: 600 });
    await page.locator("#search").fill("retry");
    await page.waitForTimeout(230);
    await page.locator("#search").fill("stop");
    await page.waitForTimeout(230);
    await page.locator("#search").fill("café [a.*]%_");
    await expectSelected(page, 6);
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "1");
    await page.waitForTimeout(700);
    await expectSelected(page, 6);
    await capture(page, info, "rapid-final-query");
    await fault(app, { delay: 0, searchMs: 0 });
    await page.locator("#search").fill("missing");
    await expect(page.locator("#notice")).toContainText("Search timed out");
    await expect(page.locator("#search")).toBeEditable();
    await capture(page, info, "search-timeout");
    await fault(app, { searchMs: 250 });
    await page.locator("#notice").getByRole("button", { name: "Reset filters" }).click();
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "23");
    await capture(page, info, "search-recovered");
    await fault(app, { delay: 800 });
    await page.locator("#search").fill("retry");
    await page.waitForTimeout(230);
    await page.locator("#clear").click();
    await page.locator("#clear").click();
    await expect(page.locator("#json")).toBeEmpty();
    await page.waitForTimeout(1200);
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "0");
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "0");
    await expect(page.locator("#json")).toBeEmpty();
    await fault(app, { delay: 0 });
    await page.locator("#search").fill("");
    await append(
      app,
      Array.from({ length: 80 }, (_, index) =>
        frame({
          index,
          session: `paged-session-${String(index).padStart(3, "0")}`,
          hook: index % 2 ? "Stop" : "PreToolUse",
        }),
      ),
    );
    await page.locator("#session").focus();
    await expect(page.locator('#session option[value="@next"]')).toHaveCount(1);
    expect(await page.locator("#session option").count()).toBeLessThanOrEqual(35);
    await page.locator("#session").selectOption("@next");
    await expect(
      page.locator("#session option").filter({ hasText: "paged-session-063" }),
    ).toHaveCount(1);
    await page.locator("#session").selectOption("@next");
    await expect(
      page.locator("#session option").filter({ hasText: "paged-session-079" }),
    ).toHaveCount(1);
    await page.locator("#session").selectOption(JSON.stringify("paged-session-079"));
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "1");
    await expect(page.locator("#json")).toContainText("paged-session-079");
    await capture(page, info, "paged-session-recovery");
    await search(page, "future-literal");
    await expect(page.locator("#entries")).toContainText("No matching events");
    await append(app, [frame({ session: "paged-session-079", tail: "future-literal" })]);
    await expect(page.locator("#json")).toContainText("future-literal");
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "1");
    await capture(page, info, "first-new-match");
    const current = await state(app);
    expect(current.peakPending).toBeLessThanOrEqual(4);
    expect(current.queuedCount).toBe(0);
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("queries-walkthrough.webm"));
  }
});

test("recorded narrow failures: bounded long-ID choices, held filter offset, timeout, eviction and recovery", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(440, 820),
    );
    const longEvents = Array.from({ length: 24 }, (_, index) =>
      frame({
        index,
        session: `long-session-${String(index).padStart(3, "0")}-${"x".repeat(7000)}`,
        hook: "Stop",
        message: "narrow filter and recovery",
      }),
    );
    await append(app, longEvents, 40);
    await page.locator("#session").focus();
    await expect(page.locator('#session option[value="@next"]')).toHaveCount(1);
    const choices = await page.locator("#session option").evaluateAll((nodes) =>
      nodes
        .map((node) => node as HTMLOptionElement)
        .filter((node) => node.value && !node.value.startsWith("@"))
        .map((node) => JSON.parse(node.value)),
    );
    expect(choices.length).toBeLessThan(24);
    expect(Buffer.byteLength(choices.join(""))).toBeLessThanOrEqual(128 * 1024);
    await page.locator("#session").selectOption("@next");
    await expect(
      page.locator("#session option").filter({ hasText: "long-session-023-" }),
    ).toHaveCount(1);
    await page.locator("#session").selectOption(JSON.stringify(longEvents[23].session_id));
    await expect(page.locator("#count")).toHaveAttribute("data-matching", "1");
    await page.locator("#hooks summary").click();
    await page.getByRole("checkbox", { name: "Stop", exact: true }).check();
    await capture(page, info, "narrow-hook-filter");
    await page.locator("#hooks summary").click();
    await search(page, "narrow filter");
    await page.locator('.event[aria-pressed="true"]').click();
    await page.locator("#scrollbar").press("PageDown");
    const offset = await page.locator("#payload").evaluate((node) => node.scrollTop);
    const held = await selected(page);
    const rows = await page.locator("#entries").textContent();
    expect(offset).toBeGreaterThan(0);
    await append(app, [longEvents[23], longEvents[0], longEvents[23]], 40);
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "2");
    await expectSelected(page, Number(held));
    expect(await page.locator("#entries").textContent()).toBe(rows);
    expect(await page.locator("#payload").evaluate((node) => node.scrollTop)).toBe(offset);
    await capture(page, info, "narrow-held-filter");
    await fault(app, { searchMs: 0 });
    await page.locator("#search").fill("missing");
    await expect(page.locator("#notice")).toContainText("Search timed out");
    await capture(page, info, "narrow-timeout");
    await fault(app, { searchMs: 250 });
    await page.locator("#notice").getByRole("button", { name: "Reset filters" }).click();
    await expect(page.locator("#notice")).not.toContainText("Search timed out");
    await append(
      app,
      Array.from({ length: 150 }, () => source[4]),
      75,
    );
    await expect(page.locator("#notice")).toContainText("selected event was evicted");
    await capture(page, info, "narrow-eviction");
    await fault(app, { disk: true });
    await append(app, [source[4]], 80);
    await expect(page.locator("#notice")).toContainText("Storage pressure");
    await capture(page, info, "narrow-pressure");
    await fault(app, { disk: false });
    await append(app, [source[4]], 80);
    await page.locator("#scrubber").press("End");
    await page.locator("#scrubber").press("ArrowUp");
    await expect(page.locator("#notice")).not.toContainText("Storage pressure");
    await capture(page, info, "narrow-recovered");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("narrow-walkthrough.webm"));
  }
});

test("a late navigation reply cannot display a target evicted after its database query", async ({}, info) => {
  const { app, page, video } = await launch(info);
  try {
    await append(
      app,
      Array.from({ length: 135 }, () => source[4]),
      75,
    );
    await page.locator("#scrubber").press("End");
    await page.locator("#scrubber").press("ArrowUp");
    await expect(page.locator("#entries")).toHaveAttribute("aria-busy", "false");
    const held = await selected(page);
    await app.evaluate(() => {
      const history = globalThis.scopeHistory;
      const navigate = history.navigate.bind(history);
      history.navigate = async (...args) => {
        history.navigate = navigate;
        const result = await navigate(...args);
        globalThis.lateTargetReady = true;
        await new Promise<void>((resolve) => {
          globalThis.releaseLateTarget = resolve;
        });
        return result;
      };
    });
    await page.locator("#scrubber").press("Home");
    await expect.poll(() => app.evaluate(() => globalThis.lateTargetReady)).toBe(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 760),
    );
    await append(
      app,
      Array.from({ length: 6 }, () => source[4]),
      75,
    );
    const retained = await state(app);
    await app.evaluate(() => globalThis.releaseLateTarget());
    expect(Number(held)).toBeGreaterThan(retained.first!.id);
    await expect(page.locator("#notice")).toContainText("event was evicted");
    await expectSelected(page, retained.first!.id);
    await capture(page, info, "late-evicted-target");
    const shown = await page
      .locator(".event")
      .evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.event)));
    expect(shown.every((id) => id >= retained.first!.id)).toBe(true);
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("late-target-walkthrough.webm"));
  }
});

test("recorded failed moves restore displayed rank and viewing mode before arrow and Live recovery", async ({}, info) => {
  const { app, page, video } = await launch(info);
  const slider = page.locator("#scrubber");
  const settled = () => expect(page.locator("#entries")).toHaveAttribute("aria-busy", "false");
  try {
    await page.locator('button[data-event="5"]').click();
    await settled();
    await expectSelected(page, 5);
    await fault(app, { searchMs: 0 });
    await slider.press("Home");
    await settled();
    await expect(page.locator("#notice")).toContainText("Previous selection is still shown.");
    await expect(slider).toHaveAttribute("aria-valuenow", "4");
    await expectSelected(page, 5);
    await expect(page.locator("#mode")).toContainText("History");
    await capture(page, info, "failed-home-history");

    await fault(app, { searchMs: 250 });
    await slider.press("ArrowDown");
    await settled();
    await expect(page.locator("#mode")).toHaveText("Live");
    await expect(slider).toHaveAttribute("aria-valuenow", "5");
    await expectSelected(page, 5);
    await expect(page.locator("#notice")).not.toContainText("timed out");
    await fault(app, { searchMs: 0 });
    await slider.press("Home");
    await settled();
    await expect(page.locator("#notice")).toContainText("Search timed out");
    await expect(slider).toHaveAttribute("aria-valuenow", "5");
    await expect(page.locator("#mode")).toHaveText("Live");
    await expectSelected(page, 5);
    await capture(page, info, "failed-home-live");

    await fault(app, { searchMs: 250 });
    await slider.press("ArrowUp");
    await settled();
    await expectSelected(page, 5);
    await expect(slider).toHaveAttribute("aria-valuenow", "4");
    await expect(page.locator("#mode")).toContainText("History");
    await slider.press("Home");
    await settled();
    await expectSelected(page, 1);
    await append(app, [frame({ index: 1 }), frame({ index: 2 })]);
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "2");
    await fault(app, { searchMs: 0 });
    await slider.press("End");
    await settled();
    await expect(page.locator("#notice")).toContainText("Previous selection is still shown.");
    await expectSelected(page, 1);
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await expect(page.locator("#mode")).toContainText("History");
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "2");
    await capture(page, info, "failed-live-history");
    await fault(app, { searchMs: 250 });
    await slider.press("ArrowDown");
    await settled();
    await expectSelected(page, 2);

    await fault(app, { delay: 600 });
    await slider.press("End");
    await expect(page.locator("#entries")).toHaveAttribute("aria-busy", "true");
    await page.waitForTimeout(100);
    await expectSelected(page, 2);
    await settled();
    await expectSelected(page, 7);
    await expect(page.locator("#mode")).toHaveText("Live");
    await expect(page.locator("#count")).toHaveAttribute("data-arrivals", "0");
    await capture(page, info, "delayed-live-complete");
  } finally {
    await app.close();
    await video.saveAs(info.outputPath("failed-navigation-walkthrough.webm"));
  }
});
