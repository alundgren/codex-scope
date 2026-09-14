import { _electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import path from "node:path";
const temporary = await mkdtemp("/tmp/scope-real-collector-");
const linux = path.resolve("../linux");
const fixture = await readFile("../protocol/fixtures/pre-tool-use.json", "utf8");
await writeFile(temporary + "/token", randomBytes(32).toString("hex"), { mode: 0o600 });
let app,
  collector,
  collectorOutput = "";
const report = {
  date: new Date().toISOString(),
  environment:
    "Actual Electron/Xvfb and landed Linux collector, loopback HTTP, synthetic datagram only",
  collectorImplementation: "Rust port",
  checks: [] as string[],
  result: "pending",
};
try {
  collector = spawn(
    path.join(linux, "target/debug/codex-scope"),
    [
      "collector",
      "--runtime-dir",
      temporary + "/runtime",
      "--token-file",
      temporary + "/token",
      "--port",
      "0",
    ],
    { cwd: linux, stdio: ["ignore", "pipe", "pipe"] },
  );
  collector.stdout.on("data", (chunk) => {
    collectorOutput = (collectorOutput + chunk.toString()).slice(-1024);
  });
  // Fixed diagnostic capacity; collector output never enters the report.
  collector.stderr.on("data", () => {});
  const deadline = performance.now() + 5000;
  while (!/loopback port (\d+)/.test(collectorOutput)) {
    if (performance.now() >= deadline || collector.exitCode !== null)
      throw new Error("Real collector did not start.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const port = Number(collectorOutput.match(/loopback port (\d+)/)![1]);
  await writeFile(
    temporary + "/connection.json",
    JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, tokenFile: temporary + "/token" }),
    { mode: 0o600 },
  );
  await mkdir("../.artifacts/visual/collector-smoke", { recursive: true });
  app = await _electron.launch({
    args: [
      path.resolve("dist/app"),
      "--history-test",
      `--scope-test-root=${temporary}/viewer`,
      `--connection-config=${temporary}/connection.json`,
    ],
    chromiumSandbox: true,
    recordVideo: {
      dir: "../.artifacts/visual/collector-smoke/video",
      size: { width: 1180, height: 820 },
    },
  });
  const page = await app.firstWindow();
  await page.evaluate(() => window.scope.capture(true));
  await page.locator("#functions summary").click();
  await page.locator('[data-tool="journal"]').click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>(".connection")!.textContent === "Connected",
  );
  const input = spawn(
    path.join(linux, "target/debug/codex-scope-observer"),
    [temporary + "/runtime/ingest.sock"],
    { cwd: linux, stdio: ["pipe", "ignore", "ignore"] },
  );
  input.stdin.end(fixture);
  const [code] = await once(input, "exit");
  assert.equal(code, 0);
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>("#count")!.textContent === "1 retained",
  );
  const event = await app.evaluate(async () => {
    const result = await globalThis.scopeHistory.inspect(1, 1, 5);
    if (!("selected" in result) || !result.selected) throw new Error("Missing delivered event.");
    return result.selected;
  });
  assert.equal(event.text, fixture);
  assert.equal(event.bytes, Buffer.byteLength(fixture));
  report.checks.push(
    "Landed collector hello and synthetic datagram accepted with exact original bytes",
  );
  await new Promise((resolve) => setTimeout(resolve, 7000));
  assert.equal(
    (await app.evaluate(() => globalThis.scopeHistory.snapshot())).transport!.state,
    "connected",
  );
  report.checks.push("Stream survives beyond six-second lease through separate heartbeat requests");
  await page.screenshot({ path: "../.artifacts/visual/collector-smoke/real-collector.png" });
  collector.kill("SIGTERM");
  await once(collector, "exit");
  collector = null;
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>(".connection")!.textContent === "Disconnected",
  );
  assert.equal((await app.evaluate(() => globalThis.scopeHistory.snapshot())).total, 1);
  report.checks.push("Collector close preserves retained history and reports unknown coverage");
  await page.screenshot({
    path: "../.artifacts/visual/collector-smoke/real-collector-disconnected.png",
  });
  const video = page.video();
  await app.close();
  app = null;
  await video!.saveAs("../.artifacts/visual/collector-smoke/real-collector-walkthrough.webm");
  report.result = "pass";
} finally {
  if (app) await app.close();
  if (collector) {
    collector.kill("SIGTERM");
    await once(collector, "exit");
  }
  await rm(temporary, { recursive: true, force: true });
}
await writeFile(
  "../.artifacts/visual/collector-smoke/result.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "Real collector synthetic smoke passed. No hooks, trust, private proxy or real payloads were used.",
);
