"""Create a private viewer token without printing its value."""

import argparse
import os
from pathlib import Path
import secrets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        fd = os.open(args.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(secrets.token_hex(32) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    except OSError:
        parser.exit(1, "Could not create token file; existing files are never replaced.\n")
    print("Private token file created.")


if __name__ == "__main__":
    main()
