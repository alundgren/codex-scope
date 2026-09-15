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
    const first = document.querySelector<HTMLElement>("#entries [data-event]");
    return (
      !expected ||
      (first?.dataset.event === String(expected.id) &&
        document.querySelector<HTMLElement>("#entries")!.dataset.position ===
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
  if (await page.locator("#call-detail").isVisible()) await page.locator("#detail-close").click();
  const queries: number[] = [],
    keys: number[] = [];
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
  await state();
  if (await page.locator("#call-detail").isVisible()) await page.locator("#detail-close").click();
  for (const order of ["largest", "newest", "largest", "newest"]) {
    const measure = async (action: () => Promise<unknown>) => {
      const started = performance.now();
      await action();
      await completed(page);
      keys.push(performance.now() - started);
    };
    await measure(() => page.locator("#sort").selectOption(order));
    if (await page.locator("#next-page").isEnabled()) {
      await measure(() => page.locator("#next-page").click());
      await measure(() => page.locator("#previous-page").click());
    }
    if (await page.locator("#entries tr").count()) {
      await measure(async () => {
        await page.locator("#entries tr").first().press("Enter");
        await page.locator("#detail-close").waitFor();
      });
      await measure(() => page.locator("#detail-close").click());
    }
  }
  await rapidSort(page);
  return {
    searchMs: distribution(queries),
    keyboardMs: distribution(keys),
    sortChanges: 120,
    summaryRows: await page.locator(".event").count(),
  };
}
export async function rapidSort(page: Page) {
  if (await page.locator("#call-detail").isVisible()) await page.locator("#detail-close").click();
  await page.locator("#sort").evaluate((node) => {
    const control = node as HTMLSelectElement;
    for (let index = 0; index < 120; index++) {
      control.value = index % 2 ? "newest" : "largest";
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await completed(page);
}
