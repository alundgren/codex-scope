#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if [ -x ./codex-scope ] && [ -x ./codex-scope-observer ]; then
    exec ./codex-scope setup "$@"
fi
command -v cargo >/dev/null 2>&1 || {
    echo 'Cargo, the Rust build tool, was not found on PATH. Setup needs it to build the Linux executables.' >&2
    echo 'Install Rust and Cargo from https://rustup.rs, then reopen your terminal and rerun this installer.' >&2
    echo 'If Rust is already installed, make sure ~/.cargo/bin is on PATH. Alternatively, place prebuilt codex-scope and codex-scope-observer beside install.sh.' >&2
    exit 1
}
cargo build --locked --release --manifest-path Cargo.toml --bins
exec ./target/release/codex-scope setup "$@"
