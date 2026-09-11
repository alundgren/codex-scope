#!/bin/sh
set -eu
command -v python3 >/dev/null 2>&1 || {
    echo 'Python 3.11 or newer is required. Install the python3 package, then retry.' >&2
    exit 1
}
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || {
    echo 'Python 3.11 or newer is required; the installed Python is too old.' >&2
    exit 1
}
cd -- "$(dirname -- "$0")"
exec python3 -B -m scope.setup "$@"
