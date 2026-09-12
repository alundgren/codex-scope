#!/bin/sh
# Exercise a uniquely named temporary service using only synthetic input.
set -eu
linux_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary="$linux_dir/target/debug/codex-scope"
observer="$linux_dir/target/debug/codex-scope-observer"
[ -x "$binary" ] && [ -x "$observer" ] || {
    echo 'Run cargo build --manifest-path linux/Cargo.toml --bins first.' >&2
    exit 1
}
fixture_dir=$(mktemp -d /tmp/scope-service-check.XXXXXXXX)
fixture_unit="codex-scope-check-$(basename "$fixture_dir").service"
cleanup() {
    timeout 20 systemctl --user stop "$fixture_unit" >/dev/null 2>&1 || :
    rm -rf -- "$fixture_dir"
}
trap cleanup EXIT HUP INT TERM
chmod 700 "$fixture_dir"
"$binary" token --token-file "$fixture_dir/token"
# The check uses a port selected by the caller so it cannot silently stop an owner.
fixture_port=${1:-49319}
case "$fixture_port" in *[!0-9]*|'') echo 'Choose a numeric unused port.' >&2; exit 1;; esac
endpoint="http://127.0.0.1:$fixture_port"
timeout 20 systemd-run --user --unit="$fixture_unit" --collect --property=UMask=0077 \
    "$binary" collector --runtime-dir "$fixture_dir/run" --token-file "$fixture_dir/token" --port "$fixture_port" >/dev/null
sleep 1
"$binary" viewer --endpoint "$endpoint" --token-file "$fixture_dir/token" --seconds 2 >"$fixture_dir/counts.json" &
viewer_pid=$!
sleep 1
printf '%s' '{"hook_event_name":"PreToolUse","session_id":"synthetic-service-check"}' | "$observer" "$fixture_dir/run/ingest.sock"
wait "$viewer_pid"
# The viewer outputs bounded aggregate counters only.
cat "$fixture_dir/counts.json"
grep -Eq '"events"[[:space:]]*:[[:space:]]*1([,[:space:]]|$)' "$fixture_dir/counts.json"
timeout 20 systemctl --user stop "$fixture_unit"
[ ! -e "$fixture_dir/run/ingest.sock" ]
printf '%s' '{"hook_event_name":"PreToolUse","session_id":"synthetic-service-check"}' | "$observer" "$fixture_dir/run/ingest.sock"
echo 'PASS: temporary systemd service, authenticated delivery, service stop, absent receiver.'
echo 'No account hooks or existing services changed; input was synthetic.'
