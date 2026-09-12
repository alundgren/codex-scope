// Synthetic executable for bounded subprocess checks. Never invokes a model.
const fs = require("node:fs");
const childProcess = require("node:child_process");
const mode = process.argv[2];
const marker = process.argv[3];
const args = process.argv.slice(4);
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const result = {
  findings: [
    {
      id: "search-1",
      title: "Narrow the search",
      detail: "The synthetic command searches the current directory.",
      suggestion: "Start with a relevant directory.",
      callOrders: [1],
    },
  ],
};
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  fs.writeFileSync(marker, JSON.stringify({ cwd: process.cwd(), args, prompt, pid: process.pid }));
  if (mode === "wait" || mode === "child") {
    if (mode === "child") {
      const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "inherit",
      });
      fs.writeFileSync(
        marker,
        JSON.stringify({ cwd: process.cwd(), pid: process.pid, child: child.pid }),
      );
    }
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "stdout" || mode === "stderr") {
    const stream = mode === "stdout" ? process.stdout : process.stderr;
    stream.write("private-synthetic-evidence".repeat(32 * 1024));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "auth" || mode === "model") {
    process.stderr.write(
      mode === "auth"
        ? "401 authentication failed private-synthetic-evidence"
        : "model not found private-synthetic-evidence",
    );
    process.exitCode = 1;
    return;
  }
  if (mode === "resource") {
    for (let index = 0; index < 70; index++) fs.writeFileSync(`entry-${index}`, "synthetic");
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "memory") {
    const allocation = Buffer.alloc(540 * 1024 * 1024, 1);
    setInterval(() => {
      allocation[0] = 1;
    }, 1000);
    return;
  }
  if (mode === "quick-storage") {
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    fs.writeFileSync("first.bin", bytes);
    fs.writeFileSync("second.bin", bytes);
  }
  if (mode === "cleanup") {
    fs.mkdirSync("locked");
    fs.writeFileSync("locked/synthetic.txt", "synthetic");
    fs.chmodSync("locked", 0);
  }
  if (mode === "tool") {
    emit({
      type: "item.started",
      item: { type: "command_execution", command: "private-synthetic-evidence" },
    });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "invalid") {
    result.findings[0].callOrders = [-1];
  }
  if (mode === "duplicate") {
    result.findings.push(result.findings[0]);
  }
  if (mode === "oversized") {
    result.findings[0].detail = "x".repeat(70 * 1024);
  }
  if (mode === "malformed") {
    process.stdout.write("private-synthetic-evidence\n");
    return;
  }
  emit({ type: "thread.started", thread_id: "synthetic-analysis" });
  emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } });
  if (mode !== "incomplete")
    emit({
      type: "turn.completed",
      usage: { input_tokens: 80, cached_input_tokens: 16, output_tokens: 32 },
    });
});
