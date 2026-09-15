import { test, expect } from "vite-plus/test";
import { mkdtemp, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { CatalogDiscovery } from "../src/model-catalog.ts";
import { selectionError } from "../src/model-types.ts";
async function fixture(mode: string) {
  const root = await mkdtemp("/tmp/scope-catalog-");
  const executable = path.join(root, "codex");
  const control = path.join(root, "mode");
  const log = path.join(root, "requests");
  await writeFile(control, mode);
  await writeFile(
    executable,
    `#!/bin/sh\nexport SCOPE_CATALOG_FIXTURE_CONTROL='${control}'\nexport SCOPE_CATALOG_FIXTURE_LOG='${log}'\nexec '${process.execPath}' '${path.join(import.meta.dirname, "fixtures/catalog-cli.cjs")}' "$@"\n`,
    { mode: 0o700 },
  );
  return {
    root,
    log,
    control,
    catalog: new CatalogDiscovery(path.join(root, "catalog"), executable),
  };
}
test("catalog exhausts hidden pages without threads, exposes exact efforts and rejects stale choices", async () => {
  const f = await fixture("success");
  try {
    const result = await f.catalog.read();
    expect(result.complete).toBe(true);
    expect(result.models).toHaveLength(10);
    expect(result.models.find((model) => model.hidden)?.model).toBe("hidden-model");
    expect(selectionError(result, { model: "hidden-model", effort: "xhigh" })).toBeNull();
    expect(selectionError(result, { model: "hidden-model", effort: "ultra" })).toContain("effort");
    expect(selectionError(result, { model: "absent", effort: "low" })).toContain("unavailable");
    const requests = (await readFile(f.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "model/list",
    ]);
    expect(requests[3].params).toMatchObject({ includeHidden: true, cursor: "second-page" });
    await expect(stat(requests[0].cwd)).rejects.toThrow();
    expect(await readdir(path.join(f.root, "catalog"))).toEqual([]);
    expect(() => process.kill(requests[0].pid, 0)).toThrow();
  } finally {
    await f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("incomplete, looping, oversized, authentication and empty catalogs remain retryable without diagnostics", async () => {
  const f = await fixture("loop");
  try {
    for (const mode of ["loop", "pages", "output", "diagnostics", "malformed", "auth", "empty"]) {
      await writeFile(f.control, mode);
      const result = await f.catalog.read();
      expect(result.error).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain("private credential");
      if (mode !== "empty") expect(result.complete).toBe(false);
    }
    await writeFile(f.control, "success");
    expect((await f.catalog.read()).complete).toBe(true);
  } finally {
    await f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("cancellation and missing CLI retire their process and permit a later discovery", async () => {
  const f = await fixture("slow");
  try {
    const abort = new AbortController();
    const pending = f.catalog.read(abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await f.catalog.read()).complete).toBe(false);
    abort.abort();
    expect((await pending).error).toContain("cancelled");
    await writeFile(f.control, "success");
    expect((await f.catalog.read()).complete).toBe(true);
    const missing = new CatalogDiscovery(path.join(f.root, "missing"), "/missing/codex");
    expect((await missing.read()).error).toContain("not found");
  } finally {
    await f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a silent discovery reaches its deadline, closes and permits retry", async () => {
  const f = await fixture("slow");
  try {
    const started = performance.now();
    expect((await f.catalog.read()).error).toContain("timed out");
    expect(performance.now() - started).toBeLessThan(6500);
    expect(await readdir(path.join(f.root, "catalog"))).toEqual([]);
    await writeFile(f.control, "success");
    expect((await f.catalog.read()).complete).toBe(true);
  } finally {
    await f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 10000);
