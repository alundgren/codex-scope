#!/usr/bin/env node
// Synthetic CLI protocol fixture. Never uses credentials or contacts a provider.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const model = process.argv[process.argv.indexOf("--model") + 1];
  if (model === "test-slow") {
    setTimeout(() => process.exit(0), 60000);
    return;
  }
  if (model === "test-fail") {
    process.stdout.write(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "Synthetic provider unavailable." },
      }) + "\n",
    );
    process.exitCode = 1;
    return;
  }
  if (input.includes("KEPT_FINDINGS\n")) {
    if (model === "test-handoff-slow") {
      setTimeout(() => process.exit(0), 60000);
      return;
    }
    const handoff =
      model === "test-handoff-invalid"
        ? ""
        : "Review these findings against your current task before changing your approach.\n" +
          input.split("KEPT_FINDINGS\n")[1];
    setTimeout(() => {
      process.stdout.write(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: JSON.stringify({ handoff }) },
        }) + "\n",
      );
      process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
    }, 500);
    return;
  }
  const snapshot = JSON.parse(input.split("EVIDENCE_JSON\n")[1]);
  const first = snapshot.calls[0];
  const second = snapshot.calls[1];
  const findings = first
    ? [
        {
          id: "narrow-search",
          title: "Try a narrower discovery query",
          detail:
            "The captured command searches the current directory. The hook does not prove that this is the repository root or that broad discovery was unnecessary.",
          suggestion:
            "Try filename discovery first, then search the relevant directory. Compare task quality before keeping the change.",
          callOrders: [first.order],
        },
        ...(second
          ? [
              {
                id: "scout-read",
                title: "Consider a scout before reading many files",
                detail:
                  "A batch read returned more text than the neighboring narrow query. The evidence does not establish a cheaper model would be sufficient.",
                suggestion:
                  "Ask a scout for relevant paths, line ranges and a short explanation before the main agent reads full files.",
                callOrders: [second.order],
              },
            ]
          : []),
      ]
    : [];
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ findings }) },
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 30 },
    }) + "\n",
  );
});
