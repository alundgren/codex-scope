# Session analyzer concepts

Four conceptual views for one session, shown as separate entry points in this synthetic design reference. The implemented workspace combines them behind shared session, run and call selection; see [Session analysis](../session-analysis.md) for current behavior and limits. All four use the same eight-call inventory-retry example. The HTML includes this guidance and a download button.

| Concept | User task | Main interaction | Tradeoff |
| --- | --- | --- | --- |
| 1. Result ledger | Find the largest returns worth investigating | Rank calls, filter candidates, inspect one call and its proposed narrower query | Fast triage, but output size alone cannot establish waste |
| 2. Search trail | Understand how broad discovery led to repeated reading | Select an ordered call, inspect its scope and preceding evidence | Preserves sequence; a shared path is a clue, not proof of causation |
| 3. Agent routing | See which model received raw results and whether a scout reduced the parent's intake | Select a route, compare raw input with the returned digest, adjust a hypothetical digest size | Strong fit for delegation decisions; requires verified actor and delivery links |
| 4. Workflow review | Turn a suspicious call into one testable workflow change | Review evidence, keep or dismiss a proposal, download the selected experiment | Actionable, but suggestions need human judgment and quality validation |

The selected implementation uses explicit, bounded local Codex analysis with an editable model choice and human review. Changing views does not invoke the model. Agent routing falls back to supplied model groups while actor attribution remains unknown. The standalone concepts below retain their synthetic detection rules and proposed delivery metadata for comparison.

## Interaction contract

Choose a numbered concept in the top navigation. Capture detail switches between hook evidence and proposed delivery metadata. Scenario controls cover retained samples, an unknown coverage gap, missing tool responses, empty history, and an evicted selection. These are mockup controls, not production configuration. The session task and identifier stay fixed. Each concept has its own composition rather than the same dashboard with renamed panels. Use one title and necessary control labels, with no extra UX subheadings.

The ledger supports literal command search, candidate filtering, output-size or time order, and a selected-call inspector. Search trail uses observation order, never implied reasoning or replay. Agent routing distinguishes output observed by a hook from data delivered to an agent. The calculator changes an assumption only. Workflow review stores decisions in page memory and exports a Markdown experiment; it does not change instructions, execute commands, or spawn agents. Reload restores the synthetic example.

## What the hooks can establish

The official [Codex hook reference](https://learn.chatgpt.com/docs/hooks) documents model, session, turn and tool-call identifiers, tool arguments and responses. It documents subagent lifecycle IDs, but subagent hooks share the parent session ID. Hosted tools and some special paths have coverage exceptions. Code-mode nested tool results need not equal what the model receives. Verify fields and call paths against the actual supported client before making compatibility claims.

The current protocol preserves all accepted original JSON, including unknown fields. The collector indexes only hook, session and tool names. The viewer can derive additional fields from accepted payloads without changing the version 1 envelope. Current fixtures are synthetic and do not establish real-session support. See `protocol/README.md`, `linux/src/contract.rs`, `electron/src/database.ts`, and `docs/architecture.md`.

| Diagnostic | First implementation | Information still needed |
| --- | --- | --- |
| Broad searches and missing prefiltering | Inspect supplied command or structured arguments. Detect literal root searches, full-file reads and supported output-limit fields | Tool-specific parsing. Dynamic shell expressions remain unclassified. Broad searches may be justified |
| Large returns | Compute bytes of a supported textual response field and separately retain original hook byte count | Response availability and format validation. JSON serialization size is not textual output size |
| Active model | Extract supplied model per event | Missing values stay unknown. Do not infer from role or current configuration |
| Repeated retrieval | Flag repeated normalized arguments in a bounded retained interval | A repeated query may see changed files. Similar arguments do not establish identical output or wasted work |
| Main agent versus scout | Show model groups today. Use explicit lifecycle and invocation IDs only where verified | Stable originating agent ID and parent ID on each tool event; delivery correlation for the scout report |
| Actual context intake | Display hook response bytes as observed tool output | Codex-side metadata after formatting, truncation, code-mode filtering and hook transformations, with final delivery ID and recipient |
| Tokens and dollars | Keep unavailable values explicit | Tokenizer identity and version for estimates; request-level usage, cached tokens, active model, pricing basis and request attribution for costs |
| Useful versus wasted output | Human-reviewed candidates and an explanation of the rule | Task correctness and a controlled comparison. Hooks cannot tell what information the model used |

## Capture changes to consider

1. First, add bounded worker-side extraction and SQLite indexes for optional model, turn ID, tool-use ID, supported arguments, observed response bytes, and extraction status. Preserve original payload text. Missing fields are null, never zero. A tool's absence is not proof it was not used.
2. Run a real-client compatibility experiment covering direct shell, long-running exec with polling, code-mode nested calls and selective printing, MCP, a subagent, a model change, compaction and capture disconnection. Check actual delivered results against observed hooks without adding transcript collection to the application.
3. If hooks cannot identify the executing agent or final delivery, propose upstream Codex instrumentation that emits those facts in supplied hook input. Include originating agent ID, parent ID, delivery ID, nested-call relationship, final delivered text byte count and truncation state. These are proposed fields, not existing hook fields. Do not wrap tools, rewrite results, inject advice, or read transcripts or environment variables.
4. Current input is limited to 61,440 bytes for the whole hook JSON. Oversized events are dropped whole and global collector drop counts cannot identify the session or original size. This biases a ranking toward smaller accepted results. Prefer a separate, bounded metadata-only event emitted by Codex for a large result, carrying original length and omission reason, without pretending a partial payload is complete. This needs explicit event allowlisting and protocol coordination. Never have the observer read an unbounded response just to count it. Raising the cap requires measurements across both applications and the transport.
5. Request usage metadata would enable a cost model, but cannot establish exact per-call marginal cost without attribution assumptions. Prompt reuse, caching, compaction, output tokens and scout setup all matter. A lower raw-result count at the main model is only one component of savings.

## Metric definitions

The example contains 27,300 hypothetical delivered tokens across eight deliveries. Main receives 22,900 and scout receives 4,400. The first three returns contribute 21,900. All token values are invented to demonstrate a future delivery metric; they are not a bytes-to-tokens conversion or current pricing. Hook mode instead shows synthetic observed response sizes: 44.8, 25.5, 13.0, 1.1, 12.2, 4.6, 1.6 and 1.1 KiB, totaling 103.9 KiB. Each is below the whole-hook admission cap with room for its metadata. These are fixture annotations, not measurements of embedded excerpts.

The scout receives 4,400 tokens and returns a 420-token digest to the main agent. Those are different deliveries. Count the digest once at its receiving agent, never again as a tool result plus a lifecycle message. The sample diagram uses verified links only in proposed mode. Hook mode groups by the supplied synthetic model value and does not infer an agent from it.

The calculator compares sending 4,400 raw tokens to the main agent with sending a hypothetical digest of S tokens. Main intake avoided is 4,400 minus S. It excludes the scout's input, prompt, output, inherited context, latency and later requests. It is not net cost savings. Model names Main model and Budget model are synthetic labels, not product or pricing claims.

A gap, missing response or eviction invalidates full-session conclusions. Show retained coverage and unknown amounts beside totals. Known collector drops remain global, separate from the session. The mockup gap count of two is a synthetic global collector count; session loss remains unknown. Never relabel retained totals as complete session totals. Do not infer retained context size from cumulative deliveries or subtract a guessed amount at compaction.

## Detection and data design

Use per-event evidence with a rule ID and version, source event reference, availability state and a bounded explanation. Candidate means review needed, not waste proven. Begin with narrowly supported command patterns. A literal repository-root rg search can suggest filename discovery or a known directory. cat over multiple files can suggest bounded ranges. Limit flags alone do not prove prefiltering. Avoid automatic shell rewriting; display an authored proposal for review.

Pair pre/post events using session, turn and tool-use IDs plus actor ID when supplied. Do not pair by arrival time. Pending pairs must expire and have a fixed capacity. Keep unpaired post events useful, mark unmatched pre events as response unavailable, and preserve ambiguity. Tool polling, nested calls and parent reports need deduplication keyed to explicit origin and delivery IDs, not content similarity.

Use existing worker/database ownership. Page ranked calls with indexed queries; keep a bounded selected payload and small visible neighborhood in the renderer. Bound extraction, joins, summaries, candidate storage, query duration, copy size and exports. Evict derived rows with source history. Cancel obsolete queries and ignore stale generations. Calculate top results incrementally within a bounded worker budget. Pause analysis under pressure and show Analysis incomplete while capture retains its independent best-effort behavior. The standalone mockup needs no runtime process or model API. The selected implementation adds one bounded, user-requested local Codex CLI analysis process group.

Reuse established application budgets. Measure any additional budgets with idle, sustained and burst capture, largest accepted payloads, rapid search and selection, eviction and storage pressure. Report total Electron process memory, CPU, responsiveness and dropped work. Browser prototype inspection does not establish production Electron integration or macOS behavior.

## Build slices and acceptance

- Begin with a read-only ledger for the selected session, indexed optional fields, observed response bytes and explicit unknown states. Selecting a candidate opens its exact retained hook input and the rule explanation. Unsupported formats do not receive invented counts.
- Add the ordered search trail using the same selected call. Present suggested relationships separately from verified identifiers. New arrivals never move a frozen selection or its payload scroll position.
- Add actor routing only after the compatibility experiment establishes reliable attribution. Fall back to model groups when it does not. No absent-scout accusations across coverage gaps.
- Add human-reviewed experiment export after diagnostics are trustworthy. Keep, dismiss and undo must be visible and reversible. Export only reviewed bounded evidence after an explicit user action; never publish real captures automatically.
- Validate a selected session cannot mix another session's data; missing response and model differ from zero; gap and eviction states preserve truthful totals; cancellation prevents stale results; identical polling and lifecycle records cannot double-count a delivery; all proposal exports state assumptions.
- Run and visually inspect the implemented Electron app on Linux with a recorded walkthrough of all concepts retained for implementation, search/no matches, long text, unknown fields, capture gaps, recovery, eviction and pressure. Keep generated evidence under ignored `.artifacts/visual/`, attach it only to the relevant GitHub PR, and state macOS limitations.
