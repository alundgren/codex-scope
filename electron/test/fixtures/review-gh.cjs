#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const endpoint = args[3];
const root = process.env.SCOPE_REVIEW_FIXTURE_ROOT || path.dirname(process.cwd());
let state = {};
try {
  state = JSON.parse(fs.readFileSync(path.join(root, "review-control.json"), "utf8"));
} catch {}
fs.appendFileSync(
  path.join(root, "review-requests.jsonl"),
  JSON.stringify({ args, pid: process.pid }) + "\n",
);
const output = (value) =>
  process.stdout.write(
    typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
  );
if (state.mode === "hang") {
  setInterval(() => {}, 1000);
  return;
}
if (state.mode === "auth") {
  process.stderr.write("fixture authentication failure");
  process.exit(1);
}
if (state.mode === "oversized") {
  output("x".repeat(3 * 1024 * 1024));
  return;
}
const base = "a".repeat(40),
  head = (state.stale ? "d" : "b").repeat(40),
  merge = "c".repeat(40);
const patch =
  "@@ -1,260 +1,260 @@\n" +
  Array.from({ length: 260 }, (_, i) => " " + `export const value${i + 1} = ${i + 1};`).join("\n");
const special = [
  { filename: "src/checkout/submit.ts", status: "modified", patch },
  {
    filename: "src/renamed.ts",
    previous_filename: "src/old.ts",
    status: "renamed",
    patch: "@@ -2,2 +2,2 @@\n-old value\n+new value\n unchanged",
  },
  { filename: "asset.bin", status: "modified" },
  { filename: "missing.txt", status: "modified" },
  { filename: "deleted.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-deleted" },
  { filename: "added.ts", status: "added", patch: "@@ -0,0 +1 @@\n+added" },
  { filename: "large.ts", status: "modified", patch: "x".repeat(140000) },
  { filename: "truncated.ts", status: "modified", patch: "@@ -1,5 +1,5 @@\n one" },
];
if (/\/pulls\/\d+$/.test(endpoint)) {
  output({
    number: Number(endpoint.split("/").at(-1)),
    title: "Prevent duplicate checkout orders",
    body: "Synthetic PR evidence for notebook validation.",
    state: "open",
    changed_files: state.large ? 3010 : 10,
    base: { sha: base, repo: { full_name: "example/shop" } },
    head: { sha: head, repo: state.missingFork ? null : { full_name: "contributor/shop" } },
  });
} else if (endpoint.includes("/compare/")) output({ merge_base_commit: { sha: merge } });
else if (endpoint.includes("/files?")) {
  const page = Number(new URL("https://x/" + endpoint).searchParams.get("page"));
  output(
    Array.from({ length: 10 }, (_, i) => {
      const n = (page - 1) * 10 + i;
      return {
        additions: 1,
        deletions: 1,
        ...(special[n] || { filename: `src/file-${n}.ts`, status: "modified", patch }),
      };
    }),
  );
} else if (endpoint.includes("/contents/")) {
  if (endpoint.includes("asset.bin")) output(Buffer.from([0, 1, 2, 3]));
  else if (endpoint.includes("missing.txt")) process.exit(1);
  else if (endpoint.includes("large.ts")) output("x".repeat(300000));
  else if (state.longSource)
    output(Array.from({ length: 19000 }, (_, i) => `line ${i}`).join("\n"));
  else output(Array.from({ length: 300 }, (_, i) => `source line ${i + 1}`).join("\n"));
} else process.exit(1);
