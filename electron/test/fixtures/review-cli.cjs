#!/usr/bin/env node
const readline = require("node:readline");
let turn = "",
  count = 0,
  mode = "",
  timer,
  thread = "fixture-thread";
const emit = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const notify = (method, params) => emit({ method, params: { threadId: thread, ...params } });
const done = () => {
  notify("item/completed", {
    turnId: turn,
    item: { id: "answer-" + turn, type: "agentMessage", text: "Pinned source reviewed." },
  });
  notify("turn/completed", { turn: { id: turn, status: "completed" } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") emit({ id: m.id, result: { userAgent: "fixture" } });
  else if (m.method === "config/read")
    emit({
      id: m.id,
      result: {
        config: {
          mcp_servers: {},
          agents: { enabled: false },
          skills: { include_instructions: false },
          orchestrator: { skills: { enabled: false } },
        },
      },
    });
  else if (m.method === "skills/list")
    emit({
      id: m.id,
      result: {
        data: [
          {
            skills: mode.includes("changed-skills")
              ? [{ name: "new-synthetic-skill", enabled: true }]
              : [],
            errors: [],
          },
        ],
      },
    });
  else if (m.method === "thread/start")
    emit({
      id: m.id,
      result: {
        thread: { id: thread, ephemeral: true, path: null },
        model: m.params.model,
        reasoningEffort: "low",
        instructionSources: [],
        sandbox: { type: "readOnly", networkAccess: false },
      },
    });
  else if (m.method === "turn/start") {
    turn = "turn-" + ++count;
    mode = m.params.input[0].text.split("\n\nUser request:\n").at(-1);
    if (mode.includes("echo-prompts")) {
      emit({ id: m.id, result: { turn: { id: turn } } });
      notify("turn/started", { turn: { id: turn } });
      notify("item/agentMessage/delta", {
        turnId: turn,
        itemId: "answer-" + turn,
        delta: m.params.input[0].text,
      });
      notify("turn/completed", { turn: { id: turn, status: "completed" } });
      return;
    }
    emit({ id: m.id, result: { turn: { id: turn } } });
    notify("turn/started", { turn: { id: turn } });
    if (mode.includes("compaction")) {
      notify("thread/compacted", {});
      return;
    }
    if (mode.includes("malformed")) return process.stdout.write("not json\n");
    if (mode.includes("oversized")) return process.stdout.write("x".repeat(1024 * 1024 + 1));
    if (mode.includes("approval"))
      return emit({
        id: 991,
        method: "item/commandExecution/requestApproval",
        params: { threadId: thread, turnId: turn },
      });
    if (mode.includes("exit-fixture")) return setTimeout(() => process.exit(1), 60);
    if (mode.includes("slow")) {
      timer = setInterval(
        () =>
          notify("item/agentMessage/delta", {
            turnId: turn,
            itemId: "answer-" + turn,
            delta: "Working through supplied evidence. ",
          }),
        200,
      );
      return;
    }
    if (mode.includes("protocol-capacity")) {
      for (let i = 0; i < 8300; i++) notify("warning", { message: "fixture" });
      return;
    }
    if (mode.includes("capacity")) {
      for (let i = 0; i < 40; i++)
        notify("item/agentMessage/delta", {
          turnId: turn,
          itemId: "answer-" + turn,
          delta: "C".repeat(16384),
        });
      return;
    }
    if (mode.includes("source"))
      return emit({
        id: 900 + count,
        method: "item/tool/call",
        params: {
          threadId: thread,
          turnId: turn,
          callId: "call-" + turn,
          tool: "scope_evidence",
          arguments: { action: "list", id: "root" },
        },
      });
    notify("item/agentMessage/delta", { turnId: "stale-turn", itemId: "wrong", delta: "STALE" });
    notify("item/agentMessage/delta", {
      turnId: turn,
      itemId: "answer-" + turn,
      delta: "Pinned source reviewed.",
    });
    done();
    notify("item/completed", {
      turnId: turn,
      item: { id: "answer-" + turn, type: "agentMessage", text: "Pinned source reviewed." },
    });
  } else if (m.method === "turn/interrupt") {
    clearInterval(timer);
    emit({
      id: 995,
      method: "item/tool/call",
      params: {
        threadId: thread,
        turnId: turn,
        callId: "late-after-stop",
        tool: "scope_evidence",
        arguments: { action: "list", id: "root" },
      },
    });
    emit({ id: m.id, result: {} });
    notify("turn/completed", { turn: { id: turn, status: "interrupted" } });
  } else if (m.id >= 900 && m.result) {
    if (mode.includes("large-source") && m.id < 2000) {
      const entries = JSON.parse(m.result.contentItems[0].text).entries;
      const entry = entries.find((e) => e.path === "deleted.ts");
      emit({
        id: 2001,
        method: "item/tool/call",
        params: {
          threadId: thread,
          turnId: turn,
          callId: "read-" + turn,
          tool: "scope_evidence",
          arguments: { action: "read", id: entry.id },
        },
      });
    } else done();
  }
});
