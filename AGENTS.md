# Project principles

- Preserve normal agent behavior before capturing data. Observation must not
  alter decisions, inject context, wrap other hooks, or depend on the viewer
  to finish. Capture failure must remain independent of session success.
- Prefer data loss to reduced Mac responsiveness or excessive resource use on
  either machine. Every retained event and pending operation needs a limit.
- Capture is best effort. Report known losses honestly and distinguish them
  from intervals where loss cannot be counted. Never imply complete coverage.
- Do not record offline, retry delivery, or replay missed events after a
  reconnect. This applies to future releases as well as the initial version.
- Preserve complete accepted payloads, including unknown fields. Drop data
  that cannot be accepted safely rather than silently truncating it.
- Observe only the supplied hook input. Do not collect transcripts,
  environment variables, or the output of other hook commands.
- Keep recordings temporary and private. Keep payloads out of logs and
  telemetry, and real captures and machine configuration out of Git.
- Respect existing configuration and hook trust. Installation must be
  explicit, and removal must preserve unrelated or user-edited entries.
- Keep Linux and Electron independently buildable and testable. Share the
  data contract and fixtures, not application internals or dependency trees.
- Keep capture independent of browsing. Filtering or pausing the view must
  not change capture behavior or unexpectedly move the user's current view.
- State what validation actually proves. Synthetic checks do not establish
  real-session compatibility, and Linux checks do not establish Mac behavior.
