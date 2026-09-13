# PR inspection

Functions → PR review opens one PR from a github.com URL or `owner/repository #123`. Local `gh` must be installed and authenticated for that repository. Missing CLI, access, network and output failures give a retry path without changing existing evidence. Scope does not check out, build, launch or run the reviewed repository. There is no model call in manual PR browsing.

Each review has a new temporary ID plus repository, PR number, target base OID and head OID. Source references also carry path, side and line. The comparison merge-base OID identifies diff-left source, which can differ from the target branch tip. Fork source uses the head repository, and renamed base source uses the previous filename. Missing fork repositories stay unavailable. Deleted and added files explicitly lack a head or base side respectively.

`gh api` receives argument arrays and a fixed GitHub hostname. PR and changed-file responses have byte caps before JSON parsing. File pages contain at most ten paths. GitHub's files endpoint also returns patches with the page, so those patches enter the bounded main-process page; all-source prefetch does not occur. The renderer receives only path metadata and the currently requested 200 content rows. Main retains one file page plus one selected file and source/diff, with no cache that grows as the review continues. Opening each source side resolves the pinned parent Git Tree through gh GraphQL, accepts only regular blob modes 100644/100755, then reads that exact blob OID through gh. The query requests one tree and its direct entries only, with no recursive tree expansion, a 2 MiB response cap and a 10,000-entry limit. Path input is capped at 1,024 characters. Symlinks, submodules and unavailable parent trees are omitted before source lines are created. Subsequent content pages slice that bounded source. A file-page response is accepted only after the PR's base/head still match the pinned review.

The [GitHub comparison contract](https://docs.github.com/en/rest/commits/commits#compare-two-commits) includes the merge base on paginated responses and files only on the first page. Scope requests page two with one commit per page to resolve the comparison base without loading a comparison-wide file list. The [PR files endpoint](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files) exposes at most 3,000 paths. Any additional paths are counted as omitted in Evidence limits. Absent, oversized or structurally incomplete patches remain unavailable; source-side reads may still work. Accepted source is UTF-8 text only. Binary or oversized content is omitted as a whole.

Refresh checks current PR identity without replacing anything. If it changed, Replace review is explicit and removes old screenshots and selections. Existing evidence never silently acquires new revision identifiers. Opening another PR and ending the review also require an explicit leave action. A failed replacement keeps the previous review. Transcript and editable feedback copy remain available before removal.

PNG screenshots come only from an explicit local picker. Scope checks regular-file status before opening with nonblocking/no-follow flags, checks the opened descriptor again, then checks size and PNG structure before Electron decodes the bounded pixels. The decoded dimensions must match the PNG header before attachment and on subsequent image reads. Animated PNG and other formats are unsupported. The private temporary directory stores four randomly named files at most, with owner-only permissions. A read-only local protocol URL delivers only the selected image, avoiding base64 image copies through IPC. The route accepts only the active PR and known image IDs, permits one read, validates stored bytes again, and disables caching. The renderer labels its supplied filename and pinned revision. Each destination is tracked before writing and counts against the file limit. A failed or cancelled write removes its incomplete file. Failed cleanup keeps that file owned and blocks further attachments until End or restart can clean it. Removing an image, ending/replacing the review or normal quit removes its file. Startup removes bounded abandoned screenshot files; unexpected directory entries stop startup instead of deleting unrelated data. Ordinary deletion is not forensic erasure.

| Resource | Limit and behavior |
| --- | --- |
| Active work | One manual PR operation and one session/guided evidence read, each with a bounded gh process group; overlapping work in either slot is rejected without a retry queue |
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
five lenses, and feedback generation. Explicit feedback generation consumes the same registry. Fixed tool schemas and host
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

Run `vp exec node --experimental-transform-types scripts/probe-review-prompts.ts`
from `electron/` to exercise changed base and lens text
through two turns of one actual installed-CLI thread using synthetic instructions
and an explicit model/effort pair. It requests no source reads or reviewed code
execution and checks temporary cleanup.

## Guided evidence

The session-attached `scope_guide` tool accepts typed view/lens selection, source
focus/highlight, screenshot strokes/arrows/text, and local sequence diagrams.
Source actions require an issued source ID plus its pinned revision, path, side
and line range. Image actions require an attached image ID and pinned head.
Unknown fields, removed evidence, stale revisions, invalid coordinates, unknown
nodes and excessive data receive explicit rejection results. Diagram references
use the same source validation and never fetch remote links.

`review-guidance.ts` validates and retains active-session artifacts. `review-tools.ts`
serializes tool evidence reads with guided source-page reads; concurrent work is
rejected without a queue. Manual PR reads retain their separate existing request
slot. `ui/review.ts` owns follow, focus guards and the navigation generation.
Pausing, cancellation, timeout, manual navigation and tool changes invalidate
pending display work, including messages waiting for artifact retrieval. The
renderer acknowledges a shown target or reports that it was retained. It never
receives an executable action or arbitrary filesystem access.

The host permits one outstanding display acknowledgment for 2,500 ms, then
cancels display and reports an unconfirmed retained target. The renderer keeps
only the latest requested return target. Resume never drains a backlog. End,
replace and quit remove artifacts with their active review. Settings stores no
follow toggle or artifacts. The base review prompt's registered default supplies
the optional guidance instructions; saved overrides remain authoritative for
editable wording and cannot change host validation.

One renderer-owned selected-source reference remains independent of annotations so
removing or clearing marks preserves the current page, selection and pagination.
It changes only when navigation is accepted, and is discarded with the active
review. Each page request revalidates its issued ID, path, side, revision and
line range; cancelled source reads cannot replace the displayed reference.
Annotation rows identify source paths and lines, screenshot marks, diagram
participants, or lens/view targets before Show or Remove is chosen.

| Resource | Limit and behavior |
| --- | --- |
| Guidance input | 8 KiB encoded JSON per action, validated before source reads |
| Retained actions | 24 records; overflow rejected until explicit removal; the existing 64 dynamic-tool-call session limit also bounds additions |
| Source marks | 1–200 lines within accepted pinned UTF-8 source; displayed in 200-line pages with a 32 KiB row-result cap |
| Screenshot marks | 16 marks per action, 128 points per mark, 256 characters per text, 2,048 retained points per image, and the action byte cap; all coordinates inside decoded image dimensions |
| Sequence diagrams | 2–8 nodes, 1–24 messages, 256 characters per label, 1–4 validated source references; no remote links or supplied executable markup |
| Renderer copies | One bounded artifact list and latest target; at most 24 × 8 KiB of agent input per list, plus fixed IDs/validated metadata; main and renderer both count toward app memory |

Source highlights use DOM rows; drawings and diagrams use locally created SVG
elements and plain text. No runtime dependency or additional process is added. These controls retain Electron's [sandbox and context-isolation protections](https://www.electronjs.org/docs/latest/tutorial/security).
Image overlays share the displayed image box and an original-pixel view box.
Long diagram labels use bounded text rows. Rendering never evaluates agent HTML,
JavaScript, SVG strings or diagram URLs.

Run `electron/scripts/measure-review-guidance.ts` from `electron/` under the
standard isolated Xvfb desktop to exercise one near-limit drawing and 23 smaller records on a
4,194,304-pixel PNG, overflow rejection, scaling, paused diagram bursts, long
labels, self messages, 384 maximum-length screenshot text marks, 384 arrows and clear. `--live` includes the installed Codex CLI with an
explicit gpt-6-astra/low selection; the artifact pressure data remains synthetic.
The command records whole-app and child RSS/CPU, timer delay and cleanup without
video. Run `--visual` separately for the matching recorded walkthrough. Results
belong in the PR. Linux evidence does not establish macOS performance or energy
use.

## Editable feedback

Feedback stays in the notebook toolbar, including after a failed review. Its popup
keeps separate author and agent handoff editors. Both drafts survive tool navigation,
closing the popup, generation failure and cancellation. Generation is explicit. An
active turn offers Wait for current turn or Stop turn first, with one cancellable
request and a two-minute deadline. There is no second competing turn or new thread.
A failed or absent agent leaves manual editing and copying available.

The effective registered feedback prompt replaces the lens instruction for that
turn and retains the base prompt. Its version is recorded with the conversation.
The installed CLI's [turn output schema](https://learn.chatgpt.com/docs/app-server)
constrains the final assistant message. Scope validates the returned JSON before
replacing findings. Interrupted, invalid or excessive output preserves prior drafts.
Structured feedback adds no runtime dependency or process.

Findings carry stable model-supplied IDs, area, impact, a one-sentence description,
evidence, reasoning, uncertainty, verification steps, inclusion, hypothesis state,
and an optional suggestion with user or agent attribution. The popup supports
correction, exclusion and removal while keeping each original evidence string
read-only. Working hypotheses never enter generated handoffs. Applying findings
rebuilds the handoffs only after an explicit choice when their text has been edited.
Regeneration also asks before replacing corrected findings. All mutation controls
are disabled during pending generation; Cancel and copying remain available.

Author text starts directly with `- <area>-<impact>: <description>` bullets, or
an honest no-findings message. Agent text includes pinned repository/PR/base/head,
reasoning, uncertainty and concrete checks and asks the author and agent to verify
the work and decide. Optional suggestions appear only when included. Free-form
model evidence and verification claims are not proof that the source supports a
finding or that a check ran. Host validation checks types, IDs and resource limits;
it does not establish the correctness of those claims.

When a finding cites a retained annotation ID, Scope appends its retained metadata.
Diagram details include plain-text messages and pinned file/side/line/revision
references. Image annotations identify the supplied image, dimensions and revision;
image bytes are not copied. Artifact detail overflow is explicitly omitted and asks
for manual references. A removed artifact can no longer be expanded during a later
generation, but already generated text remains editable and copyable.

Copy author, Copy agent and Copy both report actual success or failure. Each copied
snapshot appends its original revision independently of editable text. Unsupported
clipboard control characters are rejected before writing. Editing clears the prior
copied notice; a delayed copy identifies an earlier snapshot when the draft changed. Refresh PR
labels the retained feedback stale without disabling old-revision copy. Preparing
and copying never posts to GitHub. End review and PR replacement open the export
offer with explicit continue-without-copy and Cancel ending controls. Normal OS
close keeps the existing bounded cleanup deadline and does not wait for this offer.

| Resource | Limit and behavior |
| --- | --- |
| Findings | Eight findings, 16 KiB encoded final JSON before parsing; duplicate or malformed IDs and multiline leading descriptions are rejected |
| Finding fields | ID 64, area 48, description 320, evidence 768, reasoning 512, uncertainty 256, verification 512 and suggestion 320 UTF-16 units, within the aggregate byte cap |
| Artifact appendix | At most 8 KiB, including explicit omissions; only annotations referenced by returned findings are considered |
| Drafts | Two editors of 32,768 UTF-16 units each, at most 96 KiB UTF-8 per editable draft; copy accepts at most 32 KiB UTF-8 per section |
| Clipboard | One outstanding operation, at most 68 KiB including revision metadata; 2,500 ms acknowledgment deadline, no retry queue while an operation remains pending |
| Pending generation | One request, two-minute wait/generation deadline; existing turn, transcript, process and temporary-file budgets remain enforced |

Run `scripts/measure-review-feedback.ts` from `electron/` under the documented
fresh Xvfb desktop. It measures actual installed-CLI feedback generation, eight
findings at the JSON cap, both maximum accepted drafts, repeated copy and oversized
multibyte rejection with the same idle CLI child. Whole-app and child memory, CPU,
timer delays and temporary bytes are recorded without video. Synthetic maximum
output does not establish maximum integrated capture/review load or macOS behavior.

## Posting a comment

Post comment opens a separate exact Markdown preview from both handoffs. Changes in
this preview remain independent of the two handoff editors. Copy exact preview
copies those edits, including when delivery failed or the PR changed. Use current
handoffs explicitly replaces the combined preview. The destination and full reviewed
head remain visible. The final Post comment control is the only write trigger;
review tools cannot post. Failed review agents do not disable a prepared current
comment.

The main process reads the current GitHub account and immediately rechecks the
pinned repository, PR, base, fork and head before creating a comment. A changed
identity or revision blocks posting and preserves the draft. Refresh and review
remain explicit. The immutable revision suffix is validated independently of the
editable prose. GitHub cannot atomically condition a top-level comment on its head,
so the posted body records which head was reviewed.

Creation uses local [`gh pr comment --body-file`](https://cli.github.com/manual/gh_pr_comment)
with argument arrays and one private `0600` body file in an owned `0700` directory.
The returned comment URL is validated against the pinned destination, then
[`gh api`](https://cli.github.com/manual/gh_api) reads that issue comment to compare
its exact body, account ID and creation time. Normal completion, End and quit clean
owned temporary data. A later launch removes a recognized abandoned body file;
foreign, linked or excessive storage is rejected without deleting its contents.

Preflight or process-start failure allows an explicit retry. Every other write
failure, timeout, invalid response or failed readback leaves delivery uncertain.
Check GitHub for this comment only reads. It searches at most three pages of twenty
recent comments, retaining at most twenty exact-body/account/time candidates.
GitHub's `since` parameter filters by update time; Scope additionally compares
creation time against the fixed attempt window. One unique match from complete bounded
results confirms delivery only when created during that attempt, allowing for GitHub's
one-second timestamp precision. Matches admitted only by the five-minute clock tolerance
remain candidates for explicit resolution; delayed checking does not move the window.
Multiple matches, incomplete pages, read failures or no
match require the person to inspect GitHub and select a candidate or explicitly
confirm absence before another write. No automatic retry occurs. Ending or replacing
the review stays blocked while a comment operation or unresolved delivery remains;
normal OS quit still follows the existing bounded shutdown deadline.

Success retains the verified link and sent body. Later edits remain an unsent draft.
The host rejects a duplicate in-flight request or the unchanged latest sent body.
GitHub links open only through validated host-owned PR/comment destinations; renderer
navigation and additional Electron windows remain denied. One external-open request
may remain pending, with a 2,500 ms unconfirmed-result deadline and no retry queue.
Clipboard operations share one outstanding slot and native exact-text readback.

The combined posting body and its clipboard snapshot each accept at most 65,536
UTF-8 bytes, including revision text. This is a measured Scope limit, not a claim
about GitHub's undocumented numeric maximum. Oversized edits, unsupported control
characters, invalid Unicode and altered revision suffixes fail before a write.
Posting accepts LF line endings. The renderer holds one editable preview, one sent
body and one initial combined handoff; each editable textarea has a 65,536 UTF-16-unit
limit, with byte validation before copying or posting. Invalid multibyte edits remain
editable. One command runs at a time, with the existing ten-second command deadline,
process budget, 32 KiB discarded diagnostics and a 2 MiB read-response ceiling.
Creation output has a separate 2 KiB URL ceiling. No credentials or body text enter
Scope logs.

`scripts/measure-review-integrated.ts` combines active capture and review with four
4 MiB supplied PNGs, 19,000-line source, 220 synthetic retained conversation entries,
24 artifacts, maximum feedback and posting copies, repeated search and scrubbing,
minimized capture and visible conversation-capacity recovery. Diagnosis is blocked
while review owns the CLI, then becomes available after End. `--live` uses an actual
active installed CLI with synthetic retained pressure data; it does not imply the
model itself produced the maximum transcript or artifacts. `--visual` records the
walkthrough separately and does not collect accepted resource measurements. The
existing allocation, process and storage limits are enforced; combined RSS, CPU and
responsiveness are measured regression checks rather than an aggregate runtime
memory reservation. Results and tested environments belong in the PR.

The integrated script fails above 1,152 MiB summed whole-app RSS, 100 ms main or
renderer timer delay, 140% mean one-core CPU during active workloads, 25% during
minimized capture, or 8% during idle phases. Its 56 MiB temporary-file check includes
the synthetic input PNG and test metadata as well as app-owned recording, images,
CLI files and comment body. These Linux regression ceilings come from the combined
workloads above and do not establish macOS performance or energy behavior. The
64 KiB comment case uses the synthetic gh adapter; actual GitHub validation covers
only the explicitly authorized body reported in the PR.

Notebook viewing accepts original PNGs up to 4 MiB. Agent transfer has a separate
512 KiB original-byte cap, checked against retained metadata before reading or
base64 expansion. Larger images return a visible evidence omission and remain
viewable in the notebook without ending the review thread. Smaller supplied PNGs
retain their exact original bytes. This separate limit leaves protocol space below
the enforced 1 MiB incoming frame ceiling when the installed CLI echoes image data.
The integrated live workload checks source reading, an oversized-image omission,
and the largest supported image transfer in the same thread with capture active.
