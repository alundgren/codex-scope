import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = import.meta.dirname;
const require = createRequire(import.meta.url);
const vp = path.join(path.dirname(require.resolve("vite-plus/package.json")), "bin/vp");
const target = path.join(root, "dist/app");
await rm(path.join(root, "dist"), { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const command of ["pack", "build"]) {
  execFileSync(process.execPath, [vp, command], { cwd: root, stdio: "inherit" });
}
await mkdir(path.join(target, "fixtures"));
await writeFile(
  path.join(target, "fixtures/journal.jsonl.gz"),
  gzipSync(await readFile(path.join(root, "fixtures/journal.jsonl"))),
);
const { name, version, description, license } = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
  description: string;
  license: string;
};
await writeFile(
  path.join(target, "package.json"),
  JSON.stringify(
    { name, version, description, license, type: "module", main: "main.mjs" },
    null,
    2,
  ) + "\n",
);
console.log("Built dist/app with compiled application files and synthetic fixtures.");
