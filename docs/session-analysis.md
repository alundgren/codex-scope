# Session analysis

Open **Analyze session** from the event journal, choose a retained session and
choose an explicit diagnosis model and supported reasoning effort in Settings. Both values start empty. Refresh models or open its picker to discover the installed CLI catalog, including hidden entries. Saved choices persist; unavailable choices are never substituted. **Analyze** sends
a bounded snapshot of captured hook evidence to that CLI's model provider.
The CLI runs on the viewer machine. Inference is not necessarily local.

The viewer needs `codex` on its process PATH and an existing CLI sign-in. It does
not read or copy credentials. Unsupported CLI options, missing authentication,
unavailable models, malformed results and resource failures appear as failed
runs with retry guidance. Installing or signing in to Codex remains an explicit
operation outside the viewer. macOS PATH discovery, sign-in and native behavior
need platform validation.

## One investigation, four views

Results ranks observed textual response sizes. Search trail displays captured
call order. Agent routing groups by the model identifier supplied in the hook;
it does not invent main/scout links. Recommendations shows model-generated
findings with source call references, proposed changes and keep/dismiss/undo.
The selected call follows view changes. Search, observed-model filters, sort and
scroll positions belong to their respective views. A hidden selection offers
**Show selected call**.
The original event journal remains available with its reading position.

Changing views does not invoke Codex. Analysis runs keep separate model and effort choices,
findings, usage and recommendation decisions. By default another model analyzes
the selected run's existing evidence snapshot. Select **New snapshot** to include
newer retained data. Previous results remain readable while one run executes.
At most four runs are retained across sessions; older runs are removed. Closing
the application or clearing history removes runs and cancels active analysis.
No runs, recommendation decisions or missed events are recovered on restart.

**Copy session handoff** sends only the kept findings, call references and snapshot
identity back through the analysis run's model. A fresh ephemeral request receives
that context with the run's original model and effort because analyzer conversations are not retained. The current catalog is checked again before handoff generation. It prepares a
handoff for the agent still working in the source session, describing findings,
uncertainty and suggested corrections for current and future work. The completed
handoff goes to the clipboard for the user to paste into that session. It does
not send a message to the source session or apply changes automatically.
Cancellation or generation failure preserves the clipboard and retained results.
Clipboard writes have a two-second response deadline and at most one pending
handoff write. An unconfirmed native write may finish after that deadline; no
further handoff starts until it settles. Handoff
generation shares the single active CLI slot and all analysis execution limits.

## Evidence and findings

The existing database worker selects up to 128 recent PreToolUse/PostToolUse
records for one exact session and recording generation, at a fixed upper event
ID. It produces at most 64 call summaries within 192 KiB. Explicit turn/call IDs,
model and actor fields distinguish paired pre/post records; ambiguous records
remain separate. Snapshot summaries are limited independently of total history.

Commands and textual arguments retain up to 1,024 characters. Textual response
excerpts retain up to 1,536 characters and display omission notices. The byte
count comes from the complete accepted textual `tool_response`, not its excerpt
or the whole hook JSON. Structured responses currently have unknown text size;
serializing arbitrary JSON would introduce a different metric. Original accepted
hook text remains unchanged in temporary history and can be loaded on demand.
An evicted original is explicitly unavailable; a neighboring event is never
substituted. Bounded snapshot summaries can outlive original-event eviction until
their analysis run is removed.

Missing fields and identity fields over 1,024 characters remain unknown.
Oversized identities are never paired using shortened values. Capture gaps, recording-wide evictions, local
recording drops and collector lifetime totals restrict the interpretation of
results. These drop/eviction counts are not attributed to the selected session.
A lack of findings does not establish efficiency. Commands, excerpts and findings
render as text, without interpreting markup or links.

The model receives the snapshot as untrusted evidence with fixed analysis
instructions. Findings must use valid captured event IDs, bounded fields and
unique identifiers. Unsupported or invented references reject the result.
Recommendations remain hypotheses for human review. The analyzer cannot observe
what the model used, final context delivery after code-mode filtering, complete
hosted-tool coverage, or exact per-call cost. Analyst input, cached-input and
output token usage comes from its own CLI result and remains separate from the
inspected session's unknown usage.

The [official hook reference](https://learn.chatgpt.com/docs/hooks) describes
available inputs and coverage exceptions. Further context-delivery and actor
instrumentation, including bounded metadata for oversized returns, remains
future work. The existing whole-hook admission limit still applies.

## Execution and limits

`analysis-evidence.ts` extracts summaries in the existing SQLite worker.
`analysis.ts` owns bounded temporary runs in main and validates source references.
`analysis-cli.ts` starts one transient CLI process group for explicit analysis. `model-catalog.ts` discovers and validates the chosen pair first, using only initialization and model-list requests. Both use the existing process and temporary-storage limits in `cli-resources.ts`.
The renderer receives only the selected bounded run, keeps at most four small
view-state records, and requests original payload text separately.

CLI execution uses a private temporary working directory, an ephemeral session,
a read-only sandbox, fixed instructions and a structured output schema. It
ignores user configuration and project rules for this analysis invocation,
disables hooks, plugins, apps, shell, browser, subagent and related tool features,
and disables telemetry. Normal CLI authentication remains available. The
application never gathers transcripts, environment values, project files or
other hooks' output as analysis evidence. Hook suppression keeps analyzer events
out of capture, and analysis is never scheduled automatically.

The asynchronous child process is needed to use the installed native CLI and its
existing authentication. No resident worker process or runtime package is added.
Capture queries stay in the existing database worker. This follows Electron's
advice to [defer optional work and keep blocking operations off the UI
thread](https://www.electronjs.org/docs/latest/tutorial/performance) and its
[process responsibilities](https://www.electronjs.org/docs/latest/tutorial/process-model).

| Resource | Limit |
| --- | --- |
| Session ID / model | 1,024 UTF-8 bytes / 128 restricted characters |
| Snapshot query | 128 source records, 64 calls, 100 ms processing deadline |
| Snapshot text | 192 KiB, plus bounded coverage metadata |
| Retained analysis runs | 4 across all sessions |
| Active analysis | 1, with no waiting queue or automatic retry |
| CLI prompt / final result | 256 KiB / 64 KiB |
| CLI stdout / stderr | 512 KiB / 32 KiB |
| Findings | 24, each referencing 1 to 8 captured call IDs |
| Finding fields | ID 80, title 160, detail/suggestion 2,000 characters each |
| Runtime / process CPU | 120 seconds wall clock / 30 seconds CPU |
| CLI process group | 8 processes, 512 MiB summed RSS |
| CLI temporary directory | 16 MiB total, 64 entries |
| Hard per-file size / core dumps | 16 MiB / disabled |
| Resource sampling | Every 500 ms while analysis is running |
| Kept-finding packet / handoff text | 128 KiB / 12,000 characters plus session metadata |

The CPU/file limits are inherited OS limits. Aggregate memory, CPU, process count
and temporary storage are checked by bounded sampling, so short overshoots are
possible. A monitoring failure cancels analysis. Cancellation, timeout and output
limits kill the process group, wait for its pipes to close and remove its private
temporary directory. The private application analysis directory holds at most one
work directory and a small process-group marker. After a crash, the next explicit
analysis removes stale files only after the marked group has exited. An active
group, unrecognized contents or cleanup failure blocks analysis without creating
more work directories. App shutdown also cancels execution. Existing capture limits
remain independent; a failing analysis does not stop capture or navigation.

Run the analyzer measurements after building the app, with other tests and video
recording stopped:

```bash
vp -C electron run build
xvfb-run -a -s '-screen 0 1600x1000x24' vp -C electron exec node scripts/desktop.ts vp exec node scripts/measure-analysis.ts
```

Add `--real` to the final command for one small synthetic session through the
installed Codex CLI using Luna. That run sends synthetic evidence to the configured
provider and requires CLI authentication. It does not fall back to a fixture.
Reports go to ignored `electron/measurements/analysis/`. The synthetic trial covers
idle use, snapshot limits, retained-run eviction, frozen focus during arrivals,
maximum accepted payloads, capture pressure, cancellation and recovery. The
existing `validate:resources` workflow separately checks journal behavior and the
empty-window baseline. The active native CLI phase uses the existing 900 MiB
whole-app peak RSS ceiling for both peak and phase-median RSS. That median includes
the CLI while it is running. Once it exits, the settled viewer must again stay
below the existing 825 MiB median RSS ceiling. The 450 MiB endpoint PSS ceiling
and other resource checks remain unchanged. These are Linux regression ceilings;
RSS sums shared pages across processes and is not private memory.

Use the analyzer tests and these measurement workflows to check the budgets. Include the CLI and its descendants in total application memory
and CPU. Linux evidence cannot establish macOS performance, battery use, sleep
or native lifecycle behavior.
