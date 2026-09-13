# PR inspection

Functions → PR review opens one PR from a github.com URL or `owner/repository #123`. Local `gh` must be installed and authenticated for that repository. Missing CLI, access, network and output failures give a retry path without changing existing evidence. Scope does not check out, build, launch or run the reviewed repository. There is no model call in manual PR browsing.

Each review has a new temporary ID plus repository, PR number, target base OID and head OID. Source references also carry path, side and line. The comparison merge-base OID identifies diff-left source, which can differ from the target branch tip. Fork source uses the head repository, and renamed base source uses the previous filename. Missing fork repositories stay unavailable. Deleted and added files explicitly lack a head or base side respectively.

`gh api` receives argument arrays and a fixed GitHub hostname. PR and changed-file responses have byte caps before JSON parsing. File pages contain at most ten paths. GitHub's files endpoint also returns patches with the page, so those patches enter the bounded main-process page; all-source prefetch does not occur. The renderer receives only path metadata and the currently requested 200 content rows. Main retains one file page plus one selected file and source/diff, with no cache that grows as the review continues. Opening each source side resolves the pinned parent Git Tree through gh GraphQL, accepts only regular blob modes 100644/100755, then reads that exact blob OID through gh. The query requests one tree and its direct entries only, with no recursive tree expansion, a 2 MiB response cap and a 10,000-entry limit. Path input is capped at 1,024 characters. Symlinks, submodules and unavailable parent trees are omitted before source lines are created. Subsequent content pages slice that bounded source. A file-page response is accepted only after the PR's base/head still match the pinned review.

The [GitHub comparison contract](https://docs.github.com/en/rest/commits/commits#compare-two-commits) includes the merge base on paginated responses and files only on the first page. Scope requests page two with one commit per page to resolve the comparison base without loading a comparison-wide file list. The [PR files endpoint](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files) exposes at most 3,000 paths. Any additional paths are counted as omitted in Evidence limits. Absent, oversized or structurally incomplete patches remain unavailable; source-side reads may still work. Accepted source is UTF-8 text only. Binary or oversized content is omitted as a whole.

Refresh checks current PR identity without replacing anything. If it changed, Replace review is explicit and removes old screenshots and selections. Existing evidence never silently acquires new revision identifiers. Opening another PR and ending the review also require an explicit leave action. A failed replacement keeps the previous review. Transcript copy is available. Structured feedback copy is not yet available.

PNG screenshots come only from an explicit local picker. Scope checks regular-file status before opening with nonblocking/no-follow flags, checks the opened descriptor again, then checks size, PNG structure and decoded dimensions before Chromium expands pixels. Animated PNG and other formats are unsupported. The private temporary directory stores four randomly named files at most, with owner-only permissions. A read-only local protocol URL delivers only the selected image, avoiding base64 image copies through IPC. The route accepts only the active PR and known image IDs, permits one read, validates stored bytes again, and disables caching. The renderer labels its supplied filename and pinned revision. Each destination is tracked before writing and counts against the file limit. A failed or cancelled write removes its incomplete file. Failed cleanup keeps that file owned and blocks further attachments until End or restart can clean it. Removing an image, ending/replacing the review or normal quit removes its file. Startup removes bounded abandoned screenshot files; unexpected directory entries stop startup instead of deleting unrelated data. Ordinary deletion is not forensic erasure.

| Resource | Limit and behavior |
| --- | --- |
| Active work | One PR operation, one gh process group; overlapping requests rejected, no retry queue |
| gh response | 2 MiB stdout, 32 KiB discarded stderr, 10-second command deadline |
| gh process group | Existing CLI sampler: 512 MiB summed RSS, eight processes, 30 CPU seconds; check every 500 ms, kill on failure |
| Changed-file page | Ten entries; browse up to 3,000 paths; excess path count visible on demand |
| Selected patch | 128 KiB, structurally complete hunks only |
| Source entry lookup | One direct parent tree, no recursive expansion; 2 MiB response and 10,000 entries |
| Selected source | 256 KiB UTF-8, 20,000 lines; larger inputs omitted |
| Renderer | 200 source/diff rows, one selected image, twenty recent scroll/page positions |
| Screenshots | Four PNGs, 4 MiB encoded and 4,194,304 decoded pixels each; at most 16 MiB of app-owned screenshot files |
| PR metadata | 1,024-character title, 65,536-character description within the response cap |
| IPC request | 4,096 serialized characters, one pending request; trusted main-frame sender required |

The limits keep source and screenshot work independent of total PR size and browsing duration. Reproduce their workload with `electron/scripts/measure-review.ts` inside the documented fresh Xvfb/Openbox desktop. It measures a 3,010-path PR manifest, repeated file-page browsing, a 19,000-line accepted source in a 10,000-entry parent directory, maximum screenshot bytes/pixels, cancellation, output pressure and recovery, including gh descendants and temporary screenshot files. Run resource measurement without video; record the UI separately with `test/review.spec.ts`. Linux results do not establish macOS performance, energy use or native lifecycle behavior.

## Temporary conversation

Send starts one installed `codex app-server` process and one ephemeral thread after an explicit review model and effort have been saved in Settings. The notebook keeps this thread across lenses and tool navigation. Each turn receives a snapshot of the effective base and selected lens instructions from `review-prompts.ts`. Saved prompt edits apply to the next submitted turn in the same thread. Model and effort changes affect the next review session. Stop turn interrupts work; a failed session retains its accepted transcript for copy and requires End review before another session. Scope never restarts or resumes a failed thread automatically.

`review-session.ts` owns protocol requests, streamed output and cleanup. `review-tools.ts` issues separate source identifiers for the pinned head and comparison base and serves bounded listing, regular-file reads, literal search and supplied PNG access. The root and root-base listings expose head and base source respectively, including deleted files and original paths before renames. Source tools use the pinned fork or base repository and verify regular Git entry modes before fetching the blob through gh. Source results state pagination and omissions. They do not accept arbitrary filesystem paths, run reviewed code, or write to GitHub. The conversation uses twenty-entry pages and coalesced presentation updates. Earlier keeps the selected page while new output arrives; Latest returns to following.

The CLI gets a private home and working directory, explicit host instructions, read-only sandbox with network disabled, no environment/workspace capability roots, and disabled project hooks, plugins, MCP providers, agents, shell, browser and image-generation capabilities. The private home excludes the account's configuration, prior conversations and installed project instructions. Scope copies only the account's regular authentication file, at most 64 KiB, into private temporary storage with mode 0600. It never prints or sends those bytes through renderer IPC. Original account authentication and configuration stay under CLI ownership.

App-server host skill discovery can still return metadata despite the discovery flag. Before creating a thread Scope reads at most 128 metadata records, disables every discovered name through the supported thread skill configuration and suppresses automatic skill instructions and orchestrator skill tools. It checks metadata before each subsequent turn and refuses newly discovered names. Changing local skill configuration during a review requires ending it and opening a new review. Source and screenshots are tool-result data, separate from host instructions. A model-provided read-only clock helper can remain available. Unexpected host requests, including approval or user-input callbacks, fail visibly without granting permission.

The supported installed-CLI contract is experimental. Scope checks effective configuration, selected model/effort, empty instruction sources, read-only network-disabled sandbox and `ephemeral: true` with no thread path. Unsupported behavior is a setup failure with no weaker fallback. Compatibility needs an actual source/image tool round trip after a CLI change; schema generation alone is insufficient.

The repository owner permits the installed CLI's internal prompt-bearing SQLite logs for temporary PR review sessions. This exception is limited to the private, bounded review-session directory and its cleanup. Scope's own logs and telemetry still exclude source, credentials and conversations. The CLI may create SQLite databases and sidecars even for an ephemeral thread. Ephemeral review has no cross-launch resume record, but does not mean that no bytes reach temporary storage. End review and normal quit terminate the process group and remove that directory. Cleanup is ordinary file removal, with no promise of secure erasure. Failed cleanup blocks safe reuse; startup does not resume the conversation.

Diagnosis retains its separate restricted `codex exec` observation packet and never receives review tools or PR source. The app permits one review CLI or diagnosis at a time. While a review process remains open, diagnosis reports busy and asks the person to end review. Capture remains independent. This conservative shared budget avoids adding a second model process group to capture and Electron memory use.

| Limit | Behavior |
| --- | --- |
| Conversation | 512 KiB accepted text, 256 entries, twenty entries per renderer page; capacity stops the session and keeps accepted copy available |
| User message | 16 KiB UTF-8 before submission |
| Protocol | 1 MiB buffered frame, 8 MiB and 8,192 protocol frames per session, four pending requests, 10-second request deadline, 32 KiB discarded stderr, 8 MiB pending input including supplied PNG encoding |
| Evidence | One active callback, 64 calls and 128 issued source IDs per session; ten directory entries or 200 lines per result, 32 KiB text result; existing source and PNG input limits still apply |
| Process | Existing CLI budget of eight processes, 512 MiB summed RSS and 30 CPU seconds, checked every 500 ms; inherited core dumps disabled and 16 MiB per-file limit |
| Temporary storage | Existing 16 MiB and 64-entry CLI budget includes copied authentication, databases, sidecars and temporary files; screenshots retain their separate 16 MiB budget |
| Time | Two minutes per active turn and one hour per session; capacity ends the process and offers transcript copy |

CLI context-compaction notifications stop the review visibly with transcript copy available. Scope does not claim that shortened model context still contains every prior exchange. CPU and temporary-storage monitoring can stop a long conversation before its text capacity. Monitoring samples do not prevent all transient overshoot. Linux measurements belong in the PR evidence; macOS performance, energy use and native lifecycle remain unverified.

## Review prompts

Settings → Review prompts exposes the complete versioned registry: base review,
five lenses, and feedback generation. Feedback generation output remains deferred;
its eventual invocation must consume this registry. Fixed tool schemas and host
permission instructions remain implementation contracts outside the editor.

The compact selector keeps one draft per registered prompt across navigation.
Save prompt applies only that draft. Cancel restores the current saved value.
Revert to system stages removal of the selected override; Cancel can undo it
before Save prompt. The shipped default and its version remain available beside
the editor. Invalid input and failed saves preserve both the draft and previous
effective value. A delayed save retains exclusive ownership until its result
arrives, with no retry queue.

The worker stores only explicit text overrides and their version identifiers in
private `review-prompts.json`, independently of collector and model preferences.
A prompt save neither changes those preferences nor stops capture. Unmodified
prompts pick up their new shipped default after an application update. Reverting
removes the override entirely. Source, conversation and credentials are never
automatically copied into these preferences. The user chooses the prompt text.

Each accepted prompt is nonempty UTF-8 text of at most 8 KiB, excluding control
characters other than tabs and line endings. The seven-entry registry holds at
most 56 KiB of effective prompt text; editor drafts have the same finite count
and a limit of 8,192 UTF-16 units each, at most 24 KiB of UTF-8 text. Invalid
multibyte drafts remain editable, while Save enforces the 8 KiB byte limit. The private JSON document and its single atomic
replacement file each have a 128 KiB ceiling, including JSON escaping. A save
uses a new UUID for the changed override. Shipped prompts have individual
integer versions, and the registry contract has its own version.

Submission snapshots the base and lens versions and text before asynchronous
session startup. Turn construction rechecks prompt bytes. Only these two prompt
texts enter a normal conversation turn, at most 16 KiB plus the existing 16 KiB
user message. Earlier transcript entries retain their original version metadata;
the app keeps no growing archive of historical prompt text. Editing during a
stream never interrupts it. The notebook identifies saved prompt or lens changes
waiting for the next turn. The thread's fixed permission instructions and host
tool enforcement cannot be changed through prompt settings.

Prompt editing adds no process or runtime dependency. Persistence remains in the
existing worker, while bounded plain text editing remains in the renderer.
`electron/scripts/measure-review-session.ts` includes all seven maximum-sized
overrides and multibyte drafts, repeated draft/cancel operations, capture during streamed review,
private settings file size, whole-app process sampling and input timing. Run it
without video on the documented fresh Xvfb desktop. These measured workloads set
the maintained editing limits; results belong in the PR rather than this guide.

`electron/scripts/probe-review-prompts.ts` exercises changed base and lens text
through two turns of one actual installed-CLI thread using synthetic instructions
and an explicit model/effort pair. It requests no source reads or reviewed code
execution and checks temporary cleanup.
