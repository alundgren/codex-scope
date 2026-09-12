# Live stream protocol, version 1

This directory is the shared contract for independently developed Linux and
Electron applications. Neither application imports the other's code or
dependencies. Fixtures contain synthetic data only.

The viewer initiates HTTP/1.1 requests to a configured HTTPS endpoint. Linux
binds its HTTP listener to loopback; a private proxy terminates TLS. All
requests require `Authorization: Bearer <token>`. Tokens must never appear in
URLs or logs. The local plaintext endpoint is for same-host tests only.

## Requests

| Request | Result |
| --- | --- |
| `GET /v1/stream` | `200`, `application/x-ndjson`, one JSON message per newline until connection close |
| `POST /v1/heartbeat` with `X-Connection-Id` | `204` renews the current viewer's lease |

Both requests have no body. The server does not accept chunked request bodies.
Each heartbeat uses a separate HTTP connection. Send one every 2 seconds.
Without a valid heartbeat for 6 seconds, the collector closes the stream and
discards queued events. Stop sending heartbeats when the stream closes or the
viewer stops processing incoming data. A heartbeat cannot revive an expired
connection.

A second viewer gets `409`; missing or invalid credentials get `401`.
Heartbeats with a stale or missing connection ID get `409`. Unknown routes
get `404`; malformed requests get `400` or `431`. Under sustained local
ingestion, opening a stream may return `503` to avoid accepting old events.
Connections beyond the server's concurrent HTTP limit may close without a
response. The viewer can reconnect with backoff, but must never request replay.

This is a close-delimited HTTP response, without a Content-Length or transfer
encoding. The private proxy must stream responses without buffering. Clients
must parse incrementally: a network read is not a complete message. Bound the
unfinished line to 393216 bytes and reject a larger frame. Do not let received
events create unbounded pending storage or UI work.

## Messages

`hello` is the first message. It contains `protocol_version: 1`, a new UUID
`connection_id`, `max_payload_bytes: 61440`, `max_frame_bytes: 393216`,
`heartbeat_interval_ms: 2000`, `heartbeat_expiry_ms: 6000`, and
`loss_before_connection: "unknown"`. Reject unsupported protocol versions.

`event` contains:

| Field | Meaning |
| --- | --- |
| `connection_id` | Matches the current hello message |
| `sequence` | Positive safe integer, increases within this connection; gaps are possible |
| `received_at` | Collector UTC receive time; metadata, not a reliable total order |
| `hook_type` | Original `hook_event_name` |
| `session_id` | Original string or null |
| `tool_name` | Original string or null |
| `payload_bytes` | Byte length of original UTF-8 input |
| `git` | Optional object or null: `repo`, `branch` string or null, and `observed_at` UTC timestamp from a successful repository lookup |
| `payload` | String containing the entire original JSON text, including whitespace |

Re-encoding `payload` as UTF-8 recovers the accepted input bytes. Do not replace
it with a reserialized object. Unknown JSON fields remain intact. The
collector accepts UTF-8 JSON objects for explicitly supported hook events,
rejects malformed input and non-finite numbers, and never truncates payloads.
Summary fields are conveniences; full inspection uses the original text.

`git` is collector-derived metadata, not part of the hook input. The collector
runs read-only Git queries using the hook's absolute `cwd`. `repo` is the
repository directory name obtained from Git's common directory, so linked
worktrees use the main repository name. It is not a remote URL. A null branch
means unavailable, including detached HEAD or a failed branch query. Repo and
branch strings are each limited to 512 UTF-8 bytes; larger metadata is omitted.
No original payload bytes are changed or truncated for these labels.

Lookup is asynchronous and event-driven. Results accompany later events from
the same working directory, with the lookup timestamp. The first event may have
no Git metadata, and a quiet session may retain an older branch label. This does
not prove the branch at the event's exact time. There is no metadata replay or
background refresh of idle directories. Old collectors omit the field; old
viewers ignore it. Invalid optional metadata is ignored without dropping an
otherwise valid event. See [Linux lookup limits](../linux/README.md#git-session-labels).

The Mac assigns its own recording IDs, generation, local receive time, and
increasing recording order. It must not use remote timestamps to page history.
Clearing history closes the connection, discards pending local work, and opens
a new recording and connection. Ignore results from previous generations.

`health` arrives approximately once per second, subject to stream write
pressure. It contains `connection_id`, `known_drops`, and
`loss_outside_collector: "unknown"`. `known_drops` has fixed keys:
`no_viewer`, `invalid`, `oversized`, `rate`, `queue`, and `disconnect`.
Counters are process-lifetime totals, saturate at 9007199254740991, and reset
on collector restart. They are not per-session or per-connection counts.
Do not add these totals across reconnects or infer an exact gap count from
their difference. `disconnect` counts discarded queued frames only.

An observer failure, kernel drop, in-flight transport loss, or interval while
the collector was stopped may not be counted. Even a successful socket write
does not prove that the Mac stored an event. Show gaps as potentially losing
an unknown number of events.

Unknown message types or additional fields may be ignored within version 1.
Changes to required fields, transport behavior, or field meaning require
coordination between both applications and a new version when incompatible.

## Local ingestion

Linux-only ingestion uses one Unix datagram per original payload in a private
account-owned directory. This is not a viewer API, and it must never be
proxied. The observer makes one nonblocking send and never waits for an
acknowledgment. No event files or offline queues exist.
