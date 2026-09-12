#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if [ -x ./codex-scope ] && [ -x ./codex-scope-observer ]; then
    exec ./codex-scope setup "$@"
fi
command -v cargo >/dev/null 2>&1 || {
    echo 'Build the two Linux executables with Rust, or place prebuilt codex-scope and codex-scope-observer beside install.sh.' >&2
    exit 1
}
cargo build --locked --release --manifest-path Cargo.toml --bins
exec ./target/release/codex-scope setup "$@"
