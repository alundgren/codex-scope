import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { ANALYSIS_CLI_LIMITS, runAnalysisCli } from "../src/analysis-cli.ts";

const fixture = path.join(import.meta.dirname, "fixtures/analysis-cli.cjs");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(mode: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "analysis-cli-test-"));
  const marker = path.join(directory, "marker.json");
  const controller = new AbortController();
  const options = {
    model: "gpt-5.6-luna",
    effort: "xhigh",
    prompt: '{"calls":[{"order":1,"command":"rg timeout ."}]}',
    signal: controller.signal,
    executable: process.execPath,
    executableArgs: [fixture, mode, marker],
  };
  return { directory, marker, controller, options };
}

async function marked(
  marker: string,
): Promise<{ cwd: string; pid: number; child?: number; args: string[]; prompt: string }> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return JSON.parse(await readFile(marker, "utf8"));
    } catch {
      await wait(10);
    }
  }
  throw new Error("Synthetic child did not start.");
}

test("Codex runs once in a private directory with stdin evidence, isolated instructions and bounded JSON usage", async () => {
  const context = await setup("success");
  try {
    const result = await runAnalysisCli(context.options);
    assert.equal(JSON.parse(result.text).findings[0].callOrders[0], 1);
    assert.deepEqual(result.usage, { inputTokens: 80, cachedInputTokens: 16, outputTokens: 32 });
    const observed = await marked(context.marker);
    assert.equal(observed.prompt, context.options.prompt);
    assert(!observed.args.includes(context.options.prompt));
    for (const flag of [
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "--skip-git-repo-check",
    ])
      assert(observed.args.includes(flag), flag);
    for (const feature of ["hooks", "plugins", "apps", "multi_agent", "shell_tool"])
      assert.equal(observed.args[observed.args.indexOf(feature) - 1], "--disable");
    assert(observed.args.includes("project_doc_max_bytes=0"));
    assert(observed.args.includes('model_reasoning_effort="xhigh"'));
    assert.equal(observed.args[observed.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(observed.args[observed.args.indexOf("--model") + 1], "gpt-5.6-luna");
    await assert.rejects(stat(observed.cwd), { code: "ENOENT" });
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("invalid or oversized inputs and missing CLI produce fixed errors without evidence", async () => {
  const options = {
    model: "luna",
    effort: "low",
    prompt: "synthetic",
    signal: new AbortController().signal,
  };
  await assert.rejects(
    runAnalysisCli({ ...options, model: "--private-synthetic-evidence" }),
    /model identifier/,
  );
  await assert.rejects(
    runAnalysisCli({ ...options, prompt: "x".repeat(ANALYSIS_CLI_LIMITS.promptBytes + 1) }),
    /input limit/,
  );
  await assert.rejects(
    runAnalysisCli({ ...options, executable: "/nonexistent/codex-synthetic" }),
    /CLI was not found/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(runAnalysisCli({ ...options, signal: aborted.signal }), /cancelled/);
});

test("malformed, incomplete, invalid, duplicate and oversized results fail without retaining private diagnostics", async () => {
  for (const [mode, expected] of [
    ["malformed", /invalid event stream/],
    ["incomplete", /invalid analysis result/],
    ["invalid", /invalid analysis result/],
    ["duplicate", /invalid analysis result/],
    ["oversized", /oversized analysis result/],
    ["auth", /authentication is unavailable/],
    ["model", /selected model is unavailable/],
    ["tool", /attempted a tool action/],
  ] as const) {
    const context = await setup(mode);
    try {
      await assert.rejects(
        runAnalysisCli(context.options),
        (error: Error) =>
          expected.test(error.message) && !error.message.includes("private-synthetic-evidence"),
      );
      await assert.rejects(stat((await marked(context.marker)).cwd), { code: "ENOENT" });
    } finally {
      await rm(context.directory, { recursive: true, force: true });
    }
  }
});

test("output, diagnostics, process memory, temporary entries and duration are bounded", async () => {
  for (const [mode, expected] of [
    ["stdout", /output limit/],
    ["stderr", /diagnostic output limit/],
    ["resource", /resource limits/],
    ["memory", /resource limits/],
    ["wait", /time limit/],
  ] as const) {
    const context = await setup(mode);
    try {
      await assert.rejects(
        runAnalysisCli({ ...context.options, timeoutMs: mode === "wait" ? 120 : 5000 }),
        expected,
      );
      await assert.rejects(stat((await marked(context.marker)).cwd), { code: "ENOENT" });
    } finally {
      await rm(context.directory, { recursive: true, force: true });
    }
  }
});

test("cancellation terminates the process group, clears private files and permits the next run", async () => {
  const context = await setup("child");
  try {
    const run = runAnalysisCli(context.options);
    const rejected = assert.rejects(run, /cancelled/);
    const observed = await marked(context.marker);
    await assert.rejects(runAnalysisCli(context.options), /already running/);
    context.controller.abort();
    await rejected;
    await assert.rejects(stat(observed.cwd), { code: "ENOENT" });
    for (const pid of [observed.pid, observed.child!]) {
      // Linux can retain a killed grandchild briefly as a zombie until its reaper runs.
      if (process.platform === "linux") {
        try {
          assert.match(await readFile(`/proc/${pid}/stat`, "utf8"), /^\d+ \(.+\) Z /);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      } else assert.throws(() => process.kill(pid, 0));
    }
  } finally {
    context.controller.abort();
    await rm(context.directory, { recursive: true, force: true });
  }
  const next = await setup("success");
  try {
    assert((await runAnalysisCli(next.options)).text);
  } finally {
    await rm(next.directory, { recursive: true, force: true });
  }
});

test("a completed child cannot bypass aggregate temporary storage limits between samples", async () => {
  const context = await setup("quick-storage");
  // Hold interval ticks to exercise the final check independently of machine speed.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await assert.rejects(runAnalysisCli(context.options), /temporary storage limit/);
    await assert.rejects(stat((await marked(context.marker)).cwd), { code: "ENOENT" });
  } finally {
    vi.useRealTimers();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("failed cleanup disables later invocations without creating more temporary directories", async () => {
  vi.resetModules();
  const { runAnalysisCli: isolatedRun } = await import("../src/analysis-cli.ts");
  const context = await setup("cleanup");
  let observed: Awaited<ReturnType<typeof marked>> | undefined;
  try {
    await assert.rejects(isolatedRun(context.options), /temporary files could not be removed/);
    observed = await marked(context.marker);
    await chmod(path.join(observed.cwd, "locked"), 0o700);
    await rm(observed.cwd, { recursive: true, force: true });
    await rm(context.marker);
    await assert.rejects(
      isolatedRun(context.options),
      /restart Codex Scope before analyzing again/,
    );
    await assert.rejects(stat(context.marker), { code: "ENOENT" });
  } finally {
    if (observed) {
      await chmod(path.join(observed.cwd, "locked"), 0o700).catch(() => {});
      await rm(observed.cwd, { recursive: true, force: true });
    }
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("private app storage reuses one directory and removes only bounded stale work", async () => {
  const context = await setup("success");
  const temporaryRoot = path.join(context.directory, "analysis");
  const work = path.join(temporaryRoot, "work");
  try {
    await mkdir(temporaryRoot, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    await writeFile(path.join(work, "stale.txt"), "synthetic stale content");
    await writeFile(
      path.join(temporaryRoot, "owner.json"),
      JSON.stringify({ group: 2_147_483_647 }),
      { mode: 0o600 },
    );
    await runAnalysisCli({ ...context.options, temporaryRoot });
    assert.equal((await marked(context.marker)).cwd, work);
    assert.deepEqual(await readdir(temporaryRoot), []);
    await runAnalysisCli({ ...context.options, temporaryRoot });
    assert.equal((await marked(context.marker)).cwd, work);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("active ownership, unexpected entries, symlinks and unfinished ownership prevent reuse without deletion", async () => {
  const context = await setup("success");
  const temporaryRoot = path.join(context.directory, "analysis");
  const work = path.join(temporaryRoot, "work");
  const marker = path.join(temporaryRoot, "owner.json");
  const sentinel = path.join(context.directory, "sentinel.txt");
  try {
    await writeFile(sentinel, "must remain");
    await mkdir(temporaryRoot, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    const group = Number(
      execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 1024,
      }).trim(),
    );
    await writeFile(marker, JSON.stringify({ group }), { mode: 0o600 });
    await assert.rejects(
      runAnalysisCli({ ...context.options, temporaryRoot }),
      /earlier analysis process may still be running/,
    );
    await stat(work);
    await writeFile(marker, JSON.stringify({ group: 0 }));
    await assert.rejects(
      runAnalysisCli({ ...context.options, temporaryRoot }),
      /could not be safely reused/,
    );
    await rm(marker);
    await assert.rejects(
      runAnalysisCli({ ...context.options, temporaryRoot }),
      /could not be safely reused/,
    );
    await rm(work, { recursive: true });
    await symlink(path.join(context.directory, "sentinel.txt"), work);
    await assert.rejects(
      runAnalysisCli({ ...context.options, temporaryRoot }),
      /could not be safely reused/,
    );
    await rm(work);
    await writeFile(path.join(temporaryRoot, "unexpected.txt"), "leave intact");
    await assert.rejects(
      runAnalysisCli({ ...context.options, temporaryRoot }),
      /could not be safely reused/,
    );
    assert.equal(await readFile(sentinel, "utf8"), "must remain");
    assert.equal(
      await readFile(path.join(temporaryRoot, "unexpected.txt"), "utf8"),
      "leave intact",
    );
    await assert.rejects(stat(context.marker), { code: "ENOENT" });
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});
