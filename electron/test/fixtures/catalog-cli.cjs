#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.env.SCOPE_CATALOG_FIXTURE_CONTROL
  ? fs.readFileSync(process.env.SCOPE_CATALOG_FIXTURE_CONTROL, "utf8").trim()
  : "success";
const log = process.env.SCOPE_CATALOG_FIXTURE_LOG;
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function entry(model, hidden = false) {
  return {
    id: model,
    model,
    hidden,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "xhigh" }],
    isDefault: true,
    defaultReasoningEffort: "low",
  };
}
const standard = [
  "gpt-5.6-luna",
  "test-success",
  "test-slow",
  "test-fail",
  "test-invalid-reference",
  "test-fresh",
  "test-handoff-invalid",
  "test-handoff-slow",
].map((value) => entry(value));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (log)
    fs.appendFileSync(
      log,
      JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        method: request.method,
        params: request.params,
      }) + "\n",
    );
  if (request.method === "initialize") {
    emit({ id: request.id, result: {} });
    return;
  }
  if (request.method === "initialized") return;
  if (request.method !== "model/list" || request.params.includeHidden !== true) {
    process.exit(2);
  }
  if (mode === "slow") return;
  if (mode === "storage") {
    fs.writeFileSync("oversized-temporary", Buffer.alloc(17 * 1024 * 1024));
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("invalid\n");
    return;
  }
  if (mode === "auth") {
    emit({ id: request.id, error: { message: "private credential synthetic", code: 401 } });
    return;
  }
  if (mode === "output") {
    process.stdout.write("x".repeat(600000));
    return;
  }
  if (mode === "diagnostics") {
    process.stderr.write("x".repeat(40000));
    return;
  }
  if (mode === "loop") {
    emit({ id: request.id, result: { data: [], nextCursor: "again" } });
    return;
  }
  if (mode === "pages") {
    emit({ id: request.id, result: { data: [], nextCursor: String(request.id) } });
    return;
  }
  if (mode === "maximum") {
    emit({
      id: request.id,
      result: {
        data: Array.from({ length: 256 }, (_, i) => ({
          ...entry(`model-${i}-${"x".repeat(110)}`, i % 2 === 0),
          supportedReasoningEfforts: Array.from({ length: 32 }, (_, j) => ({
            reasoningEffort: `effort-${j}`,
          })),
        })),
        nextCursor: null,
      },
    });
    return;
  }
  if (mode === "empty") {
    emit({ id: request.id, result: { data: [], nextCursor: null } });
    return;
  }
  if (mode === "stale") {
    emit({ id: request.id, result: { data: [entry("replacement-model")], nextCursor: null } });
    return;
  }
  if (mode === "effort") {
    emit({
      id: request.id,
      result: {
        data: [
          { ...entry("gpt-5.6-luna"), supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
        ],
        nextCursor: null,
      },
    });
    return;
  }
  emit({
    id: request.id,
    result: {
      data: request.params.cursor
        ? [entry("hidden-model", true), { ...entry("no-efforts"), supportedReasoningEfforts: [] }]
        : standard,
      nextCursor: request.params.cursor ? null : "second-page",
    },
  });
});
