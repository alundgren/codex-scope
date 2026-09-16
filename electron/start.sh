#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"

if [ ! -x ../node_modules/.bin/vp ]; then
    echo 'Install dependencies from the repository root with: bun install --frozen-lockfile' >&2
    echo 'Then install the Electron runtime with: node_modules/.bin/vp -C electron run setup' >&2
    exit 1
fi

exec ../node_modules/.bin/vp run start "$@"
