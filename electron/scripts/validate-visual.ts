import { electronDirectory, playwrightCli, vpCli, dependencyVersions } from "./tools.ts";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const output = path.resolve("../.artifacts/visual/electron-report");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const report: {
  [key: string]: unknown;
  completed: boolean;
  files: { path: string; bytes: number; sha256: string }[];
} = {
  date: new Date().toISOString(),
  platform: os.platform(),
  release: os.release(),
  hostNode: process.version,
  mode: "Actual Electron/Xvfb; synthetic fixtures and bounded fake collector; no resource measurements.",
  electron: (await readFile(path.join(electronDirectory, "version"), "utf8")).trim(),
  playwright: dependencyVersions()["@playwright/test"],
  completed: false,
  files: [],
};
try {
  execFileSync(process.execPath, [vpCli, "run", "build"], { stdio: "inherit" });
  execFileSync(process.execPath, [vpCli, "run", "test:unit"], { stdio: "inherit" });
  execFileSync(
    process.execPath,
    ["scripts/desktop.ts", process.execPath, playwrightCli, "test", "--reporter=list,json"],
    {
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(output, "tests.json") },
    },
  );
  execFileSync(process.execPath, ["scripts/reference.ts"], { stdio: "inherit" });
  const tests = JSON.parse(await readFile(path.join(output, "tests.json"), "utf8"));
  report.stats = tests.stats;
  report.completed = tests.stats.unexpected === 0 && tests.stats.skipped === 0;
  if (!report.completed) process.exitCode = 1;
} catch (error) {
  report.failure =
    error instanceof Error
      ? { message: error.message, status: "status" in error ? error.status : null }
      : { message: String(error) };
  process.exitCode = 1;
} finally {
  async function collect(directory: string, relative: string = "") {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const source = path.join(directory, entry.name),
        name = path.join(relative, entry.name);
      if (entry.isDirectory() && entry.name !== "video") await collect(source, name);
      else if (entry.isFile() && /\.(png|webm)$/.test(entry.name)) {
        const destination = path.join(output, "artifacts", name);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(source, destination);
        report.files.push({
          path: `artifacts/${name}`,
          bytes: (await stat(source)).size,
          sha256: createHash("sha256")
            .update(await readFile(source))
            .digest("hex"),
        });
      }
    }
  }
  await collect("../.artifacts/visual/electron-tests", "tests");
  await collect("../.artifacts/visual/reference", "reference");
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    `Visual result: ${report.completed ? "PASS" : "FAIL"}; ${report.files.length} artifacts in ../.artifacts/visual/electron-report. Inspect the images and recordings before approving UX.`,
  );
}
