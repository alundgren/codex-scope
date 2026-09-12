import type { HistoryStatus } from "../src/types.ts";
import type { Page } from "@playwright/test";
import assert from "node:assert/strict";

export async function completed(
  page: Page,
  expected: { id: number; position: number } | null = null,
) {
  await page.waitForFunction((expected) => {
    if (document.querySelector<HTMLElement>("#entries")!.getAttribute("aria-busy") !== "false")
      return false;
    const payload = document.querySelector<HTMLElement>("#payload")!.dataset.event;
    const selected = document.querySelector<HTMLElement>('.event[aria-pressed="true"]');
    if (payload && payload !== "null") {
      if (payload !== selected?.dataset.event) return false;
    } else if (selected) return false;
    return (
      !expected ||
      (payload === String(expected.id) &&
        document.querySelector<HTMLElement>("#scrubber")!.getAttribute("aria-valuenow") ===
          String(expected.position))
    );
  }, expected);
  const notice = await page.locator("#notice").textContent();
  assert(
    !/timed out|could not|Searching…/.test(notice ?? ""),
    `Measured query must succeed: ${notice}`,
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

export function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    operations: values.length,
    minimum: sorted[0],
    maximum: sorted.at(-1),
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

export async function interactions(page: Page, state: () => Promise<HistoryStatus>) {
  const queries = [],
    keys = [];
  for (const text of [
    "population",
    "odd",
    "literal [a.*]%_",
    "missing literal",
    "2026-09-11t18",
    "POPULATION",
    "even",
    "session-39",
    ".*",
    "",
  ]) {
    const started = performance.now();
    await page.locator("#search").fill(text);
    try {
      await completed(page);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      error.message = `Synthetic query ${JSON.stringify(text)}: ${error.message}`;
      throw error;
    }
    queries.push(performance.now() - started);
  }
  const history = await state();
  assert.equal(history.last!.id - history.first!.id + 1, history.total);
  let position = 0;
  await page.locator("#scrubber").press("Home");
  await completed(page, { id: history.first!.id, position });
  for (const key of [
    "End",
    "ArrowUp",
    "PageUp",
    "PageDown",
    "Home",
    "ArrowDown",
    "ArrowRight",
    "ArrowLeft",
    "End",
    "ArrowUp",
  ]) {
    const moves: Record<string, number> = {
      End: history.total,
      Home: 0,
      ArrowUp: position - 1,
      ArrowLeft: position - 1,
      ArrowDown: position + 1,
      ArrowRight: position + 1,
      PageUp: position - 5,
      PageDown: position + 5,
    };
    position = Math.max(0, Math.min(history.total, moves[key]));
    const started = performance.now();
    await page.locator("#scrubber").press(key);
    await completed(page, {
      id: history.first!.id + Math.min(history.total - 1, position),
      position,
    });
    keys.push(performance.now() - started);
  }
  await rapidScrub(page);
  return {
    searchMs: distribution(queries),
    keyboardMs: distribution(keys),
    pointerMoves: 120,
    summaryRows: await page.locator(".event").count(),
    tickNodes: await page.locator(".tick").count(),
  };
}

export async function rapidScrub(page: Page) {
  const track = await page.locator("#scrubber").boundingBox();
  assert(track, "Scrubber must be visible.");
  await page.mouse.move(track.x + 22, track.y + 1);
  await page.mouse.down();
  await page.mouse.move(track.x + 22, track.y + track.height - 2, { steps: 60 });
  await page.mouse.move(track.x + 22, track.y + 1, { steps: 60 });
  await page.mouse.up();
  await completed(page);
}
